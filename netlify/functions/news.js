// netlify/functions/news.js
// Fetches news from APIs and caches the last successful result using Netlify Blobs.
import { getStore } from "@netlify/blobs";

// --- Primary Source: NewsAPI Configuration ---
const NEWSAPI_BASE = "https://newsapi.org/v2";
const NEWSAPI_CONFIG = {
  world: {
    endpoint: "top-headlines",
    params: { language: "en", pageSize: 15, sources: "associated-press,reuters,bbc-news" }
  },
  tech: {
    endpoint: "top-headlines",
    params: { language: "en", pageSize: 12, sources: "techcrunch,the-verge,engadget,axios,ars-technica" }
  },
  finance: {
    endpoint: "everything",
    params: {
      language: "en",
      sortBy: "publishedAt",
      pageSize: 12,
      q: "(stocks OR markets OR bonds OR inflation OR fed OR earnings)",
      domains: "reuters.com,cnbc.com,marketwatch.com,barrons.com,wsj.com,fortune.com,financialpost.com",
      excludeDomains: "biztoc.com,the-sun.com,dailyexpress.co.uk"
    }
  },
  frontpage: {
    endpoint: "everything",
    params: {
      language: "en",
      sortBy: "publishedAt",
      pageSize: 18,
      q: "(election OR border OR crime OR war OR trade OR tariffs OR immigration OR protest OR courts)",
      domains: "reuters.com,apnews.com,bbc.com,cnbc.com,nypost.com,wsj.com,abcnews.go.com,nbcnews.com,foxnews.com,newsweek.com",
      excludeDomains: "biztoc.com,the-sun.com,mirror.co.uk"
    }
  }
};

async function fetchFromNewsAPI(section) {
  const cfg = NEWSAPI_CONFIG[section] || NEWSAPI_CONFIG.world;
  const url = new URL(`${NEWSAPI_BASE}/${cfg.endpoint}`);
  for (const [k, v] of Object.entries(cfg.params)) {
    if (v) url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString(), {
    headers: { "X-Api-Key": process.env.NEWSAPI_KEY }
  });

  if (!response.ok) {
    throw new Error(`NewsAPI failed with status: ${response.status}`);
  }
  const data = await response.json();
  if (data.status !== 'ok' || data.totalResults === 0) {
      throw new Error(`NewsAPI returned an error or no articles: ${data.message || 'No articles found'}`);
  }
  return data.articles;
}


// --- Fallback Source: GNews Configuration ---
const GNEWS_BASE = "https://gnews.io/api/v4/top-headlines";
const GNEWS_CATEGORY_MAP = {
    world: 'world',
    tech: 'technology',
    finance: 'business',
    frontpage: 'general'
};

function transformGNewsArticle(article) {
    return {
        title: article.title,
        description: article.description,
        url: article.url,
        publishedAt: article.publishedAt
    };
}

async function fetchFromGNews(section) {
    const category = GNEWS_CATEGORY_MAP[section] || 'general';
    const url = new URL(GNEWS_BASE);
    url.searchParams.set('category', category);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('max', 15);
    url.searchParams.set('apikey', process.env.GNEWS_API_KEY);

    const response = await fetch(url.toString());
    if (!response.ok) {
        throw new Error(`GNews failed with status: ${response.status}`);
    }
    const data = await response.json();
    if (!data.articles || data.articles.length === 0) {
        throw new Error('GNews returned no articles.');
    }
    return data.articles.map(transformGNewsArticle);
}

// --- Second Fallback: Webz.io Configuration ---
const WEBZIO_BASE = "https://api.webz.io/newsApiLite";
const WEBZIO_QUERY_MAP = {
    world: '(world OR global)',
    tech: '(technology OR tech)',
    finance: '(finance OR business OR markets)',
    frontpage: '(breaking OR "top stories")'
};

function transformWebzArticle(post) {
    return {
        title: post.title,
        description: post.text.slice(0, 200) + '...',
        url: post.url,
        publishedAt: post.published
    };
}

async function fetchFromWebz(section) {
    const query = WEBZIO_QUERY_MAP[section] || 'news';
    const url = new URL(WEBZIO_BASE);
    url.searchParams.set('token', process.env.WEBZIO_API_KEY);
    url.searchParams.set('q', query);
    
    const response = await fetch(url.toString());
    if (!response.ok) {
        throw new Error(`Webz.io failed with status: ${response.status}`);
    }
    const data = await response.json();
    if (!data.posts || data.posts.length === 0) {
        throw new Error('Webz.io returned no articles.');
    }
    return data.posts.map(transformWebzArticle);
}

// --- Third Fallback: Polygon.io Configuration ---
const POLYGON_BASE = "https://api.polygon.io/v2/reference/news";

function transformPolygonArticle(article) {
    return {
        title: article.title,
        description: article.description,
        url: article.article_url,
        publishedAt: article.published_utc
    };
}

async function fetchFromPolygon() {
    const url = new URL(POLYGON_BASE);
    url.searchParams.set('limit', 20);
    url.searchParams.set('apiKey', process.env.POLYGON_API_KEY);

    const response = await fetch(url.toString());
    if (!response.ok) {
        throw new Error(`Polygon.io failed with status: ${response.status}`);
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
        throw new Error('Polygon.io returned no articles.');
    }
    return data.results.map(transformPolygonArticle);
}


// --- Fourth Fallback: Finnhub Configuration (for Finance only) ---
const FINNHUB_BASE = "https://finnhub.io/api/v1/news";

function transformFinnhubArticle(article) {
    return {
        title: article.headline,
        description: article.summary,
        url: article.url,
        publishedAt: new Date(article.datetime * 1000).toISOString()
    };
}

async function fetchFromFinnhub() {
    const url = new URL(FINNHUB_BASE);
    url.searchParams.set('category', 'general');
    url.searchParams.set('token', process.env.FINNHUB_API_KEY);

    const response = await fetch(url.toString());
    if (!response.ok) {
        throw new Error(`Finnhub failed with status: ${response.status}`);
    }
    const data = await response.json();
    if (!data || data.length === 0) {
        throw new Error('Finnhub returned no articles.');
    }
    return data.slice(0, 15).map(transformFinnhubArticle);
}


// --- Main Handler with Fallback and Caching Logic ---
export async function handler(event) {
  const section = (event.queryStringParameters?.section || "world").toLowerCase();
  const cache = getStore('news-cache');

  let articles;
  let source = 'unknown';

  try {
    articles = await fetchFromNewsAPI(section);
    source = 'NewsAPI';
  } catch (primaryError) {
    console.warn(`Primary source (NewsAPI) failed for '${section}': ${primaryError.message}. Trying GNews...`);
    try {
      articles = await fetchFromGNews(section);
      source = 'GNews';
    } catch (gnewsError) {
      console.warn(`GNews fallback also failed for '${section}': ${gnewsError.message}. Trying Webz.io...`);
      try {
        articles = await fetchFromWebz(section);
        source = 'Webz.io';
      } catch (webzError) {
        console.warn(`Webz.io fallback also failed for '${section}': ${webzError.message}. Trying Polygon.io...`);
        try {
            articles = await fetchFromPolygon();
            source = 'Polygon.io';
        } catch (polygonError) {
            console.warn(`Polygon.io fallback also failed for '${section}': ${polygonError.message}.`);
            if (section === 'finance') {
              console.log("Trying Finnhub as final fallback for 'finance'...");
              try {
                articles = await fetchFromFinnhub();
                source = 'Finnhub';
              } catch (finnhubError) {
                console.error(`All API sources failed for '${section}'. Attempting to load from cache.`);
                return await loadFromCache(cache, section, finnhubError);
              }
            } else {
                console.error(`All API sources failed for '${section}'. Attempting to load from cache.`);
                return await loadFromCache(cache, section, polygonError);
            }
        }
      }
    }
  }

  // If we successfully fetched from any API, save the result to the cache
  if (articles && articles.length > 0) {
    await cache.set(`${section}-articles`, articles);
    console.log(`Successfully fetched ${articles.length} articles from ${source} and updated cache for '${section}'.`);
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ status: "ok", articles, source })
  };
}

async function loadFromCache(cache, section, finalError) {
    const cachedArticles = await cache.get(`${section}-articles`, { type: 'json' });
    if (cachedArticles) {
        console.log(`Successfully loaded ${cachedArticles.length} articles from cache for '${section}'.`);
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ status: "ok", articles: cachedArticles, source: 'cache' })
        };
    }
    // If cache is also empty, return the final error
    return {
        statusCode: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ status: "error", message: finalError.message })
    };
}



