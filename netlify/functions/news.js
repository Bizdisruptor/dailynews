// netlify/functions/news.js
// Robust news endpoint with RSS fallback, optional APIs, ETag/304 + cooldown.
// Works on Node 18+ (Netlify runtime). No JSX-like literals anywhere.

import fs from "fs";

// -------- Config --------
const HEADERS = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" };
const CACHE_DIR = "/tmp";
const DEFAULT_SECTION = "frontpage";
const PROVIDERS_BY_SECTION = {
  frontpage: ["rss", "newsapi", "gnews", "newsdata"],
  world:     ["rss", "newsapi", "gnews", "newsdata"],
  tech:      ["rss", "newsapi", "gnews", "newsdata"],
  finance:   ["rss", "newsapi", "gnews", "finnhub"],
};
const COOLDOWN_MS = 5 * 60 * 1000; // don’t hit upstream more than once per 5 min per section
const TIMEOUT_MS  = 7000;

// -------- Handler --------
export const handler = async (event) => {
  const sectionRaw = (event?.queryStringParameters?.section || DEFAULT_SECTION).toLowerCase().trim();
  const section = Object.prototype.hasOwnProperty.call(PROVIDERS_BY_SECTION, sectionRaw) ? sectionRaw : DEFAULT_SECTION;

  const cache = readCache(section); // { articles, etag, updatedAt, lastTriedAt }
  const clientETag = event?.headers?.["if-none-match"] || event?.headers?.["If-None-Match"];

  // If client has our current ETag and we’re inside cooldown → 304
  if (cache?.etag && clientETag === cache.etag && withinCooldown(cache)) {
    return { statusCode: 304, headers: { ETag: cache.etag, ...HEADERS } };
  }

  // If inside cooldown but no matching ETag, just serve cache now
  if (withinCooldown(cache) && cache?.articles?.length) {
    return jsonWithETag({ status: "ok", articles: cache.articles, source: "cache" }, cache.etag);
  }

  // Try providers in order (RSS first so it works without keys)
  let got = null;
  const providers = PROVIDERS_BY_SECTION[section] || ["rss"];
  for (const p of providers) {
    try {
      if (p === "newsapi"  && !process.env.NEWSAPI_KEY) continue;
      if (p === "gnews"    && !process.env.GNEWS_API_KEY) continue;
      if (p === "newsdata" && !process.env.NEWSDATA_KEY) continue;
      if (p === "finnhub"  && !process.env.FINNHUB_API_KEY) continue;

      const articles = await withTimeout((signal) => PROVIDERS[p](section, { signal }), TIMEOUT_MS);
      const cleaned  = sanitizeArticles(articles);
      if (cleaned.length) { got = { articles: cleaned, source: p }; break; }
    } catch (e) {
      console.warn(`[news][${section}] provider ${p} failed:`, e?.message || e);
    }
  }

  touchLastTried(section);

  if (got) {
    const etag = makeETag(got.articles);
    writeCache(section, got.articles, etag);
    return jsonWithETag({ status: "ok", articles: got.articles, source: got.source }, etag);
  }

  // Fall back to cache or error
  if (cache?.articles?.length) {
    if (clientETag && cache.etag && clientETag === cache.etag) {
      return { statusCode: 304, headers: { ETag: cache.etag, ...HEADERS } };
    }
    return jsonWithETag({ status: "ok", articles: cache.articles, source: "cache" }, cache.etag);
  }

  return json({ status: "error", message: "No news available." }, 502);
};

// -------- Providers --------
const PROVIDERS = {
  async rss(section, { signal } = {}) {
    const feeds = pickRSS(section);
    const all = [];
    for (const url of feeds) {
      try {
        const res = await fetch(url, { signal, headers: { "user-agent": "cerfreport/1.0" } });
        if (!res.ok) continue;
        const xml = await res.text();
        all.push(...parseRSS(xml));
      } catch (e) {
        console.warn(`[rss] ${url} failed:`, e?.message || e);
      }
    }
    return all.map(a => norm(a.title, a.url, a.source, a.summary, a.ts));
  },

  async newsapi(section, { signal } = {}) {
    const base = "https://newsapi.org/v2";
    const conf = {
      world:     { endpoint: "top-headlines", params: { language: "en", pageSize: 15, sources: "associated-press,reuters,bbc-news" } },
      tech:      { endpoint: "top-headlines", params: { language: "en", pageSize: 12, sources: "techcrunch,the-verge,engadget,axios,ars-technica" } },
      finance:   { endpoint: "everything",    params: { language: "en", sortBy: "publishedAt", pageSize: 12, q: "(stocks OR markets OR bonds OR inflation OR fed OR earnings)", domains: "reuters.com,cnbc.com,marketwatch.com,barrons.com,wsj.com,fortune.com,financialpost.com" } },
      frontpage: { endpoint: "everything",    params: { language: "en", sortBy: "publishedAt", pageSize: 18, q: "(election OR border OR crime OR war OR trade OR tariffs OR immigration OR protest OR courts)", domains: "reuters.com,apnews.com,bbc.com,cnbc.com,nypost.com,wsj.com,abcnews.go.com,nbcnews.com,foxnews.com,newsweek.com" } },
    }[section] || { endpoint: "top-headlines", params: { language: "en", pageSize: 15 } };

    const url = new URL(`${base}/${conf.endpoint}`);
    Object.entries(conf.params).forEach(([k, v]) => v && url.searchParams.set(k, v));
    const r = await fetch(url, { signal, headers: { "X-Api-Key": process.env.NEWSAPI_KEY } });
    if (!r.ok) throw new Error(`newsapi ${r.status}`);
    const data = await r.json();
    if (data.status !== "ok" || !Array.isArray(data.articles) || !data.articles.length) throw new Error("newsapi no articles");
    return data.articles.map(a => norm(a?.title, a?.url, a?.source?.name, a?.description, a?.publishedAt));
  },

  async gnews(section, { signal } = {}) {
    const map = { world: "world", tech: "technology", finance: "business", frontpage: "general" };
    const cat = map[section] || "general";
    const url = `https://gnews.io/api/v4/top-headlines?category=${cat}&lang=en&max=15&apikey=${process.env.GNEWS_API_KEY}`;
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`gnews ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data.articles) || !data.articles.length) throw new Error("gnews no articles");
    return data.articles.map(a => norm(a?.title, a?.url, a?.source?.name, a?.description, a?.publishedAt));
  },

  async newsdata(section, { signal } = {}) {
    const map = { world: "world", tech: "technology", finance: "business", frontpage: "top" };
    const cat = map[section] || "top";
    const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_KEY}&language=en&category=${cat}`;
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`newsdata ${r.status}`);
    const data = await r.json();
    if (data.status !== "success" || !Array.isArray(data.results) || !data.results.length) throw new Error("newsdata no articles");
    return data.results.map(a => norm(a?.title, a?.link, a?.source_id, a?.description, a?.pubDate));
  },

  async finnhub(_section, { signal } = {}) {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${process.env.FINNHUB_API_KEY}`;
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`finnhub ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) throw new Error("finnhub no articles");
    return data.slice(0, 15).map(a => norm(a?.headline, a?.url, a?.source, a?.summary, a?.datetime * 1000));
  },
};

// -------- RSS helpers (JSX-safe) --------
function pickRSS(section) {
  const feeds = {
    frontpage: [
      "https://feeds.bbci.co.uk/news/rss.xml",
      "https://www.reuters.com/world/rss",
      "https://apnews.com/apf-topnews?output=rss"
    ],
    world: [
      "https://feeds.bbci.co.uk/news/world/rss.xml",
      "https://www.reuters.com/world/rss"
    ],
    tech: [
      "https://techcrunch.com/feed/",
      "https://www.theverge.com/rss/index.xml",
      "https://arstechnica.com/feed/"
    ],
    finance: [
      "https://www.reuters.com/markets/rss",
      "https://www.cnbc.com/id/10000664/device/rss/rss.html"
    ],
  };
  return feeds[section] || feeds[DEFAULT_SECTION];
}

function parseRSS(xml) {
  const out = [];
  // Build regex with strings (no JSX-like literals)
  const itemRe  = new RegExp("<item[\\s\\S]*?<\\/item>", "gi");
  const entryRe = new RegExp("<entry[\\s\\S]*?<\\/entry>", "gi");
  const blocks = xml.match(itemRe) || xml.match(entryRe) || [];
  for (const b of blocks) {
    const title = grabTag(b, "title");
    let link = grabTag(b, "link");
    if (!link) link = grabAttr(b, "link", "href") || grabAttr(b, "link", "rel=\"alternate\
