// netlify/functions/market-data.js
// Market data using the most reliable free sources for each asset class.
// Finnhub (for stocks/ETFs) and CoinGecko (for BTC). Caches to /tmp.
const fs = require("fs");
const https = require("https");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const REQ_TIMEOUT = 8000;

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

/* ===== Symbols ===== */
const INDICES = [
  { t: "^NYA",  name: "NYSE Composite" }, // NYSE - but this might not work, try NYA or use SPY for S&P 500
  { t: "SPY",   name: "S&P 500" },
  { t: "QQQ",   name: "Nasdaq" },
];

const MACRO = [
  { t: "BTCUSD", name: "Bitcoin" },
  { t: "GOLD_SPOT", name: "Gold" }, // We'll get this from a different API
  { t: "^TNX",   name: "10-Yr Bond" }, // 10-year Treasury yield
];

const GROUPS = {
  ai:     ["NVDA","MSFT","GOOGL","AMZN","META","TSLA","AVGO","AMD","SMCI","PLTR"],
  crypto: ["COIN","MSTR","MARA","RIOT","CLSK"],
  energy: ["XOM","CVX","SLB","OXY","COP"],
};

/* ===== Utils ===== */
const toNum = v => (Number.isFinite(+v) ? +v : null);
const readCache = () => { try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE,"utf8")) : null; } catch { return null; } };
const writeCache = payload => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), payload })); } catch {} };
const toMap = arr => { const m=new Map(); (arr||[]).forEach(x=>x?.ticker&&m.set(x.ticker,x)); return m; };

// Get TOP MOVER (highest absolute percentage change) from each sector
function getTopMover(universe, map) {
  let topMover = null;
  let maxAbsChange = 0;
  
  for(const ticker of universe) {
    const quote = map.get(ticker);
    if(quote && Number.isFinite(quote.dp)) {
      const absChange = Math.abs(quote.dp);
      if(absChange > maxAbsChange) {
        maxAbsChange = absChange;
        topMover = {ticker, c: quote.c, d: quote.d, dp: quote.dp};
      }
    }
  }
  
  return topMover ? [topMover] : [];
}

function httpsGet(url, tag="request"){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=https.request({
      method:"GET", hostname:u.hostname, path:u.pathname+(u.search||""),
      headers:{ "Accept":"application/json", "User-Agent":"cerfreport/1.0" }, timeout: REQ_TIMEOUT
    },res=>{
      const chunks=[]; res.on("data",d=>chunks.push(d));
      res.on("end",()=>{
        const body=Buffer.concat(chunks).toString("utf8");
        if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`${tag} HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch(e){ reject(new Error(`${tag} JSON parse error: ${e.message}`)); }
      });
    });
    req.on("error",e=>reject(new Error(`${tag} ${e.message}`)));
    req.on("timeout",()=>req.destroy(new Error(`${tag} timeout ${REQ_TIMEOUT}ms`)));
    req.end();
  });
}

/* ===== Providers ===== */
async function finnhubQuote(symbol) {
  if (!FINNHUB_KEY) throw new Error("Missing FINNHUB_API_KEY");
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
  const data = await httpsGet(url, `finnhub:${symbol}`);
  return { ticker: symbol, name: symbol, c: toNum(data.c), d: toNum(data.d), dp: toNum(data.dp) };
}

async function batchFinnhub(symbols) {
  const out = [];
  for (const s of symbols) {
    try {
      out.push(await finnhubQuote(s));
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.warn("finnhub fail", s, e.message);
    }
  }
  return out;
}

async function coingeckoBTC(){
  const url="https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
  const data=await httpsGet(url,"coingecko:btc");
  const price=toNum(data?.bitcoin?.usd);
  const pct=toNum(data?.bitcoin?.usd_24h_change);
  return { ticker:"BTCUSD", name:"Bitcoin", c:price, d: (price!=null&&pct!=null? price*(pct/100):null), dp:pct };
}

// Get spot gold price from CoinGecko (they have gold data)
async function getGoldSpotPrice(){
  try {
    const url="https://api.coingecko.com/api/v3/simple/price?ids=gold&vs_currencies=usd&include_24hr_change=true";
    const data=await httpsGet(url,"coingecko:gold");
    const price=toNum(data?.gold?.usd);
    const pct=toNum(data?.gold?.usd_24h_change);
    return { ticker:"GOLD_SPOT", name:"Gold", c:price, d: (price!=null&&pct!=null? price*(pct/100):null), dp:pct };
  } catch (e) {
    console.warn("Gold spot price failed:", e.message);
    return null;
  }
}

/* ===== Handler ===== */
exports.handler = async function() {
  try {
    const cached = readCache();
    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    const allFinnhubSymbols = [
        ...INDICES.map(x => x.t),
        "^TNX", // 10-year Treasury yield
        ...Object.values(GROUPS).flat()
    ];

    const [btc, goldSpot, finnhubResults] = await Promise.all([
      coingeckoBTC().catch(e => (console.error("BTC fetch failed:", e.message), null)),
      getGoldSpotPrice().catch(e => (console.error("Gold fetch failed:", e.message), null)),
      batchFinnhub(allFinnhubSymbols),
    ]);
    
    const qMap = toMap(finnhubResults);

    const indices = INDICES.map(x => {
        const q = qMap.get(x.t);
        return q ? { ...q, name: x.name } : null;
    }).filter(Boolean);

    const tnx = qMap.get("^TNX");
    const macro = [
      btc, 
      goldSpot, // Spot gold price
      tnx && { ...tnx, name: "10-Yr Bond" } // Treasury yield as percentage
    ].filter(Boolean);

    // Get only the TOP MOVER from each sector
    const ai = getTopMover(GROUPS.ai, qMap);
    const crypto = getTopMover(GROUPS.crypto, qMap);
    const energy = getTopMover(GROUPS.energy, qMap);

    const payload = { 
      status:"ok", 
      data:{ 
        macro, 
        indices, 
        ai, 
        crypto, 
        energy, 
        movers:{ ai, crypto, energy } 
      } 
    };
    
    writeCache(payload);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    console.error("market-data fatal:", e.message);
    const cached = readCache();
    if (cached?.payload) return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    const payload = { status:"ok", data:{ macro:[], indices:[], ai:[], crypto:[], energy:[], movers:{ ai:[], crypto:[], energy:[] } }, note:`fatal:${e.message}` };
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  }
};
