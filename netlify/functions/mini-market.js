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

async function getBTC() {
  // Try CoinGecko -> CoinCap
  try {
    const r = await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    const j = await r.json();
    const p = j?.bitcoin?.usd;
    if (typeof p !== "number") throw new Error("coingecko missing price");
    return p;
  } catch {}
  try {
    const r = await fetchWithTimeout("https://api.coincap.io/v2/assets/bitcoin");
    if (!r.ok) throw new Error(`coincap ${r.status}`);
    const j = await r.json();
    const p = Number(j?.data?.priceUsd);
    if (!isFinite(p)) throw new Error("coincap missing price");
    return p;
  } catch (e) {
    throw new Error("BTC fetch failed");
  }
}

async function getXAU() {
  // Try exchangerate.host -> metals.live
  try {
    const r = await fetchWithTimeout("https://api.exchangerate.host/convert?from=XAU&to=USD");
    if (!r.ok) throw new Error(`exchangerate.host ${r.status}`);
    const j = await r.json();
    const p = j?.result;
    if (typeof p !== "number") throw new Error("exchangerate.host missing price");
    return p;
  } catch {}
  try {
    const r = await fetchWithTimeout("https://api.metals.live/v1/spot/gold");
    if (!r.ok) throw new Error(`metals.live ${r.status}`);
    const j = await r.json();
    let p;
    if (Array.isArray(j)) {
      const first = j[0];
      if (Array.isArray(first)) {
        const nums = first.filter(n => typeof n === "number");
        p = nums.length ? Math.max(...nums) : undefined;
      } else if (typeof j[0] === "number") {
        p = j[0];
      }
    } else if (j && Array.isArray(j.gold)) {
      p = Number(j.gold[0]);
    }
    if (!isFinite(p)) throw new Error("metals.live missing price");
    return p;
  } catch (e) {
    throw new Error("XAU fetch failed");
  }
}

exports.handler = async (event) => {
  try {
    const force = event?.queryStringParameters?.force === "1";
    const cached = readCache();
    if (!force && cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    const [btc, xau] = await Promise.all([getBTC(), getXAU()]);
    const payload = { status: "ok", data: { btcUSD: btc, xauUSD: xau } };
    writeCache(payload);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    const cached = readCache();
    if (cached?.payload) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: String(e.message || e) }) };
  }
};
