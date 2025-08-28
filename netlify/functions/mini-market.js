// netlify/functions/mini-market.js
// Minimal server-side fetch for BTC-USD and XAU-USD with caching and robust fallbacks.

const fs = require("fs");

const CACHE_FILE = "/tmp/mini-market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};
const UA_HEADERS = {
  "Accept": "application/json,text/*;q=0.9,*/*;q=0.8",
  "User-Agent": "cerfreport/1.0 (+https://thecerfreport.com)"
};

// ------------- cache helpers -------------
function readCache() {
  try {
    return fs.existsSync(CACHE_FILE)
      ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
      : null;
  } catch (_) { return null; }
}
function writeCache(obj) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj)); } catch (_) {}
}

// fetch with timeout + optional headers
async function withTimeout(url, ms, headers = undefined) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { signal: ac.signal, headers });
  } finally {
    clearTimeout(t);
  }
}

// ------------- providers -------------
async function getBTC_USD() {
  // 1) Coingecko
  try {
    const r = await withTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", 8000, UA_HEADERS);
    if (r.ok) {
      const j = await r.json();
      const v = j?.bitcoin?.usd;
      if (typeof v === "number" && isFinite(v)) return v;
    }
  } catch (_) {}
  // 2) Yahoo BTC-USD
  try {
    const r = await withTimeout("https://query1.finance.yahoo.com/v7/finance/quote?symbols=BTC-USD", 8000, UA_HEADERS);
    if (r.ok) {
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      const v = q?.regularMarketPrice;
      if (typeof v === "number" && isFinite(v)) return v;
    }
  } catch (_) {}
  return null;
}

async function getXAU_USD() {
  // 1) Yahoo spot gold (XAUUSD=X)
  try {
    const r = await withTimeout("https://query1.finance.yahoo.com/v7/finance/quote?symbols=XAUUSD=X", 8000, UA_HEADERS);
    if (r.ok) {
      const j = await r.json();
      const q = j
