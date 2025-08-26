// netlify/functions/market-data.js
// Market data: Yahoo (indices + spot gold), CoinGecko (BTC), Finnhub (equities/ETFs)
// with /tmp cache, timeouts, and graceful fallbacks. No node-fetch needed.

const fs = require("fs");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const REQ_TIMEOUT = 8000;

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

/* ===== Symbols ===== */
// Real indices via Yahoo; ETF fallbacks if Yahoo fails:
const INDICES_REAL = [
  { t: "^DJI",  name: "Dow Jones" },
  { t: "^GSPC", name: "S&P 500" },
  { t: "^IXIC", name: "Nasdaq" }, // use ^NDX for Nasdaq-100 if preferred
];
const INDICES_FALLBACK_ETF = [
  { t: "DIA",  name: "Dow Jones (DIA)" },
  { t: "SPY",  name: "S&P 500 (SPY)" },
  { t: "QQQ",  name: "Nasdaq 100 (QQQ)" },
];

// Macro: BTC (CoinGecko), spot gold via Yahoo; IEF via Finnhub
const MACRO = [
  { t: "BTCUSD",   name: "Bitcoin" },          // CoinGecko
  { t: "XAUUSD=X", name: "Gold (Spot)" },      // Yahoo
  { t: "IEF",      name: "US Treasuries 7–10Y (IEF)" }, // ETF proxy
];

// Movers via Finnhub
const GROUPS = {
  ai:     ["NVDA","MSFT","GOOGL","AMZN","META","TSLA","AVGO","AMD","SMCI","PLTR","ASML","MU","TSM"],
  crypto: ["COIN","MSTR","MARA","RIOT","CLSK","HUT","BITF","IREN","CIFR","WULF"],
  energy: ["XOM","CVX","SLB","OXY","COP","DVN","EOG","PXD","HAL","MRO","APA"],
};

/* ===== Utils ===== */
function toNum(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function withTimeout(promise, ms, tag) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${tag || "request"} timeout ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(id); resolve(v); })
           .catch(e => { clearTimeout(id); reject(e); });
  });
}
async function fetchJson(url, headers, tag="request") {
  const r = await withTimeout(fetch(url, { headers, redirect:"follow" }), REQ_TIMEOUT, tag);
  if (!r.ok) throw new Error(`${tag} HTTP ${r.status}`);
  return r.json();
}

/* ===== Cache ===== */
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}
function writeCache(payload) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), payload }));
  } catch {}
}

/* ===== Providers ===== */
// Finnhub (equities/ETFs)
async function finnhubQuote(symbol) {
  if (!FINNHUB_KEY) throw new Error("Missing FINNHUB_API_KEY");
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
  const data = await fetchJson(url, { "Accept": "application/json" }, `finnhub:${symbol}`);
  return { ticker: symbol, name: symbol, c: toNum(data.c), d: toNum(data.d), dp: toNum(data.dp) };
}
async function batchFinnhub(symbols) {
  const out = [];
  for (const s of symbols) {
    try {
      out.push(await finnhubQuote(s));
      await new Promise(r => setTimeout(r, 120)); // free-tier friendly
    } catch (e) {
      console.warn("finnhub fail", s, e.message);
    }
  }
  return out;
}

// Yahoo Finance (indices + spot gold)
async function yahooBatch(symbols) {
  if (!symbols.length) return [];
  const list = symbols.map(s => encodeURIComponent(s)).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${list}`;
  const data = await fetchJson(url, { "Accept": "application/json", "User-Agent": "cerfreport/1.0" }, "yahoo:batch");
  const results = data?.quoteResponse?.result || [];
  return results.map(r => ({
    ticker: r.symbol,
    name: r.shortName || r.longName || r.symbol,
    c: toNum(r.regularMarketPrice),
    d: toNum(r.regularMarketChange),
    dp: toNum(r.regularMarketChangePercent)
  }));
}

// CoinGecko BTC
async function coingeckoBTC() {
  const data = await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
    { "Accept": "application/json" },
    "coingecko:btc"
  );
  const price = toNum(data?.bitcoin?.usd);
  const changePct = toNum(data?.bitcoin?.usd_24h_change);
  const changeAbs = price != null && changePct != null ? price * (changePct / 100) : null;
  return { ticker: "BTCUSD", name: "Bitcoin", c: price, d: changeAbs, dp: changePct };
}

/* ===== Shaping ===== */
function applyNames(quotes, namesMap) {
  return quotes.map(q => ({ ...q, name: namesMap[q.ticker] || q.name || q.ticker }));
}
function toMap(arr) {
  const m = new Map();
  (arr||[]).forEach(x => x?.ticker && m.set(x.ticker, x));
  return m;
}
function topMoversFromUniverse(universe, map, count=10) {
  const rows = [];
  for (const t of universe) {
    const q = map.get(t);
    if (q && Number.isFinite(q.dp)) rows.push({ ticker: t, c: q.c, d: q.d, dp: q.dp });
  }
  rows.sort((a,b) => Math.abs(b.dp) - Math.abs(a.dp));
  return rows.slice(0, count);
}
function shapeResponse({ macro, indices, ai, crypto, energy }) {
  return {
    status: "ok",
    data: { macro, indices, ai, crypto, energy, movers: { ai, crypto, energy } }
  };
}

/* ===== Handler ===== */
exports.handler = async function() {
  try {
    const cached = readCache();
    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    // Name maps
    const indexNames = Object.fromEntries(INDICES_REAL.map(x => [x.t, x.name]));
    const macroNames = Object.fromEntries(MACRO.map(x => [x.t, x.name]));

    // Parallel fetches
    const btcP   = coingeckoBTC();
    const yP     = yahooBatch(["XAUUSD=X", ...INDICES_REAL.map(x => x.t)]);
    const iefP   = batchFinnhub(["IEF"]);
    const aiP    = batchFinnhub(GROUPS.ai);
    const cP     = batchFinnhub(GROUPS.crypto);
    const eP     = batchFinnhub(GROUPS.energy);

    let [btc, yRes, iefOnly, aiRaw, cryptoRaw, energyRaw] = await Promise.all([btcP, yP, iefP, aiP, cP, eP]);

    // If Yahoo returned nothing (firewall/edge hiccup), fall back to ETF indices
    if (!yRes || yRes.length < 2) {
      console.warn("yahoo empty, falling back to ETF indices");
      const idxFallback = await batchFinnhub(INDICES_FALLBACK_ETF.map(x => x.t));
      const indices = applyNames(idxFallback, Object.fromEntries(INDICES_FALLBACK_ETF.map(x => [x.t, x.name])));
      const macro = applyNames([btc, ...iefOnly].filter(Boolean), macroNames); // no spot gold available in fallback
      const allForMap = [...indices, ...macro, ...aiRaw, ...cryptoRaw, ...energyRaw];
      const qMap = toMap(allForMap);
      const ai = topMoversFromUniverse(GROUPS.ai, qMap, 10);
      const crypto = topMoversFromUniverse(GROUPS.crypto, qMap, 10);
      const energy = topMoversFromUniverse(GROUPS.energy, qMap, 10);
      const payload = shapeResponse({ macro, indices, ai, crypto, energy });
      writeCache(payload);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
    }

    // Split Yahoo: indices + gold
    const yMap = toMap(yRes);
    const gold = yMap.get("XAUUSD=X");
    const indicesRaw = INDICES_REAL
      .map(x => yMap.get(x.t))
      .filter(Boolean)
      .map(q => ({ ...q, name: indexNames[q.ticker] || q.name }));

    // Macro group
    const macro = applyNames([btc, gold, ...iefOnly].filter(Boolean), macroNames);

    const allForMap = [...indicesRaw, ...macro, ...aiRaw, ...cryptoRaw, ...energyRaw];
    const qMap = toMap(allForMap);
    const ai     = topMoversFromUniverse(GROUPS.ai, qMap, 10);
    const crypto = topMoversFromUniverse(GROUPS.crypto, qMap, 10);
    const energy = topMoversFromUniverse(GROUPS.energy, qMap, 10);

    const payload = shapeResponse({ macro, indices: indicesRaw, ai, crypto, energy });
    writeCache(payload);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    console.error("market-data error:", e.message);
    const cached = readCache();
    if (cached?.payload) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: e.message }) };
  }
};
