// netlify/functions/market-data.js  (CommonJS)
// Yahoo Finance quotes -> indices + movers + macro
// Falls back to cached payload in /tmp so the UI never blanks.

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const CACHE_FILE = "/tmp/market-data-cache.json";

// ----- Symbols ---------------------------------------------------------------

// Macro bar: Bitcoin, Gold futures, 10-year yield
const MACRO = ["BTC-USD", "GC=F", "^TNX"];

// Major US indices
const INDICES = ["^DJI", "^GSPC", "^IXIC"];

// Movers buckets
const AI = ["NVDA", "MSFT", "AAPL", "GOOGL", "AMD", "SMCI", "AVGO", "META", "TSLA", "PLTR"];
const CRYPTO = ["COIN", "MSTR", "MARA", "RIOT", "CLSK"];
const ENERGY = ["XOM", "CVX", "SLB", "OXY", "COP"];

// Friendly names for a few symbols
const FRIENDLY = {
  "^DJI": "Dow Jones",
  "^GSPC": "S&P 500",
  "^IXIC": "NASDAQ",
  "GC=F": "Gold",
  "^TNX": "10Y",
  "BTC-USD": "Bitcoin",
};

function friendlyName(q) {
  return (
    FRIENDLY[q.symbol] ||
    q.shortName ||
    q.longName ||
    q.symbol
  );
}

function norm(q) {
  return {
    ticker: q.symbol,
    name: friendlyName(q),
    c: q.regularMarketPrice,
    d: q.regularMarketChange,
    dp: q.regularMarketChangePercent,
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
  return (json?.quoteResponse?.result || []).map(norm);
}

function readCache() {
  try {
    const fs = require("fs");
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
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

exports.handler = async function () {
  try {
    const all = [...new Set([...MACRO, ...INDICES, ...AI, ...CRYPTO, ...ENERGY])];
    const quotes = await yahooQuotes(all);

    const by = new Map(quotes.map(q => [q.ticker, q]));

    const data = {
      // new: macro for BTC/Gold/10Y (you can render or ignore on the UI)
      macro: MACRO.map(s => by.get(s)).filter(Boolean),

      // matches your front-end expectation:
      indices: INDICES.map(s => by.get(s)).filter(Boolean),
      movers: {
        ai: AI.map(s => by.get(s)).filter(Boolean),
        crypto: CRYPTO.map(s => by.get(s)).filter(Boolean),
        energy: ENERGY.map(s => by.get(s)).filter(Boolean),
      },
      ts: Date.now(),
      source: "live",
    };

    writeCache(data);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ status: "ok", data }),
    };
  } catch (e) {
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
