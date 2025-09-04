// netlify/functions/mini-market.js
// Returns { btcUSD, xauUSD } with no API keys, cache 60s, ?force=1.
// BTC: Binance (US). XAU: exchangerate.host (invert) -> metals.live fallback.

const fs = require("fs");

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

const CACHE_FILE = "/tmp/mini-market-cache.json";
const TTL_MS = Number(process.env.MARKET_TTL_MS || 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.MARKET_TIMEOUT_MS || 8000);

function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

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

// --- BTC from Binance (no key) ---
async function getBTC() {
  // Use US endpoint for USD pair
  // Example response: { symbol: "BTCUSD", price: "61234.56000000" }
  const url = "https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD";
  const r = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`binance HTTP ${r.status}`);
  const j = await r.json();
  const p = Number(j?.price);
  if (!isFinite(p)) throw new Error("binance missing price");
  return p;
}

// --- XAU primary: exchangerate.host latest USD->XAU inverted ---
async function getXAU_primary() {
  // USD base, XAU symbol → gives XAU per USD, invert for USD per XAU
  const url = "https://api.exchangerate.host/latest?base=USD&symbols=XAU&_ts=" + Date.now();
  const r = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`exchangerate.host/latest HTTP ${r.status}`);
  const j = await r.json();
  const rateXAUperUSD = j?.rates?.XAU;
  if (typeof rateXAUperUSD !== "number" || rateXAUperUSD === 0) {
    throw new Error("latest missing/zero XAU rate");
  }
  const usdPerXAU = 1 / rateXAUperUSD;
  if (!isFinite(usdPerXAU)) throw new Error("latest inversion invalid");
  return usdPerXAU;
}

// --- XAU fallback: metals.live ---
async function getXAU_fallback() {
  const url = "https://api.metals.live/v1/spot/gold?_ts=" + Date.now();
  const r = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`metals.live HTTP ${r.status}`);
  const j = await r.json();

  let p;
  if (Array.isArray(j)) {
    const first = j[0];
    if (typeof first === "number") {
      p = first;
    } else if (Array.isArray(first)) {
      const nums = first.filter(n => typeof n === "number");
      p = nums.length ? Math.max(...nums) : undefined;
    } else if (first && typeof first === "object") {
      const tryFields = ["ask", "bid", "price", "gold", "xau"];
      for (const f of tryFields) {
        const v = Number(first[f]);
        if (isFinite(v)) { p = v; break; }
      }
    }
  } else if (j && typeof j === "object") {
    if (Array.isArray(j.gold)) {
      p = Number(j.gold[0]);
    } else if (typeof j.price === "number") {
      p = j.price;
    }
  }
  if (!isFinite(p)) throw new Error("metals.live parse failed");
  return p;
}

async function getXAU() {
  try {
    return await getXAU_primary();
  } catch (e) {
    console.warn("XAU primary failed:", e.message);
    return await getXAU_fallback();
  }
}

exports.handler = async (event) => {
  try {
    const force = event?.queryStringParameters?.force === "1";
    const cached = readCache();
    if (!force && cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    const results = await Promise.allSettled([ getBTC(), getXAU() ]);
    const data = { btcUSD: null, xauUSD: null };
    const errors = {};

    if (results[0].status === "fulfilled") data.btcUSD = results[0].value;
    else errors.BTCUSD = String(results[0].reason?.message || results[0].reason || "unknown");

    if (results[1].status === "fulfilled") data.xauUSD = results[1].value;
    else errors.XAUUSD = String(results[1].reason?.message || results[1].reason || "unknown");

    if (!data.btcUSD && !data.xauUSD) {
      throw new Error(`both quotes failed: ${JSON.stringify(errors)}`);
    }

    const payload = { status: "ok", data, ...(Object.keys(errors).length ? { errors } : {}) };
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
