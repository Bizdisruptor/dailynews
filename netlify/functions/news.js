// Curated NewsAPI proxy with whitelists & excludes
const NEWS_BASE = "https://newsapi.org/v2";

const GOOD = {
  world: {
    // Drudge-style: fast, broad, but only trusted
    endpoint: "top-headlines",
    params: {
      language: "en",
      pageSize: 15,
      // Stick to AP/Reu/BBC for clean wires; extend if you like
      sources: "associated-press,reuters,bbc-news",
    },
  },
  tech: {
    // TechCrunch + a few reputable tech outlets
    endpoint: "top-headlines",
    params: {
      language: "en",
      pageSize: 12,
      sources: "techcrunch,the-verge,engadget,axios,ars-technica",
    },
  },
  finance: {
    // Finance via domains (some big names are limited by NewsAPI licensing,
    // but CNBC, Barron's, MarketWatch, Reuters usually work well)
    endpoint: "everything",
    params: {
      language: "en",
      sortBy: "publishedAt",
      pageSize: 12,
      q: "(stocks OR markets OR bonds OR inflation OR fed OR earnings)",
      domains: [
        "cnbc.com",
        "barrons.com",
        "marketwatch.com",
        "reuters.com",
        "wsj.com",        // may be partial
        "fortune.com",
        "financialpost.com"
      ].join(","),
      excludeDomains: [
        "biztoc.com",
        "the-sun.com",
        "dailyexpress.co.uk",
        "cointelegraph.com" // remove if you want more crypto
      ].join(",")
    },
  },
  // General “drudge-like” mix (you can aim your homepage here if you want)
  frontpage: {
    endpoint: "everything",
    params: {
      language: "en",
      sortBy: "publishedAt",
      pageSize: 18,
      q: "(election OR border OR crime OR war OR trade OR tariffs OR immigration OR protest OR courts)",
      domains: [
        "reuters.com","apnews.com","bbc.com","cnbc.com","nypost.com",
        "wsj.com","abcnews.go.com","nbcnews.com","foxnews.com","newsweek.com"
      ].join(","),
      excludeDomains: ["biztoc.com","the-sun.com","mirror.co.uk"].join(",")
    }
  }
};

export async function handler(event) {
  try {
    const section = (event.queryStringParameters?.section || "world").toLowerCase();
    const cfg = GOOD[section] || GOOD.world;

    const u = new URL(`${NEWS_BASE}/${cfg.endpoint}`);
    // Build query quickly
    for (const [k, v] of Object.entries(cfg.params)) {
      if (v) u.searchParams.set(k, v);
    }
    // If using top-headlines and not specifying sources, add country for volume
    if (cfg.endpoint === "top-headlines" && !u.searchParams.get("sources")) {
      u.searchParams.set("country", "us");
    }

    const r = await fetch(u.toString(), {
      headers: { "X-Api-Key": process.env.NEWSAPI_KEY }
    });

    const text = await r.text();
    return {
      statusCode: r.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: text
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ status: "error", message: err.message })
    };
  }
}
