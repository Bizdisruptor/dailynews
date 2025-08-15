// netlify/functions/market-data.js (CommonJS)
// Aggregates quotes from Yahoo Finance and returns macro + sector movers.
// Falls back to cached data in /tmp so the page never goes blank.

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const CACHE_FILE = "/tmp/market-data-cache.json";

// ----- Symbol sets -----------------------------------------------------------

// Macro bar: Bitcoin, Gold futures, 10-year Treasury yield (^TNX)
const MACRO = ["BTC-USD", "GC=F", "^TNX"];

// Major indices (use ^DJI ^GSPC ^IXIC which Yahoo provides without keys)
const INDICES = ["^DJI", "^GSPC", "^IXIC"];

// Buckets for the grid (each item is a Yahoo symbol)
const AI = ["NVDA", "MSFT", "AAPL", "GOOGL", "AMD", "SMCI", "AVGO", "META", "TSLA", "PLTR"];
const CRYPTO = ["COIN", "MSTR", "MARA", "RIOT", "CLSK"];
const ENERGY = ["XOM", "CVX", "SLB", "OXY", "COP"];

// ----- Helpers ---------------------------------------------------------------

function pickFields(q) {
  // Normalize to the shape the front-end expects
  return {
    ticker: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    c: q.regularMarketPrice,                    // current
    d: q.regularMarketChange,                   // change
    dp: q.regularMarketChangePercent,           // % change
    t: q.regularMarketTime || q.postMarketTime || q.preMarketTime || null,
  };
}

async function yahooQuotes(symbols) {
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
    encodeURIComponent(symbols.join(","));
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const rows = json?.quoteResponse?.result || [];
  return rows.map(pickFields);
}

function mapBySymbol(quotes) {
  const m = new Map();
  for (const q of quotes) m.set(q.ticker, q);
  return m;
}

function readCache() {
  try {
    const fs = require("fs");
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
}

function writeCache(payload) {
  try {
    const fs = require("fs");
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  } catch (_) {}
}

// ----- Handler ---------------------------------------------------------------

exports.handler = async function () {
  try {
    // Fetch everything in one Yahoo call
    const allSymbols = [...new Set([...MACRO, ...INDICES, ...AI, ...CRYPTO, ...ENERGY])];
    const quotes = await yahooQuotes(allSymbols);
    const bySym = mapBySymbol(quotes);

    const payload = {
      macro: MACRO.map(s => bySym.get(s)).filter(Boolean),
      indices: INDICES.map(s => bySym.get(s)).filter(Boolean),
      ai: AI.map(s => bySym.get(s)).filter(Boolean),
      crypto: CRYPTO.map(s => bySym.get(s)).filter(Boolean),
      energy: ENERGY.map(s => bySym.get(s)).filter(Boolean),
      ts: Date.now(),
      source: "live",
    };

    // persist in /tmp so we can serve stale on outages
    writeCache(payload);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ status: "ok", data: payload }),
    };
  } catch (e) {
    // On failure, try to serve the last good payload
    const cached = readCache();
    if (cached) {
      cached.source = "cache";
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ status: "ok", data: cached }),
      };
    }
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ status: "error", message: e.message }),
    };
  }
};
