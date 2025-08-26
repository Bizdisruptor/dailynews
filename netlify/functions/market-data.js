// netlify/functions/market-data.js
// Market data via Yahoo Finance (no API key) + CoinGecko (BTC).
// Tries real indices + spot gold; if empty, falls back to ETFs.
// Adds debug mode (?debug=1). Caches to /tmp. Works on any Node (uses https).

const fs = require("fs");
const https = require("https");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const REQ_TIMEOUT = 8000;

/* ===== Symbols ===== */
const INDICES_REAL = [
  { t: "^DJI",  name: "Dow Jones" },
  { t: "^GSPC", name: "S&P 500" },
  { t: "^IXIC", name: "Nasdaq" }, // swap to ^NDX for Nasdaq-100 if you prefer
];
const INDICES_ETF_FALLBACK = [
  { t: "DIA", name: "Dow Jones (DIA)" },
  { t: "SPY", name: "S&P 500 (SPY)" },
  { t: "QQQ", name: "Nasdaq 100 (QQQ)" },
];

const MACRO_REAL = [
  { t: "BTCUSD",   name: "Bitcoin" },       // CoinGecko
  { t: "XAUUSD=X", name: "Gold (Spot)" },   // Yahoo
  { t: "IEF",      name: "US Treasuries 7–10Y (IEF)" }, // Yahoo (ETF proxy)
];
const MACRO_ETF_FALLBACK = [
  { t: "BTCUSD", name: "Bitcoin" },
  { t: "GLD",    name: "Gold (GLD proxy)" },
  { t: "IEF",    name: "US Treasuries 7–10Y (IEF)" },
];

// Movers universes (quoted via Yahoo)
const GROUPS = {
  ai:     ["NVDA","MSFT","GOOGL","AMZN","META","TSLA","AVGO","AMD","SMCI","PLTR","ASML","MU","TSM"],
  crypto: ["COIN","MSTR","MARA","RIOT","CLSK","HUT","BITF","IREN","CIFR","WULF"],
  energy: ["XOM","CVX","SLB","OXY","COP","DVN","EOG","PXD","HAL","MRO","APA"],
};

/* ===== Small helpers ===== */
const toNum = v => (Number.isFinite(+v) ? +v : null);
const readCache = () => { try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : null; } catch { return null; } };
const writeCache = payload => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), payload })); } catch {} };
const toMap = arr => { const m = new Map(); (arr||[]).forEach(x => x?.ticker && m.set(x.ticker, x)); return m; };
function topMovers(universe, map, n=10){
  const rows=[]; for(const t of universe){ const q=map.get(t); if(q && Number.isFinite(q.dp)) rows.push({ticker:t,c:q.c,d:q.d,dp:q.dp}); }
  rows.sort((a,b)=>Math.abs(b.dp)-Math.abs(a.dp)); return rows.slice(0,n);
}

/* ===== HTTPS JSON (no fetch) ===== */
function httpsGet(url, tag="request"){
  return new Promise((resolve,reject)=>{
    const u = new URL(url);
    const req = https.request({
      method:"GET", hostname:u.hostname, path:u.pathname+(u.search||""),
      headers:{ "Accept":"application/json", "User-Agent":"cerfreport/1.0" }, timeout: REQ_TIMEOUT
    }, res=>{
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
async function yahooBatch(symbols, tag="yahoo:batch"){
  if(!symbols.length) return [];
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(",")}`;
  const data = await httpsGet(url, tag);
  const results = data?.quoteResponse?.result || [];
  return results.map(r=>({
    ticker: r.symbol,
    name: r.shortName || r.longName || r.symbol,
    c: toNum(r.regularMarketPrice),
    d: toNum(r.regularMarketChange),
    dp: toNum(r.regularMarketChangePercent),
  }));
}

async function coingeckoBTC(){
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
  const data = await httpsGet(url, "coingecko:btc");
  const price = toNum(data?.bitcoin?.usd);
  const pct   = toNum(data?.bitcoin?.usd_24h_change);
  return { ticker:"BTCUSD", name:"Bitcoin", c:price, d: (price!=null&&pct!=null? price*(pct/100):null), dp:pct };
}

/* ===== Handler ===== */
exports.handler = async function(event){
  const DEBUG = (event?.queryStringParameters?.debug === "1");
  const notes = [];

  try {
    // serve fresh cache
    const cached = readCache();
    if (!DEBUG && cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    // 1) Try REAL indices + spot gold
    let [btc, yAll] = await Promise.all([
      coingeckoBTC().catch(e => (notes.push(`btc:${e.message}`), null)),
      yahooBatch(["XAUUSD=X","IEF", ...INDICES_REAL.map(x=>x.t)]).catch(e => (notes.push(`yahoo-real:${e.message}`), [])),
    ]);

    // Movers
    const [aiRaw, cryptoRaw, energyRaw] = await Promise.all([
      yahooBatch(GROUPS.ai, "yahoo:ai").catch(e => (notes.push(`ai:${e.message}`), [])),
      yahooBatch(GROUPS.crypto, "yahoo:crypto").catch(e => (notes.push(`crypto:${e.message}`), [])),
      yahooBatch(GROUPS.energy, "yahoo:energy").catch(e => (notes.push(`energy:${e.message}`), [])),
    ]);

    let indices=[], macro=[];
    const yMap = toMap(yAll);

    // Build indices/macro from REAL quotes we got
    indices = INDICES_REAL.map(x => {
      const q = yMap.get(x.t);
      return q ? { ...q, name: x.name } : null;
    }).filter(Boolean);

    const gold = yMap.get("XAUUSD=X");
    const ief  = yMap.get("IEF");
    macro = [btc, gold && { ...gold, name:"Gold (Spot)" }, ief && { ...ief, name:"US Treasuries 7–10Y (IEF)" }].filter(Boolean);

    // 2) If either indices or gold missing, FALL BACK to ETFs (DIA/SPY/QQQ + GLD/IEF)
    if (indices.length < 2 || !gold) {
      notes.push("fallback: using ETF quotes");
      const yEtf = await yahooBatch(["GLD","IEF", ...INDICES_ETF_FALLBACK.map(x=>x.t)]).catch(e => (notes.push(`yahoo-etf:${e.message}`), []));
      const eMap = toMap(yEtf);

      indices = INDICES_ETF_FALLBACK.map(x => {
        const q = eMap.get(x.t);
        return q ? { ...q, name: x.name } : null;
      }).filter(Boolean);

      const gld = eMap.get("GLD");
      const ief2 = eMap.get("IEF");
      macro = [btc, gld && { ...gld, name:"Gold (GLD proxy)" }, ief2 && { ...ief2, name:"US Treasuries 7–10Y (IEF)" }].filter(Boolean);
    }

    // Movers (build from whatever we successfully fetched)
    const allForMap = [...indices, ...macro, ...aiRaw, ...cryptoRaw, ...energyRaw];
    const qMap = toMap(allForMap);
    const ai     = topMovers(GROUPS.ai, qMap, 10);
    const crypto = topMovers(GROUPS.crypto, qMap, 10);
    const energy = topMovers(GROUPS.energy, qMap, 10);

    const payload = { status:"ok", data:{ macro, indices, ai, crypto, energy, movers:{ ai, crypto, energy } }, note: notes.join("; ") };
    // cache unless debug
    if (!DEBUG) writeCache(payload);

    // In debug mode, include a hint so you can see issues in the browser
    if (DEBUG) payload.debug = true;

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    console.error("market-data fatal:", e.message);
    const cached = readCache();
    if (cached?.payload) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    const payload = { status:"ok", data:{ macro:[], indices:[], ai:[], crypto:[], energy:[], movers:{ ai:[], crypto:[], energy:[] } }, note:`fatal:${e.message}` };
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  }
};
