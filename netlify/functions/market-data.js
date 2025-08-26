// netlify/functions/market-data.js
// Market data: Yahoo (indices + spot gold), CoinGecko (BTC), Finnhub (equities/ETFs)
// with /tmp cache and graceful fallbacks.

const fetch = require("node-fetch");
const fs = require("fs");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // cache fresh for 3 minutes
const REQ_TIMEOUT = 8000;     // per-request timeout (ms)

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

/* ================= Symbols ================= */
// Indices row (REAL indices from Yahoo, not ETFs)
const INDICES = [
  { t: "^DJI",  name: "Dow Jones" },
  { t: "^GSPC", name: "S&P 500" },
  { t: "^IXIC", name: "Nasdaq" },       // use ^NDX if you prefer Nasdaq-100
];

// Macro row: BTC (CoinGecko), Gold spot (Yahoo), Treasuries proxy via ETF (Finnhub)
const MACRO = [
  { t: "BTCUSD",    name: "Bitcoin" },          // CoinGecko
  { t: "XAUUSD=X",  name: "Gold (Spot)" },      // Yahoo Finance symbol for spot XAUUSD
  { t: "IEF",       name: "US Treasuries 7–10Y (IEF)" }, // Finnhub (ETF proxy)
];

// Movers universes (Finnhub)
const GROUPS = {
  ai:     ["NVDA","MSFT","GOOGL","AMZN","META","TSLA","AVGO","AMD","SMCI","PLTR","ASML","MU","TSM"],
  crypto: ["COIN","MSTR","MARA","RIOT","CLSK","HUT","BITF","IREN","CIFR","WULF"],
  energy: ["XOM","CVX","SLB","OXY","COP","DVN","EOG","PXD","HAL","MRO","APA"],
};

/* ================= Utils ================= */
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

/* ================= Cache ================= */
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

/* ================= Providers ================= */
// Finnhub for equities/ETFs (used by IEF + movers)
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
      await new Promise(r => setTimeout(r, 120)); // gentle pacing (free tier)
    } catch {
      // skip this symbol, continue
    }
  }
  return out;
}

// Yahoo Finance for indices + spot gold (no key)
async function yahooBatch(symbols) {
  if (!symbols.length) return [];
  const list = symbols.map(s => encodeURIComponent(s)).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${list}`;
  const data = await fetchJson(url, { "Accept": "application/json" }, "yahoo:batch");
  const results = data?.quoteResponse?.result || [];
  return results.map(r => ({
    ticker: r.symbol,
    name: r.shortName || r.longName || r.symbol,
    c: toNum(r.regularMarketPrice),
    d: toNum(r.regularMarketChange),
    dp: toNum(r.regularMarketChangePercent)
  }));
}

// CoinGecko for BTC (no key)
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

/* ================= Shaping ================= */
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

/* ================= Handler ================= */
exports.handler = async function() {
  try {
    // serve fresh cache if valid
    const cached = readCache();
    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    // Prepare name maps
    const indexNames = Object.fromEntries(INDICES.map(x => [x.t, x.name]));
    const macroNames = Object.fromEntries(MACRO.map(x => [x.t, x.name]));

    // Parallel fetches
    const btcP      = coingeckoBTC();
    const yahooP    = yahooBatch(
      [ "XAUUSD=X", ...INDICES.map(x => x.t) ] // spot gold + real indices via Yahoo
    );
    const finnhubMacroP = batchFinnhub([ "IEF" ]); // only IEF from Finnhub now

    const aiP      = batchFinnhub(GROUPS.ai);
    const cryptoP  = batchFinnhub(GROUPS.crypto);
    const energyP  = batchFinnhub(GROUPS.energy);

    const [btc, yBatch, iEFonly, aiRaw, cryptoRaw, energyRaw] = await Promise.all([
      btcP, yahooP, finnhubMacroP, aiP, cryptoP, energyP
    ]);

    // Split Yahoo results into indices + gold
    const yMap = toMap(yBatch);
    const gold = yMap.get("XAUUSD=X");
    const indicesRaw = INDICES
      .map(x => yMap.get(x.t))
      .filter(Boolean)
      .map(q => ({ ...q, name: indexNames[q.ticker] || q.name }));

    // Macro group: BTC (coingecko), Gold (yahoo), IEF (finnhub)
    const macro = applyNames(
      [ btc, gold, ...iEFonly ].filter(Boolean),
      macroNames
    );

    const allForMap = [...indicesRaw, ...macro, ...aiRaw, ...cryptoRaw, ...energyRaw];
    const qMap = toMap(allForMap);

    const ai     = topMoversFromUniverse(GROUPS.ai, qMap, 10);
    const crypto = topMoversFromUniverse(GROUPS.crypto, qMap, 10);
    const energy = topMoversFromUniverse(GROUPS.energy, qMap, 10);

    const payload = shapeResponse({
      macro,
      indices: indicesRaw,
      ai, crypto, energy
    });

    writeCache(payload);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    const cached = readCache();
    if (cached?.payload) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: e.message }) };
  }
};
