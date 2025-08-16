// netlify/functions/market-data.js (CommonJS)
// Market data via Finnhub (stocks/ETFs) + CoinGecko (BTC) with /tmp cache.
// Shape matches your index.html: { status:"ok", data:{ macro, indices, ai, crypto, energy, movers } }
const fetch = require("node-fetch"); // ✅ FIX: Added the required fetch library.
const fs = require("fs");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3;       // consider cache fresh for 3 minutes
const REQ_TIMEOUT = 8000;           // per-request timeout (ms)

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

// Indices row (ETFs so Finnhub can quote easily)
const INDICES = [
  { t: "DIA",  name: "Dow Jones (DIA)" },
  { t: "SPY",  name: "S&P 500 (SPY)" },
  { t: "QQQ",  name: "Nasdaq 100 (QQQ)" },
];

// Macro row: BTC (CoinGecko), Gold proxy (GLD), Treasuries proxy (IEF)
const MACRO = [
  { t: "BTCUSD", name: "Bitcoin" },
  { t: "GLD",    name: "Gold (GLD proxy)" },
  { t: "IEF",    name: "US Treasuries 7–10Y (IEF)" },
];

// Movers universes
const GROUPS = {
  ai:     ["NVDA","MSFT","GOOGL","AMZN","META","TSLA","AVGO","AMD","SMCI","PLTR","ASML","MU","TSM"],
  crypto: ["COIN","MSTR","MARA","RIOT","CLSK","HUT","BITF","IREN","CIFR","WULF"],
  energy: ["XOM","CVX","SLB","OXY","COP","DVN","EOG","PXD","HAL","MRO","APA"],
};

// ---------- utils ----------
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

// ---------- caching (/tmp) ----------
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

// ---------- providers ----------
async function finnhubQuote(symbol) {
  if (!FINNHUB_KEY) throw new Error("Missing FINNHUB_API_KEY");
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
  const data = await fetchJson(url, { "Accept": "application/json" }, `finnhub:${symbol}`);
  // returns { c,d,dp,h,l,o,pc,t }
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

// ---------- shaping ----------
function applyNames(quotes, namesMap) {
  return quotes.map(q => ({ ...q, name: namesMap[q.ticker] || q.name || q.ticker }));
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
function toMap(arr) {
  const m = new Map();
  (arr||[]).forEach(x => x?.ticker && m.set(x.ticker, x));
  return m;
}

function shapeResponse({ macro, indices, ai, crypto, energy }) {
  return {
    status: "ok",
    data: { macro, indices, ai, crypto, energy, movers: { ai, crypto, energy } }
  };
}

// ---------- handler ----------
exports.handler = async function() {
  try {
    // 1) serve fresh cache (<= TTL)
    const cached = readCache();
    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    // 2) live fetch
    const btcP = coingeckoBTC();

    const indexNames = Object.fromEntries(INDICES.map(x => [x.t, x.name]));
    const macroNames = Object.fromEntries(MACRO.map(x => [x.t, x.name]));

    const indicesP = batchFinnhub(INDICES.map(x => x.t));
    const macroP   = batchFinnhub(MACRO.filter(x => x.t !== "BTCUSD").map(x => x.t));
    const aiP      = batchFinnhub(GROUPS.ai);
    const cryptoP  = batchFinnhub(GROUPS.crypto);
    const energyP  = batchFinnhub(GROUPS.energy);

    const [btc, indicesRaw, macroRaw, aiRaw, cryptoRaw, energyRaw] = await Promise.all([
      btcP, indicesP, macroP, aiP, cryptoP, energyP
    ]);

    const macro = applyNames([btc, ...macroRaw].filter(Boolean), macroNames);
    const indices = applyNames(indicesRaw, indexNames);

    const allForMap = [...indices, ...macro, ...aiRaw, ...cryptoRaw, ...energyRaw];
    const qMap = toMap(allForMap);

    const ai     = topMoversFromUniverse(GROUPS.ai, qMap, 10);
    const crypto = topMoversFromUniverse(GROUPS.crypto, qMap, 10);
    const energy = topMoversFromUniverse(GROUPS.energy, qMap, 10);

    const payload = shapeResponse({ macro, indices, ai, crypto, energy });

    writeCache(payload);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    // 3) stale cache fallback
    const cached = readCache();
    if (cached?.payload) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: e.message }) };
  }
};
