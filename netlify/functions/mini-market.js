// netlify/functions/mini-market.js
// Minimal server-side fetch for BTC-USD and XAU-USD with caching.
// Works on Netlify Functions (Node 18+). CommonJS syntax.

const fs = require("fs");

const CACHE_FILE = "/tmp/mini-market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

function readCache() {
  try {
    return fs.existsSync(CACHE_FILE)
      ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
      : null;
  } catch (_) {
    return null;
  }
}
function writeCache(obj) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj)); } catch (_) {}
}

async function withTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function getBTC_USD() {
  // Primary: Coingecko
  try {
    const res = await withTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      8000
    );
    if (res.ok) {
      const j = await res.json();
      const v = j && j.bitcoin && typeof j.bitcoin.usd === "number" ? j.bitcoin.usd : null;
      if (v != null) return v;
    }
  } catch (_) {}
  // Fallback: Yahoo
  try {
    const res = await withTimeout(
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=BTC-USD",
      8000
    );
    if (res.ok) {
      const j = await res.json();
      const q = j && j.quoteResponse && j.quoteResponse.result && j.quoteResponse.result[0];
      const v = q && typeof q.regularMarketPrice === "number" ? q.regularMarketPrice : null;
      if (v != null) return v;
    }
  } catch (_) {}
  return null;
}

async function getXAU_USD() {
  // Primary: exchangerate.host
  try {
    const res = await withTimeout(
      "https://api.exchangerate.host/con
