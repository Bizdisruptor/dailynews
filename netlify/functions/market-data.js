// netlify/functions/market-data.js
// Market data via Yahoo (with safer fetch) + robust timeout + cache.
// If you want a Yahoo-free primary, ping me and I’ll swap providers.

const fs = require("fs");

// Netlify on Node 18+ has global fetch. Add a small timeout helper.
async function fetchJSON(url, { tag = "fetch", timeoutMs = 8000, headers = {} } = {}) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "cerfreport/1.0", ...headers },
      signal: ac.signal
    });
    if (!r.ok) throw new Error(`${tag} HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    // Yahoo sometimes responds with HTML when rate-limited
    if (!ct.includes("application/json")) {
      const text = await r.text();
      throw new Error(`${tag} non-JSON (${ct.slice(0,50)}): ${text.slice(0,120)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes

const INDICES = [
  { t: "^DJI",  name: "Dow Jones" },
  { t: "^GSPC", name: "S&P 500" },
  { t: "^IXIC", name: "Nasdaq" },
];

const MACRO = [
  { t: "BTC-USD", name: "Bitcoin" },
  { t: "GC=F",    name: "Gold (Spot)" },
  { t: "^TNX",    name: "US 10Y" },
];

const GROUPS = {
  ai:     ["NVDA","MSFT","GOOGL","AMZN","META","TSLA","AVGO","AMD","SMCI","PLTR"],
  crypto: ["COIN","MSTR","MARA","RIOT","CLSK"],
  energy: ["XOM","CVX","SLB","OXY","COP"],
};

function readCache() {
  try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : null; }
  catch (_) { return null; }
}

function writeCache(obj) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj)); } catch (_) {}
}

function mapBy(arr, key = "ticker") {
  const m = new Map();
  (arr || []).forEach(x => x && m.set(x[key], x));
  return m;
}

function topMovers(tickers, quoteMap, count = 8) {
  const rows = [];
  for (const t of tickers) {
    const q = quoteMap.get(t);
    if (q && Number.isFinite(q.dp)) rows.push({ ticker: t, c: q.c, d: q.d, dp: q.dp });
  }
  rows.sort((a,b) => Math.abs(b.dp) - Math.abs(a.dp));
  return rows.slice(0, count);
}

async function yahooQuotes(symbols) {
  if (!symbols.length) return [];
  // Encode EACH symbol; join with literal commas (don’t encode commas)
  const list = symbols.map(s => encodeURIComponent(s)).join(",");
  const url  = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${list}`;
  const raw  = await fetchJSON(url, { tag: "yahoo:quotes", timeoutMs: 9000 });
  const arr  = raw?.quoteResponse?.result || [];
  return arr.map(q => ({
    ticker: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    c: (typeof q.regularMarketPrice === "number") ? q.regularMarketPrice : null,
    d: (typeof q.regularMarketChange === "number") ? q.regularMarketChange : null,
    dp: (typeof q.regularMarketChangePercent === "number") ? q.regularMarketChangePercent : null,
  }));
}

async function getData() {
  const allSymbols = [
    ...INDICES.map(i => i.t),
    ...MACRO.map(m => m.t),
    ...Object.values(GROUPS).flat()
  ];

  const quotes = await yahooQuotes(allSymbols);
  const quoteMap = mapBy(quotes);

  const extract = (cfg) => {
    const q = quoteMap.get(cfg.t);
    if (!q) return null;
    if (cfg.t === "^TNX") {
      // keep your existing aliasing for 10Y
      return { name: cfg.name, ticker: "US10Y", c: q.c, d: q.d, dp: q.dp };
    }
    return { name: cfg.name, ticker: q.ticker, c: q.c, d: q.d, dp: q.dp };
    // (If you want to force names from cfg always, replace name: q.name with cfg.name)
  };

  const indices = INDICES.map(extract).filter(Boolean);
  const macro   = MACRO.map(extract).filter(Boolean);

  const ai     = topMovers(GROUPS.ai, quoteMap, 8);
  const crypto = topMovers(GROUPS.crypto, quoteMap, 8);
  const energy = topMovers(GROUPS.energy, quoteMap, 8);

  return { indices, macro, ai, crypto, energy };
}

exports.handler = async function () {
  try {
    const cached = readCache();
    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    const data = await getData();
    const payload = { status: "ok", data };
    writeCache({ ts: Date.now(), payload });
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
