// netlify/functions/market-data.js
// Fetches market data and caches the last successful result using Netlify Blobs.
import { getStore } from "@netlify/blobs";

const FINNHUB_BASE = "https://finnhub.io/api/v1/quote";

const TICKERS = {
  indices: ['DIA', 'SPY', 'QQQ'], // DIA for Dow, SPY for S&P 500, QQQ for NASDAQ
  ai: ['NVDA', 'MSFT', 'GOOG', 'AMD', 'SMCI'],
  crypto: ['COIN', 'MSTR', 'MARA', 'RIOT', 'CLSK'],
  energy: ['XOM', 'CVX', 'SLB', 'OXY', 'COP']
};

const DISPLAY_NAMES = {
    'DIA': 'Dow Jones',
    'SPY': 'S&P 500',
    'QQQ': 'NASDAQ'
};

async function getQuote(ticker, apiKey) {
  const url = `${FINNHUB_BASE}?symbol=${ticker}&token=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Finnhub API failed for ${ticker} with status: ${response.status}`);
  }
  const data = await response.json();
  if (data.d === null) { // Finnhub returns nulls for failed lookups
    throw new Error(`No data returned for ticker: ${ticker}`);
  }
  return { ...data, ticker, name: DISPLAY_NAMES[ticker] || ticker };
}

export async function handler(event) {
  const apiKey = process.env.FINNHUB_API_KEY;
  const cache = getStore('market-data-cache');

  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ status: "error", message: "Finnhub API key is not configured." }) };
  }

  try {
    const allTickers = [...new Set([...TICKERS.indices, ...TICKERS.ai, ...TICKERS.crypto, ...TICKERS.energy])];
    const quotePromises = allTickers.map(ticker => getQuote(ticker, apiKey));
    const allQuotes = await Promise.all(quotePromises);

    const quoteMap = new Map(allQuotes.map(q => [q.ticker, q]));
    const responseData = {
      indices: TICKERS.indices.map(ticker => quoteMap.get(ticker)),
      movers: {
        ai: TICKERS.ai.map(ticker => quoteMap.get(ticker)),
        crypto: TICKERS.crypto.map(ticker => quoteMap.get(ticker)),
        energy: TICKERS.energy.map(ticker => quoteMap.get(ticker))
      }
    };

    // If fetch was successful, save to cache
    await cache.set('last-market-data', responseData);
    console.log("Successfully fetched live market data and updated cache.");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ status: "ok", data: responseData, source: 'live' })
    };
  } catch (e) {
    console.warn(`Live market data fetch failed: ${e.message}. Attempting to serve from cache.`);
    // If live fetch fails, try to serve from cache
    const cachedData = await cache.get('last-market-data', { type: 'json' });
    if (cachedData) {
      console.log("Serving stale market data from cache.");
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ status: "ok", data: cachedData, source: 'cache' })
      };
    }

    // If cache is also empty, return an error
    console.error("Cache is empty. No market data to serve.");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ status: "error", message: "All market data sources are unavailable." })
    };
  }
}
