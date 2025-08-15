// netlify/functions/news.js
// Fetches news from NewsAPI, with a fallback to GNews if it fails.

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
  if (data.status !== 'ok') {
      throw new Error(`NewsAPI returned an error: ${data.message}`);
  }
  // The data from NewsAPI is already in the correct format.
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

// GNews returns data in a different format, so we need to adapt it.
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
    // Transform each article to match the format our front-end expects.
    return data.articles.map(transformGNewsArticle);
}


// --- Main Handler with Fallback Logic ---
export async function handler(event) {
  const section = (event.queryStringParameters?.section || "world").toLowerCase();

  try {
    // 1. Try fetching from the primary source first.
    console.log(`Attempting to fetch '${section}' from NewsAPI...`);
    const articles = await fetchFromNewsAPI(section);
    console.log(`Successfully fetched ${articles.length} articles from NewsAPI.`);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ status: "ok", articles })
    };
  } catch (primaryError) {
    // 2. If it fails, log the error and try the fallback source.
    console.warn(`Primary source (NewsAPI) failed: ${primaryError.message}. Trying fallback...`);
    try {
      const articles = await fetchFromGNews(section);
      console.log(`Successfully fetched ${articles.length} articles from GNews fallback.`);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ status: "ok", articles })
      };
    } catch (fallbackError) {
      // 3. If the fallback also fails, return an error.
      console.error(`Fallback source (GNews) also failed: ${fallbackError.message}`);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ status: "error", message: fallbackError.message })
      };
    }
  }
}

