// netlify/functions/market-data.js
// Live quotes with fallbacks (no API keys):
// - BTCUSD: CoinGecko -> CoinCap
// - XAUUSD: exchangerate.host -> metals.live
//
// Features: ?force=1, short TTL cache, no-store headers, useful error detail.

const fs = require("fs");

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = Number(process.env.MARKET_TTL_MS || 60 * 1000); // default 60s
const FETCH_TIMEOUT_MS = Number(process.env.MARKET_TIMEOUT_MS || 6000);

// --- tiny timeout wrapper for fetch ---
function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal })
    .finally(() => clearTimeout(id));
}

// --- cache helpers ---
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch {}
  return null;
}
function writeCache(payload) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), payload }));
  } catch {}
}

// --- BTC: CoinGecko -> CoinCap fallback ---
async function fetchBTCUSD() {
  const errors = [];

  // 1) CoinGecko
  try {
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
    const r = await fetchWithTimeout(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error(`coingecko HTTP ${r.status}`);
    const j = await r.json();
    const price = j?.bitcoin?.usd;
    if (typeof price !== "number") throw new Error("coingecko missing price");
    return { symbol: "BTCUSD", price, source: "coingecko", ts: Date.now() };
  } catch (e) {
    errors.push(String(e));
  }

  // 2) CoinCap
  try {
    const url = "https://api.coincap.io/v2/assets/bitcoin";
    const r = await fetchWithTimeout(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error(`coincap HTTP ${r.status}`);
    const j = await r.json();
    const price = j?.data ? Number(j.data.priceUsd) : NaN;
    if (!isFinite(price)) throw new Error("coincap missing price");
    return { symbol: "BTCUSD", price, source: "coincap", ts: Date.now() };
  } catch (e) {
    errors.push(String(e));
  }

  throw new Error(`BTCUSD failed: ${errors.join(" | ")}`);
}

// --- XAU: exchangerate.host -> metals.live fallback ---
async function fetchXAUUSD() {
  const errors = [];

  // 1) exchangerate.host convert XAU->USD
  try {
    const url = "https://api.exchangerate.host/convert?from=XAU&to=USD";
    const r = await fetchWithTimeout(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error(`exchangerate.host HTTP ${r.status}`);
    const j = await r.json();
    const price = j?.result;
    if (typeof price !== "number") throw new Error("exchangerate.host missing price");
    return { symbol: "XAUUSD"
