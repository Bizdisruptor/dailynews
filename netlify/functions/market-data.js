// netlify/functions/market-data.js  (CommonJS)
// Key-free market data using Yahoo Finance + /tmp cache fallback.
// Structure returned:
// { status:"ok", data: { macro:[...], indices:[...], ai:[...], crypto:[...], energy:[...] }, source:"live|cache" }

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const CACHE_PATH = "/tmp/market-data-cache.json";
const TTL_MS = 3 * 60 * 1000; // 3 minutes

// ---- Friendly name helpers ----
const FRIENDLY = {
  "^DJI": "Dow Jones",
  "^GSPC": "S&P 500",
  "^IXIC": "NASDAQ",
  "SPY": "S&P 500",
  "QQQ": "NASDAQ 100",
  "DIA": "Dow Jones",

  "BTC-USD": "Bitcoin",
  "GC=F": "Gold",
  "^TNX": "10Y Treasury",
  "DX-Y.NYB": "US Dollar Index",
  "^VIX": "VIX",

  "NVDA": "NVDA",
  "MSFT": "MSFT",
  "GOOG": "GOOG",
  "AMD": "AMD",
  "SMCI": "SMCI",
  "AVGO": "AVGO",
  "META": "META",
  "TSLA": "TSLA",
  "AAPL": "AAPL",
  "PLTR": "PLTR",

  "COIN": "COIN",
  "MSTR": "MSTR",
  "MARA": "MARA",
  "RIOT": "RIOT",
  "CLSK": "CLSK",

  "XOM": "XOM",
  "CVX": "CVX",
  "SLB": "SLB",
  "OXY": "OXY",
  "COP": "COP",
};

// ---- What we’ll fetch ----
const SYMBOLS = {
  // macro bar at the very top
  macro: ["BTC-USD", "GC=F", "^TNX", "DX-Y.NYB", "^VIX"],
  // headline indices
  indices: ["^DJI", "^GSPC", "^IXIC", "DIA", "SPY", "QQQ"], // we’ll filter whichever returns
  ai: ["NVDA", "MSFT", "GOOG", "AMD", "SMCI", "AVGO", "META", "TSLA", "AAPL", "PLTR"],
  crypto: ["COIN", "MSTR", "MARA", "RIOT", "CLSK"],
  energy: ["XOM", "CVX", "SLB", "OXY", "COP"],
};

// ---- Yahoo fetch ----
async function fetchYahooQuoteMap(symbols) {
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
    encodeURIComponent(symbols.join(","));
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const data = await r.json();
  const rows = data?.quoteResponse?.result || [];
  const map = new Map();
  for (const q of rows) {
    map.set(q.symbol, q);
  }
  return map;
}

function pickQuotes(map, symbols, { preferFirst = false } = {}) {
  const out = [];
  for (const s of symbols) {
    const q = map.get(s);
    if (q && q.regularMarketPrice != null) {
      out.push({
        ticker: s,
        name: FRIENDLY[s] || q.shortName || q.longName || s,
        c: +q.regularMarketPrice,
        d: +q.regularMarketChange || 0,
        dp: +q.regularMarketChangePercent || 0,
        t: q.regularMarketTime || 0,
      });
    }
  }
  // For indices, we only want the best representatives:
  // - Prefer ^DJI over DIA, ^GSPC over SPY, ^IXIC over QQQ (if present)
  if (preferFirst) {
    const norm = [];
    // Desired order
    const groups = [
      ["^DJI", "DIA"],
      ["^GSPC", "SPY"],
      ["^IXIC", "QQQ"],
    ];
    for (const g of groups) {
      const found = out.find((x) => x.ticker === g[0]) || out.find((x) => x.ticker === g[1]);
      if (found) norm.push(found);
    }
    return norm;
  }
  return out;
}

// ---- Simple /tmp cache helpers ----
function readCache() {
  try {
    const fs = require("fs");
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    const json = JSON.parse(raw);
    if (Date.now() - (json.ts || 0) > TTL_MS) return null;
    return json.data || null;
  } catch (_) {
    return null;
  }
}

function writeCache(data) {
  try {
    const fs = require("fs");
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ ts: Date.now(), data }));
  } catch (_) {}
}

exports.handler = async function () {
  try {
    // Try cache first
    const cached = readCache();
    if (cached) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ status: "ok", data: cached, source: "cache" }),
      };
    }

    // Fetch everything at once
    const all = Array.from(
      new Set([
        ...SYMBOLS.macro,
        ...SYMBOLS.indices,
        ...SYMBOLS.ai,
        ...SYMBOLS.crypto,
        ...SYMBOLS.energy,
      ])
    );
    const map = await fetchYahooQuoteMap(all);

    const data = {
      macro: pickQuotes(map, SYMBOLS.macro),
      indices: pickQuotes(map, SYMBOLS.i
