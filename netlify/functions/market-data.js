// netlify/functions/market-data.js
// BTCUSD from CoinGecko, XAUUSD from exchangerate.host
// No API keys required. Adds ?force=1 and short TTL cache.

const fs = require("fs");

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = Number(process.env.MARKET_TTL_MS || 60 * 1000); // default 60s

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

async function fetchBTCUSD() {
  // CoinGecko Simple Price
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = await r.json();
  const price = j?.bitcoin?.usd;
  if (typeof price !== "number") throw new Error("coingecko missing price");
  return { symbol: "BTCUSD", price, source: "coingecko", ts: Date.now() };
}

async function fetchXAUUSD() {
  // exchangerate.host supports XAU → USD
  // Option 1: convert endpoint (direct quote)
  const url = "https://api.exchangerate.host/convert?from=XAU&to=USD";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`exchangerate.host ${r.status}`);
  const j = await r.json();
  const price = j?.result; // USD per 1 XAU (troy ounce)
  if (typeof price !== "number") throw new Error("exchangerate.host missing price");
  return { symbol: "XAUUSD", price, source: "exchangerate.host", ts: Date.now() };
}

exports.handler = async (event) => {
  try {
    const force = event?.queryStringParameters?.force === "1";
    const cached = readCache();
    if (!force && cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    // Fetch in parallel
    const [btc, xau] = await Promise.allSettled([fetchBTCUSD(), fetchXAUUSD()]);

    const data = {};
    if (btc.status === "fulfilled") data.BTCUSD = btc.value;
    if (xau.status === "fulfilled") data.XAUUSD = xau.value;

    // If both failed, throw the first error
    if (!data.BTCUSD && !data.XAUUSD) {
      const reason = (btc.status === "rejected" ? btc.reason : xau.reason) || new Error("all sources failed");
      throw reason;
    }

    const payload = { status: "ok", data };
    writeCache(payload);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    const cached = readCache();
    if (cached?.payload) {
      // serve stale if available
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: String(e.message || e) }) };
  }
};
