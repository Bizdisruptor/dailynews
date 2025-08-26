// netlify/functions/market-data.js
// Market data using a hybrid approach for maximum reliability.
// - Yahoo Finance for real indices and spot gold.
// - Finnhub for stock/ETF movers.
// - CoinGecko for Bitcoin.
const fs = require("fs");
const fetch = require("node-fetch");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes

const INDICES = [
  { t: "^DJI", name: "Dow Jones" },
  { t: "^GSPC", name: "S&P 500" },
  { t: "^IXIC", name: "Nasdaq" },
];
const MACRO = [
  { t: "BTC-USD", name: "Bitcoin" },
  { t: "GC=F", name: "Gold (Spot)" },
  { t: "^TNX", name: "US 10Y" },
];
const GROUPS = {
  ai: ["NVDA", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "AMD", "SMCI", "PLTR"],
  crypto: ["COIN", "MSTR", "MARA", "RIOT", "CLSK"],
  energy: ["XOM", "CVX", "SLB", "OXY", "COP"],
};

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (_) {}
  return null;
}
function writeCache(obj) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (_) {}
}

async function yahooQuotes(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
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

function mapBy(arr, key = "ticker") {
  const m = new Map();
  (arr || []).forEach(x => m.set(x[key], x));
  return m;
}

function topMovers(tickers, quoteMap, count = 8) {
  const rows = [];
  for (const t of tickers) {
    const q = quoteMap.get(t);
    if (q && typeof q.dp === 'number' && Number.isFinite(q.dp)) {
      rows.push({ ticker: t, c: q.c, d: q.d, dp: q.dp });
    }
  }
  rows.sort((a, b) => Math.abs(b.dp) - Math.abs(a.dp));
  return rows.slice(0, count);
}

async function getData() {
  const allYahooSyms = [ ...INDICES.map(i => i.t), ...MACRO.map(m => m.t), ...Object.values(GROUPS).flat() ];
  const quotes = await yahooQuotes(allYahooSyms);
  const quoteMap = mapBy(quotes);

  const getQuoteData = (config) => {
    const quote = quoteMap.get(config.t);
    if (!quote) return null;
    if (config.t === "^TNX") {
      return { name: config.name, ticker: "US10Y", c: quote.c, d: quote.d, dp: quote.dp };
    }
    return { name: config.name, ticker: quote.ticker, c: quote.c, d: quote.d, dp: quote.dp };
  };

  const indices = INDICES.map(getQuoteData).filter(Boolean);
  const macro = MACRO.map(getQuoteData).filter(Boolean);
  const movers = {
    ai: topMovers(GROUPS.ai, quoteMap, 8),
    crypto: topMovers(GROUPS.crypto, quoteMap, 8),
    energy: topMovers(GROUPS.energy, quoteMap, 8),
  };
  return { indices, macro, ...movers };
}

exports.handler = async function () {
  try {
    const cached = readCache();
    if (cached && (Date.now() - (cached.ts || 0) <= TTL_MS)) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    const data = await getData();
    const payload = { status: "ok", data };
    writeCache({ ts: Date.now(), payload });
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    const cached = readCache();
    if (cached?.payload) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: e.message }) };
  }
};
