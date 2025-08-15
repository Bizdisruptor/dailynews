// netlify/functions/market-data.js
// Fetches market indices and quotes for specific stock tickers using the Finnhub API.

const FINNHUB_BASE = "https://finnhub.io/api/v1/quote";

// Define the tickers for indices and categorized stocks
// Using more reliable ETF symbols for indices.
const TICKERS = {
  indices: ['DIA', 'SPY', 'QQQ'], // DIA for Dow, SPY for S&P 500, QQQ for NASDAQ
  ai: ['NVDA', 'MSFT', 'GOOG', 'AMD'],
  crypto: ['COIN', 'MSTR', 'MARA', 'RIOT'], // Crypto-related stocks
  energy: ['XOM', 'CVX', 'SLB', 'OXY']
};

// A simple map for display names
const DISPLAY_NAMES = {
    'DIA': 'Dow Jones',
    'SPY': 'S&P 500',
    'QQQ': 'NASDAQ'
};

// Fetches a single quote from Finnhub
async function getQuote(ticker, apiKey) {
  const url = `${FINNHUB_BASE}?symbol=${ticker}&token=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Finnhub API failed for ${ticker} with status: ${response.status}`);
  }
  const data = await response.json();
  // Add the ticker and a display name to the response data
  return { ...data, ticker, name: DISPLAY_NAMES[ticker] || ticker };
}

export async function handler(event) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ status: "error", message: "Finnhub API key is not configured." })
    };
  }

  try {
    // Create a flat list of all unique tickers to fetch
    const allTickers = [...new Set([
        ...TICKERS.indices, 
        ...TICKERS.ai, 
        ...TICKERS.crypto, 
        ...TICKERS.energy
    ])];

    // Fetch all quotes in parallel for efficiency
    const quotePromises = allTickers.map(ticker => getQuote(ticker, apiKey));
    const allQuotes = await Promise.all(quotePromises);

    // Create a map for easy lookup
    const quoteMap = new Map(allQuotes.map(q => [q.ticker, q]));

    // Structure the final response
    const responseData = {
      indices: TICKERS.indices.map(ticker => quoteMap.get(ticker)),
      movers: {
        ai: TICKERS.ai.map(ticker => quoteMap.get(ticker)),
        crypto: TICKERS.crypto.map(ticker => quoteMap.get(ticker)),
        energy: TICKERS.energy.map(ticker => quoteMap.get(ticker))
      }
    };

    return {
      statusCode: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300" // Cache for 5 minutes
      },
      body: JSON.stringify({ status: "ok", data: responseData })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ status: "error", message: e.message })
    };
  }
}

