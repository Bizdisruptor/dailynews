// netlify/functions/news.js  (CommonJS)
// Robust news with provider round-robin + stale cache fallback.

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// --- Provider config ---------------------------------------------------------

// 1) Paid/Keyed (optional)  — only used if a key is present
const HAS_NEWSAPI = !!process.env.NEWSAPI_KEY;

// 2) RSS fallbacks (no key). We'll round-robin inside each list.
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

// --- Providers ---------------------------------------------------------------

async function getNewsapi(section) {
  if (!HAS_NEWSAPI) return null;
  const cat = NEWSAPI_CAT[section] || "general";
  const url = `https://newsapi.org/v2/top-headlines?country=us&category=${encodeURIComponent(cat)}&pageSize=10`;
  const data = await fetchJson(url, { "X-Api-Key": process.env.NEWSAPI_KEY, "Accept": "application/json" });
  const articles = (data.articles || [])
    .filter(a => a && a.title && a.title !== "[Removed]")
    .map(a => ({ title: a.title, url: a.url, description: a.description || "" }));
  return articles.length ? articles : null;
}

async function getRssRoundRobin(section) {
  const feeds = RSS[section] || [];
  if (!feeds.length) return null;
  const startIdx = RR[section] % feeds.length;

  // try up to feeds.length feeds, starting from the current RR index
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
        // normalize fields
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

// --- Main handler ------------------------------------------------------------

exports.handler = async function (event) {
  try {
    await readDiskCache();

    const section = (event.queryStringParameters?.section || "frontpage").toLowerCase();
    if (!SECTIONS.includes(section)) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ status: "error", message: "Unknown section" }) };
    }

    // 1) Try NewsAPI (if available)
    let articles = null;
    try { articles = await getNewsapi(section); } catch (_) {}

    // 2) Fallback to RSS (round-robin inside the list)
    if (!articles || !articles.length) {
      try { articles = await getRssRoundRobin(section); } catch (_) {}
    }

    // 3) If still nothing, serve stale cache (never blank the page)
    if (!articles || !articles.length) {
      const cached = CACHE[section]?.articles || [];
      if (cached.length) {
        return {
          statusCode: 200,
          headers: HEADERS,
          body: JSON.stringify({ status: "ok", articles: cached, stale: true })
        };
      }
      // As a last resort, return an empty ok so the UI shows "Could not load…"
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", articles: [] }) };
    }

    // 4) Update cache & persist
    CACHE[section] = { ts: Date.now(), articles };
    await writeDiskCache();

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", articles }) };
  } catch (e) {
    // On unexpected errors, still try to serve cache
    try {
      await readDiskCache();
      const section = event.queryStringParameters?.section || "frontpage";
      const cached = CACHE[section]?.articles || [];
      if (cached.length) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: "ok", articles: cached, stale: true }) };
      }
    } catch (_) {}
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: e.message }) };
  }
};
