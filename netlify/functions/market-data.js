// netlify/functions/market-data.js
// Market data with robust fallbacks + dynamic "top movers" per sector.
import { getStore } from "@netlify/blobs";

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_KEY = "last-market-data";

// ----- Universes (we'll sort by biggest absolute % movers) -----
const AI_UNIVERSE = ["NVDA", "MSFT", "GOOG", "AMD", "AVGO", "META", "AAPL", "TSLA", "SMCI", "ASML", "MU", "TSM"];
const CRYPTO_UNIVERSE = ["COIN", "MSTR", "MARA", "RIOT", "CLSK", "HUT", "BITF", "IREN", "CIFR", "WULF"];
const ENERGY_UNIVERSE = ["XOM", "CVX", "SLB", "OXY", "COP", "DVN", "EOG", "PXD", "HAL", "MRO", "APA"];

// Index and Macro symbols for Yahoo Finance
const YAHOO_SYMBOLS = {
  indices: [
    { sym: "^DJI", name: "Dow Jones" },
    { sym: "^GSPC", name: "S&P 500" },
    { sym: "^IXIC", name: "NASDAQ" },
  ],
  macro: [
    { sym: "BTC-USD", name: "Bitcoin" },
    { sym: "GC=F", name: "Gold" },
    { sym: "^TNX", name: "US 10Y" },
  ]
};

// ---------- Utils ----------
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

// ---------- Provider: Yahoo Finance ----------
async function yahooQuotes(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "Accept": "application/json",
    }
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const raw = await r.json();
  const arr = raw?.quoteResponse?.result || [];
  return arr.map(q => ({
    ticker: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    c: q.regularMarketPrice ?? null,
    d: q.regularMarketChange ?? null,
    dp: q.regularMarketChangePercent ?? null,
  }));
}

// ---------- Build Data Structure ----------
function mapBy(arr, key = "ticker") {
  const m = new Map();
  (arr || []).forEach(x => m.set(x[key], x));
  return m;
}

function topMovers(tickers, quoteMap, count = 8) {
  const rows = [];
  for (const t of tickers) {
    const q = quoteMap.get(t);
    if (q && isNum(q.dp)) {
      rows.push({ ticker: t, c: q.c, d: q.d, dp: q.dp });
    }
  }
  rows.sort((a, b) => Math.abs(b.dp) - Math.abs(a.dp));
  return rows.slice(0, count);
}

async function getData() {
  const allYahooSyms = [
    ...YAHOO_SYMBOLS.indices.map(i => i.sym),
    ...YAHOO_SYMBOLS.macro.map(m => m.sym),
    ...AI_UNIVERSE, ...CRYPTO_UNIVERSE, ...ENERGY_UNIVERSE,
  ];

  const quotes = await yahooQuotes(allYahooSyms);
  const quoteMap = mapBy(quotes);

  const getQuoteData = (config) => {
      const quote = quoteMap.get(config.sym);
      if (!quote) return null;
      // Special handling for US 10Y Treasury Yield
      if (config.sym === "^TNX") {
          return { name: config.name, ticker: "US10Y", c: quote.c, d: quote.d, dp: quote.dp };
      }
      return { name: config.name, ticker: quote.ticker, c: quote.c, d: quote.d, dp: quote.dp };
  };

  const indices = YAHOO_SYMBOLS.indices.map(getQuoteData).filter(Boolean);
  const macro = YAHOO_SYMBOLS.macro.map(getQuoteData).filter(Boolean);

  const movers = {
    ai: topMovers(AI_UNIVERSE, quoteMap, 8),
    crypto: topMovers(CRYPTO_UNIVERSE, quoteMap, 8),
    energy: topMovers(ENERGY_UNIVERSE, quoteMap, 8),
  };

  return { indices, macro, ...movers };
}

// ---------- Handler with Caching ----------
export async function handler() {
  const cache = getStore('market-data-cache');
  try {
    const data = await getData();
    const hasSomething = data.indices.length || data.macro.length || data.ai.length;

    if (hasSomething) {
      const payload = { status: "ok", data, ts: Date.now() };
      await cache.set(CACHE_KEY, payload);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", data, source: "live" }) };
    }
    // If live data is empty, fall through to cache
    throw new Error("Live data was empty.");
  } catch (e) {
    console.warn(`Live market data fetch failed: ${e.message}. Attempting to serve from cache.`);
    const cached = await cache.get(CACHE_KEY, { type: 'json' });
    if (cached && cached.status === "ok") {
      console.log("Serving stale market data from cache.");
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", data: cached.data, source: "cache" }) };
    }
    console.error("Cache is empty. No market data to serve.");
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: "Market data is currently unavailable." }) };
  }
}
