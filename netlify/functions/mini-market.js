// netlify/functions/mini-market.js
// Returns { btcUSD, xauUSD } with no API keys, cache 60s, ?force=1.
// BTC: Binance (US). XAU: exchangerate.host (invert) -> exchangerate.host convert -> goldprice.org fallback.

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
  const headers = { "Accept": "application/json,text/plain,*/*", "User-Agent": "NetlifyFunction/1.0" };
  return fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, signal: ctrl.signal })
    .finally(() => clearTimeout(id));
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
  const url = "https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD";
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`binance HTTP ${r.status}`);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const text = await r.text();
  if (!ct.includes("application/json")) throw new Error(`binance non-JSON: ${text.slice(0,80)}`);
  const j = JSON.parse(text);
  const p = Number(j?.price);
  if (!isFinite(p)) throw new Error("binance missing price");
  return p;
}

// --- helpers: safe JSON fetch that detects HTML blocks ---
async function getJsonOrThrow(url, name) {
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const text = await r.text();
  if (!ct.includes("application/json") && !text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    throw new Error(`${name} non-JSON: ${text.slice(0,80)}`);
  }
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${name} bad JSON: ${text.slice(0,80)}`); }
}

// --- XAU #1: exchangerate.host latest (USD->XAU inverted) ---
async function xauFromExHostLatest() {
  const j = await getJsonOrThrow("https://api.exchangerate.host/latest?base=USD&symbols=XAU&_ts=" + Date.now(), "exchangerate.latest");
  const rateXAUperUSD = j?.rates?.XAU; // XAU per 1 USD
  if (typeof rateXAUperUSD !== "number" || rateXAUperUSD === 0) throw new Error("latest missing/zero XAU");
  const usdPerXAU = 1 / rateXAUperUSD;
  if (!isFinite(usdPerXAU)) throw new Error("latest inversion invalid");
  return usdPerXAU;
}

// --- XAU #2: exchangerate.host convert (XAU->USD) ---
async function xauFromExHostConvert() {
  const j = await getJsonOrThrow("https://api.exchangerate.host/convert?from=XAU&to=USD&_ts=" + Date.now(), "exchangerate.convert");
  const p = j?.result;
  if (typeof p !== "number") throw new Error("convert missing result");
  return p;
}

// --- XAU #3: goldprice.org (unofficial JSON, but stable server-side) ---
async function xauFromGoldprice() {
  // This endpoint returns JSON like:
  // {"items":[{"curr":"USD","xauPrice":***, ...}]}
  const j = await getJsonOrThrow("https://data-asg.goldprice.org/dbXRates/USD?_ts=" + Date.now(), "goldprice");
  let p;
  if (j && Array.isArray(j.items) && j.items[0]) {
    const it = j.items[0];
    // Prefer explicit xauPrice if present, else compute from inverse (if provided)
    if (typeof it.xauPrice === "number") p = it.xauPrice;
    else if (typeof it.xau !== "undefined") {
      // sometimes xau is given; ensure it's USD per XAU
      const v = Number(it.xau);
      if (isFinite(v) && v > 0) p = v;
    }
  }
  if (!isFinite(p)) throw new Error("goldprice parse failed");
  return p;
}

async function getXAU() {
  try { return await xauFromExHostLatest(); }
  catch (e1) {
    console.warn("XAU primary failed:", e1.message);
    try { return await xauFromExHostConvert(); }
    catch (e2) {
      console.warn("XAU secondary failed:", e2.message);
      return await xauFromGoldprice(); // may still be blocked sometimes, but server-side usually ok
    }
  }
}

exports.handler = async (event) => {
  try {
    const force = event?.queryStringParameters?.force === "1";
    const cached = readCache();
    if (!force && cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    const [btcRes, xauRes] = await Promise.allSettled([ getBTC(), getXAU() ]);
    const data = { btcUSD: null, xauUSD: null };
    const errors = {};

    if (btcRes.status === "fulfilled") data.btcUSD = btcRes.value;
    else errors.BTCUSD = String(btcRes.reason?.message || btcRes.reason || "unknown");

    if (xauRes.status === "fulfilled") data.xauUSD = xauRes.value;
    else errors.XAUUSD = String(xauRes.reason?.message || xauRes.reason || "unknown");

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
