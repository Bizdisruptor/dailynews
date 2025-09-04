// netlify/functions/mini-market.js
// Returns { btcUSD, xauUSD } with no API keys, cache 60s, ?force=1.

const fs = require("fs");
const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};
const CACHE_FILE = "/tmp/mini-market-cache.json";
const TTL_MS = Number(process.env.MARKET_TTL_MS || 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.MARKET_TIMEOUT_MS || 6000);

function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

function readCache() { try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE,"utf8")); } catch {} return null; }
function writeCache(payload) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), payload })); } catch {} }

// ---- BTC (CoinGecko -> CoinCap) ----
async function getBTC() {
  try {
    const r = await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    if (!r.ok) throw new Error(`coingecko HTTP ${r.status}`);
    const j = await r.json();
    const p = j?.bitcoin?.usd;
    if (typeof p !== "number") throw new Error("coingecko missing price");
    return p;
  } catch (e) {
    console.warn("CoinGecko BTC failed:", e.message);
  }
  try {
    const r = await fetchWithTimeout("https://api.coincap.io/v2/assets/bitcoin");
    if (!r.ok) throw new Error(`coincap HTTP ${r.status}`);
    const j = await r.json();
    const p = Number(j?.data?.priceUsd);
    if (!isFinite(p)) throw new Error("coincap missing price");
    return p;
  } catch (e) {
    console.error("CoinCap BTC failed:", e.message);
    throw new Error("BTC fetch failed");
  }
}

// ---- XAU (exchangerate.host latest->convert -> metals.live) ----
async function getXAU() {
  // 1) exchangerate.host latest (USD base, XAU symbol) -> invert
  try {
    const r = await fetchWithTimeout("https://api.exchangerate.host/latest?base=USD&symbols=XAU");
    if (!r.ok) throw new Error(`exchangerate.host/latest HTTP ${r.status}`);
    const j = await r.json();
    const rateXAUperUSD = j?.rates?.XAU; // how many XAU per 1 USD
    if (typeof rateXAUperUSD !== "number" || rateXAUperUSD === 0) throw new Error("latest missing rate");
    const usdPerXAU = 1 / rateXAUperUSD;
    if (!isFinite(usdPerXAU)) throw new Error("latest inversion invalid");
    return usdPerXAU;
  } catch (e) {
    console.warn("exchangerate.host latest XAU failed:", e.message);
  }

  // 2) exchangerate.host convert XAU->USD
  try {
    const r = await fetchWithTimeout("https://api.exchangerate.host/convert?from=XAU&to=USD");
    if (!r.ok) throw new Error(`exchangerate.host/convert HTTP ${r.status}`);
    const j = await r.json();
    const p = j?.result;
    if (typeof p !== "number") throw new Error("convert missing result");
    return p; // USD per 1 XAU
  } catch (e) {
    console.warn("exchangerate.host convert XAU failed:", e.message);
  }

  // 3) metals.live spot gold (handle multiple shapes)
  try {
    const r = await fetchWithTimeout("https://api.metals.live/v1/spot/gold");
    if (!r.ok) throw new Error(`metals.live HTTP ${r.status}`);
    const j = await r.json();

    let p;

    if (Array.isArray(j)) {
      // Could be [number,...] OR [[ts, ask, bid], ...] OR [[ask,bid], ...]
      const first = j[0];
      if (typeof first === "number") {
        p = first;
      } else if (Array.isArray(first)) {
        // choose the largest numeric in the first tuple as ask proxy
        const nums = first.filter(n => typeof n === "number");
        p = nums.length ? Math.max(...nums) : undefined;
      } else if (first && typeof first === "object") {
        // Sometimes array of objects with price fields
        const tryFields = ["ask", "bid", "price", "gold", "xau"];
        for (const f of tryFields) {
          const v = Number(first[f]);
          if (isFinite(v)) { p = v; break; }
        }
      }
    } else if (j && typeof j === "object") {
      // Sometimes { gold: [ask, bid] } or { price: ... }
      if (Array.isArray(j.gold)) {
        p = Number(j.gold[0]);
      } else if (typeof
