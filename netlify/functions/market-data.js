// CommonJS Netlify Function
// Robust market data: Yahoo -> Stooq -> /tmp cache (never blank the page).
// Also pulls BTC (CoinGecko), Gold (XAU->USD from exchangerate.host), and US 10Y (^TNX if Yahoo is up).

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/market-cache.json";

// Display groups
const GROUPS = {
  indices: [
    // For Yahoo
    { y: "^DJI", name: "Dow Jones" },
    { y: "^GSPC", name: "S&P 500" },
    { y: "^IXIC", name: "NASDAQ" },
  ],
  ai:  [
    { y: "NVDA", name: "NVDA" },
    { y: "MSFT", name: "MSFT" },
    { y: "GOOG", name: "GOOG" },
    { y: "AMD",  name: "AMD"  },
    { y: "AVGO", name: "AVGO" },
    { y: "META", name: "META" },
  ],
  cryptoStocks: [
    { y: "COIN", name: "COIN" },
    { y: "MSTR", name: "MSTR" },
    { y: "MARA", name: "MARA" },
    { y: "RIOT", name: "RIOT" },
    { y: "CLSK", name: "CLSK" },
  ],
  energy: [
    { y: "XOM", name: "XOM" },
    { y: "CVX", name: "CVX" },
    { y: "SLB", name: "SLB" },
    { y: "OXY", name: "OXY" },
    { y: "COP", name: "COP" },
  ],
};

// Helper: read/write cache
const fs = require("fs");
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (_) {}
  return null;
}
function writeCache(payload) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(payload)); } catch (_) {}
}

// ---------- Providers ----------

// Yahoo batch quotes
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

// Stooq CSV (fallback). US tickers require .us suffix.
async function stooqQuotes(symbols) {
  if (!symbols.length) return [];
  const stooqSyms = symbols.map(s => s.toLowerCase() + ".us");
  const url = "https://stooq.com/q/l/?s=" +
    encodeURIComponent(stooqSyms.join(",")) +
    "&f=sd2t2ohlcv&h&e=csv";

  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv" }});
  if (!r.ok) throw new Error("Stooq HTTP " + r.status);
  const text = await r.text();

  // Parse CSV (simple)
  const [headerLine, ...lines] = text.trim().split("\n");
  const cols = headerLine.split(",").map(s => s.trim().toLowerCase()); // symbol,date,time,open,high,low,close,volume
  const colIndex = k => cols.indexOf(k);

  const res = [];
  for (const line of lines) {
    const parts = line.split(",").map(s => s.trim());
    const s = parts[colIndex("symbol")] || "";
    const ticker = s.replace(".US", "").toUpperCase();
    const close = num(parts[colIndex("close")]);
    const open  = num(parts[colIndex("open")]);

    // Approximate change from open if prev close not available
    const d  = (isNum(close) && isNum(open)) ? (close - open) : null;
    const dp = (isNum(d) && isNum(open) && open !== 0) ? (d / open) * 100 : null;

    res.push({
      ticker,
      name: ticker,
      c: isNum(close) ? close : null,
      d,
      dp,
      currency: "",
      exchange: "Stooq"
    });
  }
  return res;
}

function isNum(v){ return typeof v === "number" && Number.isFinite(v); }
function num(x){ const n = +x; return Number.isFinite(n) ? n : null; }

// BTC (CoinGecko)
async function getBTC() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) throw new Error("CG " + r.status);
    const j = await r.json();
    const usd = j?.bitcoin?.usd;
    if (!isNum(usd)) throw new Error("no btc");
    return { ticker: "BTCUSD", name: "Bitcoin", c: usd, d: null, dp: null };
  } catch (_) {
    return null;
  }
}

// Gold using XAU→USD (1 troy oz priced in USD)
async function getGold() {
  try {
    const r = await fetch("https://api.exchangerate.host/latest?base=XAU&symbols=USD", {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) throw new Error("XAU " + r.status);
    const j = await r.json();
    const px = j?.rates?.USD;
    if (!isNum(px)) throw new Error("no gold");
    return { ticker: "XAUUSD", name: "Gold (XAU)", c: px, d: null, dp: null };
  } catch (_) {
    return null;
  }
}

// US 10Y via Yahoo ^TNX (yield*10). If Yahoo is down, we skip.
function tenYearFromYahoo(allQuotes) {
  const tnx = allQuotes.find(q => q.ticker === "^TNX");
  if (tnx && isNum(tnx.c)) {
    const y = tnx.c / 10; // ^TNX is yield*10
    const yd = isNum(tnx.d) ? tnx.d / 10 : null;
    const ydp = isNum(tnx.dp) ? tnx.dp : null; // already percent
    return { ticker: "US10Y", name: "US 10Y", c: y, d: yd, dp: ydp };
  }
  return null;
}

// ---------- Build response ----------

async function getData() {
  // Gather Yahoo batch list (includes ^TNX so we can try to show 10Y)
  const yahooSymbols = [
    ...GROUPS.indices.map(g => g.y),
    ...GROUPS.ai.map(g => g.y),
    ...GROUPS.cryptoStocks.map(g => g.y),
    ...GROUPS.energy.map(g => g.y),
    "^TNX"
  ];

  let yq = null;
  try {
    yq = await yahooQuotes(yahooSymbols);
  } catch (e) {
    // Yahoo failed; that's ok — we'll fall back for equities via Stooq
  }

  // Helper: get a record by ticker from Yahoo
  const yBy = (sym) => (yq || []).find(q => q.ticker === sym) || null;

  // If Yahoo failed entirely, fetch equities from Stooq
  let stooq = null;
  if (!yq || !yq.length) {
    const equities = [
      ...GROUPS.indices.map(g => g.y.replace("^DJI","DIA").replace("^GSPC","SPY").replace("^IXIC","QQQ")), // ETF stand-ins
      ...GROUPS.ai.map(g => g.y),
      ...GROUPS.cryptoStocks.map(g => g.y),
      ...GROUPS.energy.map(g => g.y),
    ];
    stooq = await stooqQuotes(equities);
  }
  const sBy = (sym) => (stooq || []).find(q => q.ticker === sym) || null;

  // Compose rows
  const indicesRows = [];
  for (const g of GROUPS.indices) {
    let row = yBy(g.y);
    // If Yahoo index is missing, map to ETF stand-ins from Stooq
    if (!row && stooq) {
      const map = g.y === "^DJI" ? "DIA" : g.y === "^GSPC" ? "SPY" : g.y === "^IXIC" ? "QQQ" : null;
      row = map ? sBy(map) : null;
      if (row) row.name = g.name;
    }
    if (row) indicesRows.push({ name: g.name, ticker: row.ticker, c: row.c, d: row.d, dp: row.dp });
  }

  // Top banner additions
  const btc = await getBTC();
  if (btc) indicesRows.push(btc);
  const gold = await getGold();
  if (gold) indicesRows.push(gold);
  // 10Y if Yahoo worked
  if (yq && yq.length) {
    const ten = tenYearFromYahoo(yq);
    if (ten) indicesRows.push(ten);
  }

  const toMover = (sym, label) => {
    const q = yBy(sym) || sBy(sym);
    return q ? { ticker: label, c: q.c, d: q.d, dp: q.dp } : null;
  };

  const movers = {
    ai: GROUPS.ai.map(g => toMover(g.y, g.name)).filter(Boolean),
    crypto: GROUPS.cryptoStocks.map(g => toMover(g.y, g.name)).filter(Boolean),
    energy: GROUPS.energy.map(g => toMover(g.y, g.name)).filter(Boolean),
  };

  return { indices: indicesRows, movers };
}

// ---------- Handler ----------

exports.handler = async function () {
  try {
    const data = await getData();

    // If we got at least something, cache & return
    if ((data.indices && data.indices.length) || (data.movers && (
        data.movers.ai.length || data.movers.crypto.length || data.movers.energy.length))) {
      writeCache({ status: "ok", data, ts: Date.now() });
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", data, source: "live" }) };
    }

    // Otherwise, serve cache if present
    const cached = readCache();
    if (cached && cached.status === "ok") {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", data: cached.data, source: "cache" }) };
    }

    // Nothing at all
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: "No market data available" }) };
  } catch (e) {
    // On error, try cache
    const cached = readCache();
    if (cached && cached.status === "ok") {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", data: cached.data, source: "cache" }) };
    }
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: e.message }) };
  }
};
