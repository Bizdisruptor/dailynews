// netlify/functions/news.js  (CommonJS)
// Robust news with provider round-robin + stale cache fallback.
// Providers (in order): NewsAPI -> TheNewsAPI -> RSS -> /tmp stale cache

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// --- Provider config ---------------------------------------------------------

const HAS_NEWSAPI = !!process.env.NEWSAPI_KEY;
const HAS_THENEWSAPI = !!process.env.THENEWSAPI_KEY;

// RSS fallbacks (no key). We'll round-robin inside each list.
const RSS = {
  frontpage: [
    "https://feeds.reuters.com/reuters/topNews",
    "https://feeds.bbci.co.uk/news/rss.xml",
    "https://www.npr.org/rss/rss.php?id=1001", // NPR Top Stories
  ],
  world: [
    "https://feeds.reuters.com/reuters/worldNews",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.npr.org/rss/rss.php?id=1004", // NPR World
  ],
  tech: [
    "https://techcrunch.com/feed/",
    "https://www.theverge.com/rss/index.xml",
    "https://feeds.arstechnica.com/arstechnica/index",
  ],
  finance: [
    "https://feeds.content.dowjones.io/public/rss/mw_topstories", // MarketWatch
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",      // CNBC Top News
    "https://finance.yahoo.com/news/rssindex",                    // Yahoo Finance news
  ],
};

// Map UI "section" => NewsAPI category
const NEWSAPI_CAT = {
  frontpage: "general",
  world: "general",
  tech: "technology",
  finance: "business",
};

// Map UI "section" => TheNewsAPI categories
// (TheNewsAPI accepts categories like: business, tech, world, etc.)
const THENEWSAPI_CAT = {
  frontpage: "",         // no category => general top headlines
  world: "world",
  tech: "tech",
  finance: "business",
};

// --- Utilities ---------------------------------------------------------------

const SECTIONS = ["frontpage", "world", "tech", "finance"];

// In-memory state survives warm Lambda invocations.
const RR = Object.fromEntries(SECTIONS.map(s => [s, 0])); // round-robin index
const CACHE = Object.fromEntries(SECTIONS.map(s => [s, { ts: 0, articles: [] }]));
const CACHE_FILE = "/tmp/news-cache.json";

async function readDiskCache() {
  try {
    const fs = require("fs");
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      const json = JSON.parse(raw);
      for (const s of SECTIONS) {
        if (json[s]) CACHE[s] = json[s];
      }
    }
  } catch (_) {}
}
async function writeDiskCache() {
  try {
    const fs = require("fs");
    fs.writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
  } catch (_) {}
}

// Simple RSS parsing (title/link/description/pubDate)
function unescapeHtml(s = "") {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function stripTags(s = "") {
  return s.replace(/<\/?[^>]+(>|$)/g, "").trim();
}
function parseRss(xml) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const chunk = m[1];
    const pick = (tag) => {
      const rx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const mm = rx.exec(chunk);
      return mm ? unescapeHtml(mm[1].trim()) : "";
    };
    out.push({
      title: stripTags(pick("title")),
      url: pick("link"),
      description: stripTags(pick("description")),
      publishedAt: pick("pubDate"),
    });
  }
  return out.filter(a => a.title && a.url);
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchText(url, headers) {
  const r = await fetch(url, { headers, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Normalize to {title,url,description}
function normArticles(list) {
  return (list || [])
    .map(a => ({
      title: a?.title || a?.headline || "",
      url: a?.url || a?.link || "",
      description: a?.description || a?.snippet || ""
    }))
    .filter(x => x.title && x.url);
}

// --- Providers ---------------------------------------------------------------

async function getNewsapi(section) {
  if (!HAS_NEWSAPI) return null;
  const cat = NEWSAPI_CAT[section] || "general";
  const url = `https://newsapi.org/v2/top-headlines?country=us&category=${encodeURIComponent(cat)}&pageSize=12`;
  const data = await fetchJson(url, { "X-Api-Key": process.env.NEWSAPI_KEY, "Accept": "application/json" });
  const articles = (data.articles || [])
    .filter(a => a && a.title && a.title !== "[Removed]")
    .map(a => ({ title: a.title, url: a.url, description: a.description || "" }));
  return articles.length ? articles : null;
}

async function getTheNewsAPI(section) {
  if (!HAS_THENEWSAPI) return null;
  const key = process.env.THENEWSAPI_KEY;
  const cat = (THENEWSAPI_CAT[section] || "").trim();

  // Try /v1/news/top first
  const p = new URLSearchParams({
    api_token: key,
    locale: "us",        // prefer US edition
    language: "en",
    limit: "12"
  });
  if (cat) p.set("categories", cat);

  const base = "https://api.thenewsapi.com/v1/news/top";
  try {
    const data = await fetchJson(`${base}?${p.toString()}`, { "Accept": "application/json" });
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.articles) ? data.articles : [];
    const articles = normArticles(list);
    if (articles.length) return articles;
  } catch (_) {}

  // Fallback to /v1/news/all
  const base2 = "https://api.thenewsapi.com/v1/news/all";
  try {
    const data2 = await fetchJson(`${base2}?${p.toString()}`, { "Accept": "application/json" });
    const list2 = Array.isArray(data2?.data) ? data2.data : Array.isArray(data2?.articles) ? data2.articles : [];
    const articles2 = normArticles(list2);
    if (articles2.length) return articles2;
  } catch (_) {}

  return null;
}

async function getRssRoundRobin(section) {
  const feeds = RSS[section] || [];
  if (!feeds.length) return null;
  const startIdx = RR[section] % feeds.length;

  // Try up to feeds.length feeds, starting from current RR index
  for (let i = 0; i < feeds.length; i++) {
    const idx = (startIdx + i) % feeds.length;
    const feedUrl = feeds[idx];
    try {
      const xml = await fetchText(feedUrl, {
        "User-Agent": "Mozilla/5.0 (NetlifyFunction)",
        "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      });
      const items = parseRss(xml);
      if (items && items.length) {
        RR[section] = idx + 1; // advance RR after success
        const mapped = items.slice(0, 12).map(a => ({
          title: a.title,
          url: a.url,
          description: a.description || "",
        }));
        return mapped;
      }
    } catch (_) {
      // try next feed
    }
  }
  return null;
}

// Helper to get one section with provider chain + cache
async function getSectionArticles(section) {
  // 1) NewsAPI
  let articles = null;
  try { articles = await getNewsapi(section); } catch (_) {}

  // 2) TheNewsAPI
  if (!articles || !articles.length) {
    try { articles = await getTheNewsAPI(section); } catch (_) {}
  }

  // 3) RSS round-robin
  if (!articles || !articles.length) {
    try { articles = await getRssRoundRobin(section); } catch (_) {}
  }

  // 4) Cache fallback
  if (!articles || !articles.length) {
    const cached = CACHE[section]?.articles || [];
    return { articles: cached, stale: true };
  }

  CACHE[section] = { ts: Date.now(), articles };
  await writeDiskCache();
  return { articles, stale: false };
}

// --- Main handler ------------------------------------------------------------

exports.handler = async function (event) {
  try {
    await readDiskCache();

    const raw = (event.queryStringParameters?.section || "frontpage").toLowerCase();

    // Accept: "frontpage", "frontpage,world", "frontpage|world|tech|finance", or "all"
    const requested = raw === "all"
      ? SECTIONS
      : raw.split(/[|,]/).map(s => s.trim()).filter(Boolean);

    const uniq = [...new Set(requested)].filter(s => SECTIONS.includes(s));
    if (!uniq.length) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ status: "error", message: "Unknown section" }) };
    }

    // Single section (keep legacy shape)
    if (uniq.length === 1) {
      const s = uniq[0];
      const { articles, stale } = await getSectionArticles(s);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", articles, stale }) };
    }

    // Multiple sections
    const out = {};
    for (const s of uniq) out[s] = await getSectionArticles(s);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", sections: out }) };
  } catch (e) {
    // Try serve cache on unexpected error
    try {
      await readDiskCache();
      const raw = (event.queryStringParameters?.section || "frontpage").toLowerCase();
      const req = raw === "all" ? SECTIONS : raw.split(/[|,]/).map(s => s.trim()).filter(Boolean);
      const uniq = [...new Set(req)].filter(s => SECTIONS.includes(s));
      if (uniq.length === 1) {
        const cached = CACHE[uniq[0]]?.articles || [];
        if (cached.length) return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", articles: cached, stale: true }) };
      } else if (uniq.length > 1) {
        const out = {};
        for (const s of uniq) out[s] = { articles: (CACHE[s]?.articles || []), stale: true };
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", sections: out }) };
      }
    } catch (_) {}
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: e.message }) };
  }
};
