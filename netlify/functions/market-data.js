// netlify/functions/market-data.js
// CommonJS version (works on Netlify without "type": "module").
// Fetches quotes from Yahoo Finance (no API key) and normalizes to:
//  indices: [{ ticker, name, c, d, dp }]
//  movers: { ai: [...], crypto: [...], energy: [...] }

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

// Choose ETFs for indices so we don't need the ^ symbols
const GROUPS = {
  indices: ["SPY", "DIA", "QQQ"],                       // S&P 500, Dow, Nasdaq 100
  ai: ["NVDA", "MSFT", "GOOGL", "AMD", "SMCI", "AVGO", "PLTR"],
  crypto: ["BTC-USD", "ETH-USD", "COIN", "MSTR", "MARA", "RIOT"],
  energy: ["XOM", "CVX", "SLB", "OXY", "COP"]
};

// Optional nicer display names for indices
const DISPLAY_NAMES = {
  SPY: "S&P 500 (SPY)",
  DIA: "Dow (DIA)",
  QQQ: "Nasdaq 100 (QQQ)"
};

async function fetchYahooQuotes(symbolsCsv) {
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
    encodeURIComponent(symbolsCsv);

  const r = await fetch(url, {
    headers: {
      // Yahoo is friendlier with a browser User-Agent + Accept
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json"
    }
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(text.slice(0, 400));
  }

  const json = JSON.parse(text);
  return json.quoteResponse?.result || [];
}

function normalizeQuote(q) {
  return {
    ticker: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    c: q.regularMarketPrice ?? null,
    d: q.regularMarketChange ?? null,
    dp: q.regularMarketChangePercent ?? null
  };
}

function pickGroup(map, arr) {
  // Keep the original ticker + allow display name override for indices
  return arr
    .map((sym) => {
      const q = map.get(sym);
      if (!q) return null;
      return {
        ...q,
        ticker: sym,
        name: DISPLAY_NAMES[sym] || q.name || sym
      };
    })
    .filter(Boolean);
}

exports.handler = async function handler() {
  try {
    // Build a unique symbol list across all groups
    const allSymbols = [
      ...new Set(Object.values(GROUPS).flat())
    ].join(",");

    // Fetch quotes once, then split into groups
    const results = await fetchYahooQuotes(allSymbols);

    const bySymbol = new Map();
    for (const q of results) {
      bySymbol.set(q.symbol, normalizeQuote(q));
    }

    const data = {
      indices: pickGroup(bySymbol, GROUPS.indices),
      movers: {
        ai: pickGroup(bySymbol, GROUPS.ai),
        crypto: pickGroup(bySymbol, GROUPS.crypto),
        energy: pickGroup(bySymbol, GROUPS.energy)
      }
    };

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ status: "ok", data })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ status: "error", message: e.message })
    };
  }
};
