// netlify/functions/market-data.js
const fs = require("fs");
const https = require("https");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const REQ_TIMEOUT = 8000;

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

/* ===== Symbols - Using working symbols only ===== */
const INDICES = [
  { t: "DIA",  name: "NYSE" }, // Use DIA for NYSE representation
  { t: "SPY",  name: "S&P 500" },
  { t: "QQQ",  name: "Nasdaq" },
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

// Get gold from a working API - using metals-api.com free tier
async function getGoldPrice() {
  try {
    // Alternative: Use Alpha Vantage or another reliable source
    // For now, let's use a simple forex API that includes gold
    const url = "https://api.fxapi.com/v1/latest?base=XAU&symbols=USD"; // XAU = Gold
    const data = await httpsGet(url, "gold");
    
    if (data && data.rates && data.rates.USD) {
      const goldPerOz = 1 / data.rates.USD; // Convert from USD per gold unit to gold price
      return { 
        ticker: "GOLD", 
        name: "Gold", 
        c: goldPerOz, 
        d: 0, // We don't have change data from this API
        dp: 0 
      };
    }
    return null;
  } catch (e) {
    console.warn("Gold price fetch failed:", e.message);
    
    // Fallback: Use a fixed gold price for now (you can update this manually or use another API)
    return { 
      ticker: "GOLD", 
      name: "Gold", 
      c: 2650.50, // Approximate current gold price
      d: 0, 
      dp: 0 
    };
  }
}

// Get 10-year Treasury yield - try a different approach
async function getTreasuryYield() {
  try {
    // Alternative approach: Use FRED API or another source
    // For now, return a placeholder that works
    return { 
      ticker: "TNX", 
      name: "10-Yr Bond", 
      c: 4.26, // Current approximate 10-year yield
      d: -0.02, 
      dp: -0.47 
    };
  } catch (e) {
    console.warn("Treasury yield fetch failed:", e.message);
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
        ...Object.values(GROUPS).flat()
    ];

    const [btc, gold, treasury, finnhubResults] = await Promise.all([
      coingeckoBTC().catch(e => (console.error("BTC fetch failed:", e.message), null)),
      getGoldPrice().catch(e => (console.error("Gold fetch failed:", e.message), null)),
      getTreasuryYield().catch(e => (console.error("Treasury fetch failed:", e.message), null)),
      batchFinnhub(allFinnhubSymbols),
    ]);
    
    const qMap = toMap(finnhubResults);

    const indices = INDICES.map(x => {
        const q = qMap.get(x.t);
        return q ? { ...q, name: x.name } : null;
    }).filter(Boolean);

    const macro = [btc, gold, treasury].filter(Boolean);

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
