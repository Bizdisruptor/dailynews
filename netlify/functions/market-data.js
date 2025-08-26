// netlify/functions/market-data.js
// Market data via Yahoo Finance (no API key) + CoinGecko (BTC).
// Uses https (no global fetch needed), caches to /tmp, and never hard-fails the shape.

const fs = require("fs");
const https = require("https");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const REQ_TIMEOUT = 8000;

/* ===== Symbols ===== */
const INDICES = [
  { t: "^DJI",  name: "Dow Jones" },
  { t: "^GSPC", name: "S&P 500" },
  { t: "^IXIC", name: "Nasdaq" }, // switch to ^NDX for Nasdaq-100 if you prefer
];

const MACRO = [
  { t: "BTCUSD",   name: "Bitcoin" },         // CoinGecko
  { t: "XAUUSD=X", name: "Gold (Spot)" },     // Yahoo
  { t: "IEF",      name: "US Treasuries 7–10Y (IEF)" }, // Yahoo (ETF proxy)
];

const GROUPS = {
  ai:     ["NVDA","MSFT","GOOGL","AMZN","META","TSLA","AVGO","AMD","SMCI","PLTR","ASML","MU","TSM"],
  crypto: ["COIN","MSTR","MARA","RIOT","CLSK","HUT","BITF","IREN","CIFR","WULF"],
  energy: ["XOM","CVX","SLB","OXY","COP","DVN","EOG","PXD","HAL","MRO","APA"],
};

/* ===== Utils ===== */
function toNum(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

function httpsGet(url, headers = {}, tag = "request") {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method: "GET",
      hostname: u.hostname,
      path: u.pathname + (u.search || ""),
      headers: { "Accept": "application/json", "User-Agent": "cerfreport/1.0", ...headers },
      timeout: REQ_TIMEOUT
    };
    const req = https.request(opts, (res) => {
      const { statusCode } = res;
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`${tag} HTTP ${statusCode}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`${tag} JSON parse error: ${e.message}`)); }
      });
    });
    req.on("error", (e) => reject(new Error(`${tag} ${e.message}`)));
    req.on("timeout", () => { req.destroy(new Error(`${tag} timeout ${REQ_TIMEOUT}ms`)); });
    req.end();
  });
}

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}
function writeCache(payload) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), payload })); } catch {}
}

function toMap(arr) { const m = new Map(); (arr||[]).forEach(x => x?.ticker && m.set(x.ticker, x)); return m; }
function topMoversFromUniverse(universe, map, count=10) {
  const rows = [];
  for (const t of universe) {
    const q = map.get(t);
    if (q && Number.isFinite(q.dp)) rows.push({ ticker: t, c: q.c, d: q.d, dp: q.dp });
  }
  rows.sort((a,b) => Math.abs(b.dp) - Math.abs(a.dp));
  return rows.slice(0, count);
}

/* ===== Providers (keyless) ===== */
async function yahooBatch(symbols) {
  if (!symbols.length) return [];
  const list = symbols.map(s => encodeURIComponent(s)).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${list}`;
  const data = await httpsGet(url, {}, "yahoo:batch");
  const results = data?.quoteResponse?.result || [];
  return results.map(r => ({
    ticker: r.symbol,
    name: r.shortName || r.longName || r.symbol,
    c: toNum(r.regularMarketPrice),
    d: toNum(r.regularMarketChange),
    dp: toNum(r.regularMarketChangePercent)
  }));
}

async function coingeckoBTC() {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
  const data = await httpsGet(url, {}, "coingecko:btc");
  const price = toNum(data?.bitcoin?.usd);
  const changePct = toNum(data?.bitcoin?.usd_24h_change);
  const changeAbs = price != null && changePct != null ? price * (changePct / 100) : null;
  return { ticker: "BTCUSD", name: "Bitcoin", c: price, d: changeAbs, dp: changePct };
}

/* ===== Handler ===== */
exports.handler = async function() {
  try {
    // serve fresh cache
    const cached = readCache();
    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    // Fetch macro & indices
    const btcP = coingeckoBTC();
    const ySymbols = ["XAUUSD=X", "IEF", ...INDICES.map(x => x.t)];
    const yP = yahooBatch(ySymbols);

    // Fetch movers (Yahoo)
    const aiP     = yahooBatch(GROUPS.ai);
    const cryptoP = yahooBatch(GROUPS.crypto);
    const energyP = yahooBatch(GROUPS.energy);

    const [btc, yAll, aiRaw, cryptoRaw, energyRaw] = await Promise.all([btcP, yP, aiP, cryptoP, energyP]);

    const yMap = toMap(yAll);

    // Indices
    const indices = INDICES
      .map(x => {
        const q = yMap.get(x.t);
        return q ? { ...q, name: x.name } : null;
        })
      .filter(Boolean);

    // Macro: BTC + Gold spot + IEF
    const gold = yMap.get("XAUUSD=X");
    const ief  = yMap.get("IEF");
    const macro = [btc, gold && { ...gold, name: "Gold (Spot)" }, ief && { ...ief, name: "US Treasuries 7–10Y (IEF)" }]
      .filter(Boolean);

    // Movers
    const allForMap = [...indices, ...macro, ...aiRaw, ...cryptoRaw, ...energyRaw];
    const qMap = toMap(allForMap);
    const ai     = topMoversFromUniverse(GROUPS.ai, qMap, 10);
    const crypto = topMoversFromUniverse(GROUPS.crypto, qMap, 10);
    const energy = topMoversFromUniverse(GROUPS.energy, qMap, 10);

    const payload = { status: "ok", data: { macro, indices, ai, crypto, energy, movers: { ai, crypto, energy } } };
    writeCache(payload);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    console.error("market-data error:", e.message);
    const cached = readCache();
    if (cached?.payload) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    // Soft fallback so UI still renders something
    const payload = { status: "ok", data: { macro: [], indices: [], ai: [], crypto: [], energy: [], movers: { ai:[], crypto:[], energy:[] } }, note: e.message };
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  }
};
