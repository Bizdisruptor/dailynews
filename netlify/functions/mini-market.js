// netlify/functions/mini-market.js
// Minimal server-side fetch for BTC-USD and XAU-USD with caching and timeouts.
// CommonJS; works on Netlify Functions (Node 18+).

const fs = require("fs");

const CACHE_FILE = "/tmp/mini-market-cache.json";
const TTL_MS = 1000 * 60 * 3; // cache 3 minutes
const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
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
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// ---------- Providers ----------
async function getBTC_USD() {
  // 1) Coingecko
  try {
    const r = await withTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", 8000);
    if (r.ok) {
      const j = await r.json();
      const v = j?.bitcoin?.usd;
      if (typeof v === "number" && isFinite(v)) return v;
    }
  } catch (_) {}

  // 2) Yahoo: BTC-USD
  try {
    const r = await withTimeout("https://query1.finance.yahoo.com/v7/finance/quote?symbols=BTC-USD", 8000);
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
    const r = await withTimeout("https://query1.finance.yahoo.com/v7/finance/quote?symbols=XAUUSD=X", 8000);
    if (r.ok) {
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      const v = q?.regularMarketPrice;
      if (typeof v === "number" && isFinite(v)) return v;
    }
  } catch (_) {}

  // 2) Yahoo gold futures (GC=F) as backup
  try {
    const r = await withTimeout("https://query1.finance.yahoo.com/v7/finance/quote?symbols=GC=F", 8000);
    if (r.ok) {
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      const v = q?.regularMarketPrice;
      if (typeof v === "number" && isFinite(v)) return v;
    }
  } catch (_) {}

  // 3) exchangerate.host conversion XAU -> USD (USD per troy ounce)
  try {
    const r = await withTimeout("https://api.exchangerate.host/convert?from=XAU&to=USD", 8000);
    if (r.ok) {
      const j = await r.json();
      const v = j?.result;
      if (typeof v === "number" && isFinite(v)) return v;
    }
  } catch (_) {}

  return null;
}

// ---------- Handler ----------
exports.handler = async () => {
  try {
    const cached = readCache();
    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    const [btcUSD, xauUSD] = await Promise.all([ getBTC_USD(), getXAU_USD() ]);

    const payload = {
      status: "ok",
      data: {
        btcUSD,
        xauUSD,
        links: {
          btc: "https://www.google.com/finance/quote/BTC-USD",
          xau: "https://www.google.com/finance/quote/XAU-USD",
        },
      },
    };

    writeCache({ ts: Date.now(), payload });
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    const cached = readCache();
    if (cached?.payload) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ status: "error", message: String(e?.message || e) }),
    };
  }
};
