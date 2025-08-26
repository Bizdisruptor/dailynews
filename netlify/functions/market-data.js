// netlify/functions/market-data.js
// Market data using Finnhub, CoinGecko, and Yahoo Finance for gold.
const fs = require("fs");
const https = require("https");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const REQ_TIMEOUT = 8000;

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

/* ===== Symbols ===== */
const INDICES = [
  { t: "DIA",  name: "Dow Jones" },
  { t: "SPY",  name: "S&P 500" },
  { t: "QQQ",  name: "Nasdaq 100" },
];

const MACRO = [
  { t: "BTCUSD", name: "Bitcoin" },
  { t: "GC=F",   name: "Gold (Spot)" }, // Using Yahoo Finance for Gold
  { t: "IEF",    name: "US Treasuries 7-10Y" },
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
function topMovers(universe, map, n=10){
  const rows=[]; for(const t of universe){ const q=map.get(t); if(q && Number.isFinite(q.dp)) rows.push({ticker:t,c:q.c,d:q.d,dp:q.dp}); }
  rows.sort((a,b)=>Math.abs(b.dp)-Math.abs(a.dp)); return rows.slice(0,n);
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

// ✅ FIX: Using Yahoo Finance for Gold
async function yahooGold() {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=GC%3DF`;
    const data = await httpsGet(url, "yahoo:gold");
    const result = data?.quoteResponse?.result?.[0];
    if (!result) throw new Error("Yahoo Gold fetch failed");
    return {
        ticker: "GC=F",
        name: "Gold (Spot)",
        c: toNum(result.regularMarketPrice),
        d: toNum(result.regularMarketChange),
        dp: toNum(result.regularMarketChangePercent),
    };
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
        ...MACRO.filter(x => x.t !== 'BTCUSD' && x.t !== 'GC=F').map(x => x.t), // IEF
        ...Object.values(GROUPS).flat()
    ];

    const [btc, gold, finnhubResults] = await Promise.all([
      coingeckoBTC().catch(e => (console.error("BTC fetch failed:", e.message), null)),
      yahooGold().catch(e => (console.error("Gold fetch failed:", e.message), null)),
      batchFinnhub(allFinnhubSymbols),
    ]);
    
    const qMap = toMap(finnhubResults);

    const indices = INDICES.map(x => {
        const q = qMap.get(x.t);
        return q ? { ...q, name: x.name } : null;
    }).filter(Boolean);

    const ief = qMap.get("IEF");
    const macro = [btc, gold, ief && { ...ief, name: "US Treasuries 7-10Y" }].filter(Boolean);

    const ai     = topMovers(GROUPS.ai, qMap, 10);
    const crypto = topMovers(GROUPS.crypto, qMap, 10);
    const energy = topMovers(GROUPS.energy, qMap, 10);

    const payload = { status:"ok", data:{ macro, indices, ai, crypto, energy, movers:{ ai, crypto, energy } } };
    
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
