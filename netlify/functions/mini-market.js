// netlify/functions/mini-market.js
// BTC + XAU with multi-source fallbacks, caching, and debuggable output.

const fs = require("fs");
const CACHE_FILE = "/tmp/mini-market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};
const UA_HDRS = {
  "Accept": "application/json,text/*;q=0.9,*/*;q=0.8",
  "User-Agent": "cerfreport/1.0 (+https://thecerfreport.com)"
};

function readCache() {
  try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : null; }
  catch { return null; }
}
function writeCache(obj) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj)); } catch {}
}

async function withTimeout(url, ms, headers) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal, headers }); }
  finally { clearTimeout(t); }
}

async function getBTC_USD(debug) {
  // 1) Coingecko
  try {
    const r = await withTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", 8000, UA_HDRS);
    if (r.ok) {
      const j = await r.json();
      const v = j?.bitcoin?.usd;
      if (typeof v === "number" && isFinite(v)) { debug.btc = "coingecko"; return v; }
      debug.btc = "coingecko:bad";
    } else debug.btc = "coingecko:http" + r.status;
  } catch (e) { debug.btc = "coingecko:err"; }

  // 2) Yahoo
  try {
    const r = await withTimeout("https://query1.finance.yahoo.com/v7/finance/quote?symbols=BTC-USD", 8000, UA_HDRS);
    if (r.ok) {
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      const v = q?.regularMarketPrice;
      if (typeof v === "number" && isFinite(v)) { debug.btc = "yahoo:BTC-USD"; return v; }
      debug.btc = "yahoo:bad";
    } else debug.btc = "yahoo:http" + r.status;
  } catch (e) { debug.btc = "yahoo:err"; }

  return null;
}

async function getXAU_USD(debug) {
  // 1) Yahoo spot: XAUUSD=X
  try {
    const r = await withTimeout("https://query1.finance.yahoo.com/v7/finance/quote?symbols=XAUUSD=X", 8000, UA_HDRS);
    if (r.ok) {
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      const v = q?.regularMarketPrice;
      if (typeof v === "number" && isFinite(v)) { debug.xau = "yahoo:XAUUSD=X"; return v; }
      debug.xau = "yahoo:XAUUSD=X:bad";
    } else debug.xau = "yahoo:XAUUSD=X:http" + r.status;
  } catch { debug.xau = "yahoo:XAUUSD=X:err"; }

  // 2) Yahoo futures: GC=F
  try {
    const r = await withTimeout("https://query1.finance.yahoo.com/v7/finance/quote?symbols=GC=F", 8000, UA_HDRS);
    if (r.ok) {
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      const v = q?.regularMarketPrice;
      if (typeof v === "number" && isFinite(v)) { debug.xau = "yahoo:GC=F"; return v; }
      debug.xau = "yahoo:GC=F:bad";
    } else debug.xau = "yahoo:GC=F:http" + r.status;
  } catch { debug.xau = "yahoo:GC=F:err"; }

  // 3) exchangerate.host
  try {
    const r = await withTimeout("https://api.exchangerate.host/convert?from=XAU&to=USD", 8000, UA_HDRS);
    if (r.ok) {
      const j = await r.json();
      const v = j?.result;
      if (typeof v === "number" && isFinite(v)) { debug.xau = "xrhost:XAU>USD"; return v; }
      debug.xau = "xrhost:bad";
    } else debug.xau = "xrhost:http" + r.status;
  } catch { debug.xau = "xrhost:err"; }

  // 4) Coingecko PAXG (proxy 1oz)
  try {
    const r = await withTimeout("https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd", 8000, UA_HDRS);
    if (r.ok) {
      const j = await r.json();
      const v = j?.["pax-gold"]?.usd;
      if (typeof v === "number" && isFinite(v)) { debug.xau = "coingecko:paxg"; return v; }
      debug.xau = "coingecko:paxg:bad";
    } else debug.xau = "coingecko:paxg:http" + r.status;
  } catch { debug.xau = "coingecko:paxg:err"; }

  return null;
}

exports.handler = async (event) => {
  const wantDebug = event?.queryStringParameters?.debug === "1";
  const debug = {};

  try {
    const cached = readCache();            // { ts, payload }
    const prev = cached?.payload?.data;    // last good values

    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS && !wantDebug) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    const [btcNew, xauNew] = await Promise.all([ getBTC_USD(debug), getXAU_USD(debug) ]);

    const btcUSD = (typeof btcNew === "number" && isFinite(btcNew))
      ? btcNew
      : (typeof prev?.btcUSD === "number" && isFinite(prev.btcUSD) ? prev.btcUSD : null);

    const xauUSD = (typeof xauNew === "number" && isFinite(xauNew))
      ? xauNew
      : (typeof prev?.xauUSD === "number" && isFinite(prev.xauUSD) ? prev.xauUSD : null);

    const payload = { status: "ok", data: { btcUSD, xauUSD, links: {
      btc: "https://www.google.com/finance/quote/BTC-USD",
      xau: "https://www.google.com/finance/quote/XAU-USD"
    }}};

    if (wantDebug) payload.debug = debug;

    writeCache({ ts: Date.now(), payload });
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };

  } catch (e) {
    const cached = readCache();
    if (cached?.payload) {
      if (wantDebug) cached.payload.debug = { error: String(e?.message || e) };
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    const body = { status: "error", message: String(e?.message || e) };
    if (wantDebug) body.debug = debug;
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify(body) };
  }
};
