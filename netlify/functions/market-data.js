// CommonJS Netlify function
// Market data with robust fallbacks + dynamic "top movers" per sector.
// Order: Yahoo -> Stooq (CSV) -> last-good cache in /tmp.

const fs = require("fs");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";

// ----- Universes (we'll sort by biggest absolute % movers) -----
const AI_UNIVERSE = [
  "NVDA","MSFT","GOOG","AMD","AVGO","META","AAPL","TSLA","SMCI","ASML","MU","TSM"
];
const CRYPTO_UNIVERSE = [
  "COIN","MSTR","MARA","RIOT","CLSK","HUT","BITF","IREN","CIFR","WULF"
];
const ENERGY_UNIVERSE = [
  "XOM","CVX","SLB","OXY","COP","DVN","EOG","PXD","HAL","MRO","APA"
];

// Index symbols
const YAHOO_INDICES = [
  { sym: "^DJI",  name: "Dow Jones" },
  { sym: "^GSPC", name: "S&P 500"   },
  { sym: "^IXIC", name: "NASDAQ"    },
];
const ETF_FALLBACK = { "^DJI":"DIA", "^GSPC":"SPY", "^IXIC":"QQQ" }; // for Stooq

// ---------- Utils ----------
function isNum(v){ return typeof v === "number" && Number.isFinite(v); }
function num(x){ const n = +x; return Number.isFinite(n) ? n : null; }

function readCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE,"utf8")); } catch(_) {}
  return null;
}
function writeCache(obj) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj)); } catch(_) {}
}

// ---------- Providers ----------
async function yahooQuotes(symbols) {
  const url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + encodeURIComponent(symbols.join(","));
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "Accept": "application/json",
      "Referer": "https://finance.yahoo.com/"
    },
    redirect: "follow"
  });
  if (!r.ok) throw new Error("Yahoo HTTP " + r.status);
  const raw = await r.json();
  const arr = raw?.quoteResponse?.result || [];
  return arr.map(q => ({
    ticker: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    c: q.regularMarketPrice ?? null,
    d: q.regularMarketChange ?? null,
    dp: q.regularMarketChangePercent ?? null,
    currency: q.currency || q.financialCurrency || "",
    exchange: q.fullExchangeName || q.exchange || ""
  }));
}

// Stooq CSV fallback (.us suffix)
async function stooqQuotes(symbols) {
  if (!symbols.length) return [];
  const stooqSyms = symbols.map(s => s.toLowerCase() + ".us");
  const url = "https://stooq.com/q/l/?s=" + encodeURIComponent(stooqSyms.join(",")) + "&f=sd2t2ohlcv&h&e=csv";
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept":"text/csv" }});
  if (!r.ok) throw new Error("Stooq HTTP " + r.status);
  const text = await r.text();

  const [header, ...lines] = text.trim().split("\n");
  const cols = header.split(",").map(s => s.trim().toLowerCase());
  const idx = k => cols.indexOf(k);

  const out = [];
  for (const line of lines) {
    const p = line.split(",").map(s => s.trim());
    const sym = (p[idx("symbol")] || "").replace(".US","").toUpperCase();
    const close = num(p[idx("close")]);
    const open  = num(p[idx("open")]);
    const d  = (isNum(close) && isNum(open)) ? close - open : null;
    const dp = (isNum(d) && isNum(open) && open !== 0) ? (d/open)*100 : null;
    out.push({ ticker: sym, name: sym, c: close, d, dp, currency:"", exchange:"Stooq" });
  }
  return out;
}

// BTC (CoinGecko) with 24h change
async function getBTC() {
  try {
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
    const r = await fetch(url, { headers: { "Accept":"application/json","User-Agent":"Mozilla/5.0" }});
    if (!r.ok) throw new Error("CG " + r.status);
    const j = await r.json();
    const px = j?.bitcoin?.usd;
    const ch = j?.bitcoin?.usd_24h_change;
    if (!isNum(px)) throw new Error("no btc");
    const dp = isNum(ch) ? ch : null;
    const d = isNum(dp) ? (px * dp / 100) : null;
    return { ticker:"BTCUSD", name:"Bitcoin", c:px, d, dp };
  } catch(_) { return null; }
}

// Gold (XAU->USD). (We only show price; change often not reliable intraday here.)
async function getGold() {
  try {
    const r = await fetch("https://api.exchangerate.host/latest?base=XAU&symbols=USD",
      { headers: { "Accept":"application/json","User-Agent":"Mozilla/5.0" }});
    if (!r.ok) throw new Error("XAU " + r.status);
    const j = await r.json();
    const px = j?.rates?.USD;
    if (!isNum(px)) throw new Error("no gold");
    return { ticker:"XAUUSD", name:"Gold (XAU)", c:px, d:null, dp:null };
  } catch(_) { return null; }
}

// ---------- Build data ----------
function mapBy(arr, key="ticker") {
  const m = new Map();
  (arr || []).forEach(x => m.set(x[key], x));
  return m;
}

function topMovers(tickers, quoteMap, count=8) {
  const rows = [];
  for (const t of tickers) {
    const q = quoteMap.get(t);
    if (q && isNum(q.dp)) {
      rows.push({ ticker:t, c:q.c, d:q.d, dp:q.dp });
    }
  }
  rows.sort((a,b) => Math.abs(b.dp) - Math.abs(a.dp));
  return rows.slice(0, count);
}

async function getData() {
  // Gather symbols for Yahoo (include ^TNX for 10Y)
  const yahooSyms = [
    ...YAHOO_INDICES.map(i => i.sym),
    "^TNX",
    ...AI_UNIVERSE, ...CRYPTO_UNIVERSE, ...ENERGY_UNIVERSE,
  ];

  let yq = null;
  try { yq = await yahooQuotes(yahooSyms); }
  catch (_) { /* Yahoo blocked/401 etc. */ }

  const yMap = mapBy(yq || []);

  // For any *missing* equities, fetch via Stooq
  const missing = [];
  for (const t of [...AI_UNIVERSE, ...CRYPTO_UNIVERSE, ...ENERGY_UNIVERSE]) {
    if (!yMap.has(t)) missing.push(t);
  }
  // Index ETF stand-ins if Yahoo indices missing entirely
  const needEtfs = [];
  for (const idx of YAHOO_INDICES) {
    if (!yMap.has(idx.sym)) {
      const etf = ETF_FALLBACK[idx.sym];
      if (etf) needEtfs.push(etf);
    }
  }

  let sMap = new Map();
  if (missing.length || needEtfs.length) {
    const st = await stooqQuotes([...missing, ...needEtfs]);
    sMap = mapBy(st);
  }

  // Build indices row
  const indices = [];
  for (const idx of YAHOO_INDICES) {
    let q = yMap.get(idx.sym);
    if (!q) {
      const etf = ETF_FALLBACK[idx.sym];
      if (etf) q = sMap.get(etf);
    }
    if (q) indices.push({ name: idx.name, ticker: q.ticker, c:q.c, d:q.d, dp:q.dp });
  }

  // Add BTC and Gold
  const [btc, gold] = await Promise.all([getBTC(), getGold()]);
  if (btc) indices.push(btc);
  if (gold) indices.push(gold);

  // US 10Y if available via Yahoo (^TNX yields*10)
  const tnx = yMap.get("^TNX");
  if (tnx && isNum(tnx.c)) {
    indices.push({ ticker:"US10Y", name:"US 10Y", c: tnx.c/10, d: isNum(tnx.d)? tnx.d/10 : null, dp: tnx.dp });
  }

  // Build movers from biggest abs % change
  const quoteMap = new Map([...yMap, ...sMap]); // prefer Yahoo where present
  const movers = {
    ai:     topMovers(AI_UNIVERSE,     quoteMap, 8),
    crypto: topMovers(CRYPTO_UNIVERSE, quoteMap, 8),
    energy: topMovers(ENERGY_UNIVERSE, quoteMap, 8),
  };

  return { indices, movers };
}

// ---------- Handler ----------
exports.handler = async function () {
  try {
    const data = await getData();
    const hasSomething =
      (data.indices && data.indices.length) ||
      (data.movers && (data.movers.ai.length || data.movers.crypto.length || data.movers.energy.length));

    if (hasSomething) {
      const payload = { status:"ok", data, ts: Date.now() };
      writeCache(payload);
      return { statusCode:200, headers:HEADERS, body: JSON.stringify({ status:"ok", data, source:"live" }) };
    }

    const cached = readCache();
    if (cached && cached.status === "ok") {
      return { statusCode:200, headers:HEADERS, body: JSON.stringify({ status:"ok", data: cached.data, source:"cache" }) };
    }

    return { statusCode:500, headers:HEADERS, body: JSON.stringify({ status:"error", message:"No market data available" }) };
  } catch (e) {
    const cached = readCache();
    if (cached && cached.status === "ok") {
      return { statusCode:200, headers:HEADERS, body: JSON.stringify({ status:"ok", data: cached.data, source:"cache" }) };
    }
    return { statusCode:500, headers:HEADERS, body: JSON.stringify({ status:"error", message: e.message }) };
  }
};
