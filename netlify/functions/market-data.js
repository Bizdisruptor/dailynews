// netlify/functions/market-data.js
// CommonJS – Yahoo Finance (no API key). Adds a "macro" row and bigger groups.
// Response shape:
// { status:"ok", data: { macro:[...], indices:[...], movers:{ ai:[...], crypto:[...], energy:[...] } } }

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// Use ETFs for broad indices (avoid CFD/restricted ^ symbols for those).
// It's fine to use ^ for things like 10Y (^TNX) and VIX (^VIX).
const GROUPS = {
  macro: [
    "BTC-USD", // Bitcoin
    "GC=F",    // Gold futures
    "CL=F",    // WTI crude oil
    "^TNX",    // 10-year Treasury yield (x10)
    "^VIX",    // Volatility Index
    "DX=F"     // U.S. Dollar Index (futures)
  ],
  indices: ["SPY", "DIA", "QQQ"], // S&P 500, Dow, Nasdaq 100 via ETFs
  ai: [
    "NVDA", "MSFT", "GOOGL", "AMD", "SMCI", "AVGO", "PLTR", "META",
    "AAPL", "AMZN", "TSLA"
  ],
  crypto: [
    "BTC-USD", "ETH-USD", "SOL-USD",
    "COIN", "MSTR", "MARA", "RIOT", "CLSK"
  ],
  energy: [
    "XOM", "CVX", "SLB", "OXY", "COP", "HAL", "BP", "SHEL"
  ],
};

const DISPLAY_NAMES = {
  // Macro nice names
  "BTC-USD": "Bitcoin",
  "GC=F": "Gold (Fut)",
  "CL=F": "WTI Crude",
  "^TNX": "US 10Y",
  "^VIX": "VIX",
  "DX=F": "US Dollar",
  // Indices
  SPY: "S&P 500 (SPY)",
  DIA: "Dow (DIA)",
  QQQ: "Nasdaq 100 (QQQ)",
};

async function fetchYahooQuotes(symbolsCsv) {
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
    encodeURIComponent(symbolsCsv);

  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json",
    },
  });

  const text = await r.text();
  if (!r.ok) throw new Error(text.slice(0, 400));
  const json = JSON.parse(text);
  return json.quoteResponse?.result || [];
}

function normalizeQuote(q) {
  return {
    ticker: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    c: q.regularMarketPrice ?? null,
    d: q.regularMarketChange ?? null,
    dp: q.regularMarketChangePercent ?? null,
  };
}

function pickGroup(map, arr) {
  return arr
    .map((sym) => {
      const q = map.get(sym);
      if (!q) return null;
      return {
        ...q,
        ticker: sym,
        name: DISPLAY_NAMES[sym] || q.name || sym,
      };
    })
    .filter(Boolean);
}

exports.handler = async function handler() {
  try {
    const allSymbols = [
      ...new Set(Object.values(GROUPS).flat()),
    ].join(",");

    const results = await fetchYahooQuotes(allSymbols);
    const bySymbol = new Map();
    for (const q of results) bySymbol.set(q.symbol, normalizeQuote(q));

    const data = {
      macro: pickGroup(bySymbol, GROUPS.macro),
      indices: pickGroup(bySymbol, GROUPS.indices),
      movers: {
        ai: pickGroup(bySymbol, GROUPS.ai),
        crypto: pickGroup(bySymbol, GROUPS.crypto),
        energy: pickGroup(bySymbol, GROUPS.energy),
      },
    };

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ status: "ok", data }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ status: "error", message: e.message }),
    };
  }
};
