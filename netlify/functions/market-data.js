// netlify/functions/market-data.js
// Round-robin providers: Finnhub (if key) -> Yahoo Finance -> /tmp cache
// No external packages required.

const YF_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const FINNHUB_URL = "https://finnhub.io/api/v1/quote";
const CACHE_PATH = "/tmp/market-cache.json";

// Buckets expected by the front-end
const TICKERS = {
  indices: ["DIA", "SPY", "QQQ"], // Dow (DIA), S&P 500 (SPY), NASDAQ (QQQ)
  ai: ["NVDA", "MSFT", "GOOG", "AMD", "SMCI"],
  crypto: ["COIN", "MSTR", "MARA", "RIOT", "CLSK"], // crypto-exposed equities
  energy: ["XOM", "CVX", "SLB", "OXY", "COP"]
};

const DISPLAY_NAMES = {
  DIA: "Dow Jones",
  SPY: "S&P 500",
  QQQ: "NASDAQ"
};

/* ----------------- tiny cache helpers (/tmp) ----------------- */
async function readCache() {
  try {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(CACHE_PATH, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function writeCache(obj) {
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(CACHE_PATH, JSON.stringify(obj));
  } catch {
    // ignore cache write errors
  }
}

/* ----------------- Providers ----------------- */
async function finnhubQuote(ticker, key) {
  const r = await fetch(`${FINNHUB_URL}?symbol=${encodeURIComponent(ticker)}&token=${key}`);
  if (!r.ok) throw new Error(`Finnhub ${ticker} ${r.status}`);
  const d = await r.json();

  // Finnhub fields: c=current, d=change, dp=%change
  if (d == null || d.c == null) throw new Error(`Finnhub empty ${ticker}`);

  return {
    ticker,
    name: DISPLAY_NAMES[ticker] || ticker,
    c: d.c,
    d: d.d ?? 0,
    dp: d.dp ?? 0
  };
}

async function yahooQuotes(symbols) {
  const url = `${YF_URL}?symbols=${encodeURIComponent(symbols.join(","))}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json"
    }
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const raw = await r.json();
  const rows = raw?.quoteResponse?.result || [];

  const map = new Map();
  for (const q of rows) {
    map.set(q.symbol, {
      ticker: q.symbol,
      name: DISPLAY_NAMES[q.symbol] || q.shortName || q.longName || q.symbol,
      c: q.regularMarketPrice ?? null,
      d: q.regularMarketChange ?? 0,
      dp: q.regularMarketChangePercent ?? 0
    });
  }
  return map;
}

/* ----------------- Response builder ----------------- */
function buildResponse(map) {
  const pick = (arr) => arr.map((t) => map.get(t)).filter(Boolean);
  return {
    indices: pick(TICKERS.indices),
    movers: {
      ai: pick(TICKERS.ai),
      crypto: pick(TICKERS.crypto),
      energy: pick(TICKERS.energy)
    }
  };
}

/* ----------------- Handler ----------------- */
export async function handler() {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  try {
    const all = [
      ...new Set([
        ...TICKERS.indices,
        ...TICKERS.ai,
        ...TICKERS.crypto,
        ...TICKERS.energy
      ])
    ];

    // 1) Finnhub first (if key present)
    const key = process.env.FINNHUB_API_KEY;
    if (key) {
      try {
        const results = await Promise.all(all.map((t) => finnhubQuote(t, key)));
        const map = new Map(results.map((r) => [r.ticker, r]));
        const data = buildResponse(map);
        await writeCache(data);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ status: "ok", data, source: "finnhub" })
        };
      } catch (e) {
        console.warn("Finnhub failed, falling back to Yahoo:", e.message);
      }
    }

    // 2) Yahoo fallback
    try {
      const map = await yahooQuotes(all);
      const data = buildResponse(map);
      await writeCache(data);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok", data, source: "yahoo" })
      };
    } catch (e) {
      console.warn("Yahoo failed, trying /tmp cache:", e.message);
    }

    // 3) /tmp cache last resort
    const cached = await readCache();
    if (cached) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok", data: cached, source: "cache" })
      };
    }

    // All providers failed
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ status: "error", message: "All market
