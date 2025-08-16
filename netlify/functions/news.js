// netlify/functions/news.js
// Fetches news from multiple APIs and caches the last successful result.
const fs = require("fs");
const fetch = require("node-fetch"); // ✅ FIX: Added the required fetch library.

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

// --- API Configurations ---
const APIS = [
  { name: 'NewsAPI', fetcher: fetchFromNewsAPI, transformer: (article) => article },
  { name: 'GNews', fetcher: fetchFromGNews, transformer: transformGNewsArticle },
  { name: 'Newsdata.io', fetcher: fetchFromNewsdata, transformer: transformNewsdataArticle },
];
const FINANCE_FALLBACK = { name: 'Finnhub', fetcher: fetchFromFinnhub, transformer: transformFinnhubArticle };

// --- Caching Utilities ---
function readCache(section) {
  const cacheFile = `/tmp/news-cache-${section}.json`;
  try {
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch (_) {}
  return null;
}
function writeCache(section, articles) {
  const cacheFile = `/tmp/news-cache-${section}.json`;
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(articles));
  } catch (_) {}
}

// --- Fetcher and Transformer Functions ---
async function fetchFromNewsAPI(section) {
  const NEWSAPI_BASE = "https://newsapi.org/v2";
  const NEWSAPI_CONFIG = {
    world: { endpoint: "top-headlines", params: { language: "en", pageSize: 15, sources: "associated-press,reuters,bbc-news" }},
    tech: { endpoint: "top-headlines", params: { language: "en", pageSize: 12, sources: "techcrunch,the-verge,engadget,axios,ars-technica" }},
    finance: { endpoint: "everything", params: { language: "en", sortBy: "publishedAt", pageSize: 12, q: "(stocks OR markets OR bonds OR inflation OR fed OR earnings)", domains: "reuters.com,cnbc.com,marketwatch.com,barrons.com,wsj.com,fortune.com,financialpost.com"}},
    frontpage: { endpoint: "everything", params: { language: "en", sortBy: "publishedAt", pageSize: 18, q: "(election OR border OR crime OR war OR trade OR tariffs OR immigration OR protest OR courts)", domains: "reuters.com,apnews.com,bbc.com,cnbc.com,nypost.com,wsj.com,abcnews.go.com,nbcnews.com,foxnews.com,newsweek.com"}}
  };
  const cfg = NEWSAPI_CONFIG[section] || NEWSAPI_CONFIG.world;
  const url = new URL(`${NEWSAPI_BASE}/${cfg.endpoint}`);
  for (const [k, v] of Object.entries(cfg.params)) {
    if (v) url.searchParams.set(k, v);
  }
  const response = await fetch(url.toString(), { headers: { "X-Api-Key": process.env.NEWSAPI_KEY } });
  if (!response.ok) throw new Error(`Status: ${response.status}`);
  const data = await response.json();
  if (data.status !== 'ok' || data.totalResults === 0) throw new Error(data.message || 'No articles found');
  return data.articles;
}

function transformGNewsArticle(article) { return { title: article.title, description: article.description, url: article.url, publishedAt: article.publishedAt }; }
async function fetchFromGNews(section) {
  const GNEWS_CATEGORY_MAP = { world: 'world', tech: 'technology', finance: 'business', frontpage: 'general' };
  const category = GNEWS_CATEGORY_MAP[section] || 'general';
  const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&max=15&apikey=${process.env.GNEWS_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Status: ${response.status}`);
  const data = await response.json();
  if (!data.articles || data.articles.length === 0) throw new Error('No articles found');
  return data.articles;
}

function transformNewsdataArticle(article) { return { title: article.title, description: article.description, url: article.link, publishedAt: article.pubDate }; }
async function fetchFromNewsdata(section) {
    const NEWSDATA_CATEGORY_MAP = { world: 'world', tech: 'technology', finance: 'business', frontpage: 'top' };
    const category = NEWSDATA_CATEGORY_MAP[section] || 'top';
    const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_KEY}&language=en&category=${category}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Status: ${response.status}`);
    const data = await response.json();
    if (data.status !== 'success' || !data.results || data.results.length === 0) throw new Error('No articles found');
    return data.results;
}

function transformFinnhubArticle(article) { return { title: article.headline, description: article.summary, url: article.url, publishedAt: new Date(article.datetime * 1000).toISOString() }; }
async function fetchFromFinnhub() {
  const url = `https://finnhub.io/api/v1/news?category=general&token=${process.env.FINNHUB_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Status: ${response.status}`);
  const data = await response.json();
  if (!data || data.length === 0) throw new Error('No articles found');
  return data.slice(0, 15);
}

// --- Main Handler ---
exports.handler = async function(event) {
  const section = (event.queryStringParameters?.section || "world").toLowerCase();

  for (const api of APIS) {
    try {
      console.log(`Attempting to fetch '${section}' from ${api.name}...`);
      const rawArticles = await api.fetcher(section);
      const articles = rawArticles.map(api.transformer);
      writeCache(section, articles);
      console.log(`Successfully fetched from ${api.name} and updated cache for '${section}'.`);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", articles, source: api.name }) };
    } catch (error) {
      console.warn(`${api.name} failed for '${section}': ${error.message}. Trying next...`);
    }
  }

  if (section === 'finance') {
    try {
      console.log("Trying Finnhub as final fallback for 'finance'...");
      const rawArticles = await FINANCE_FALLBACK.fetcher();
      const articles = rawArticles.map(FINANCE_FALLBACK.transformer);
      writeCache(section, articles);
      console.log(`Successfully fetched from Finnhub and updated cache for '${section}'.`);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", articles, source: FINANCE_FALLBACK.name }) };
    } catch (finnhubError) {
      console.error(`Finnhub fallback also failed: ${finnhubError.message}`);
    }
  }

  console.log(`All APIs failed for '${section}'. Attempting to load from cache.`);
  const cachedArticles = readCache(section);
  if (cachedArticles) {
    console.log(`Successfully loaded ${cachedArticles.length} articles from cache for '${section}'.`);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", articles: cachedArticles, source: 'cache' }) };
  }

  console.error(`Cache is empty for '${section}'. No data to serve.`);
  return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: "All news sources are currently unavailable." }) };
};
