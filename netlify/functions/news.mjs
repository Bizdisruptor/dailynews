// netlify/functions/news.mjs
// Fetches news from multiple APIs and caches the last successful result using the file system.
import fs from 'fs';
import { URL } from 'url';

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

// --- API Configurations ---
const PROVIDERS = {
  frontpage: ['newsapi', 'gnews', 'newsdata', 'rss'],
  world:     ['newsapi', 'gnews', 'newsdata', 'rss'],
  tech:      ['newsapi', 'gnews', 'newsdata', 'rss'],
  finance:   ['newsapi', 'gnews', 'newsdata', 'finnhub'],
};

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
  return data.articles.map(a => norm(a.title, a.url, a.source?.name, a.description, a.publishedAt));
}

async function fetchFromGNews(section) {
  const GNEWS_CATEGORY_MAP = { world: 'world', tech: 'technology', finance: 'business', frontpage: 'general' };
  const category = GNEWS_CATEGORY_MAP[section] || 'general';
  const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&max=15&apikey=${process.env.GNEWS_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Status: ${response.status}`);
  const data = await response.json();
  if (!data.articles || data.articles.length === 0) throw new Error('No articles found');
  return data.articles.map(a => norm(a.title, a.url, a.source?.name, a.description, a.publishedAt));
}

async function fetchFromNewsdata(section) {
    const NEWSDATA_CATEGORY_MAP = { world: 'world', tech: 'technology', finance: 'business', frontpage: 'top' };
    const category = NEWSDATA_CATEGORY_MAP[section] || 'top';
    const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_KEY}&language=en&category=${category}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Status: ${response.status}`);
    const data = await response.json();
    if (data.status !== 'success' || !data.results || data.results.length === 0) throw new Error('No articles found');
    return data.results.map(a => norm(a.title, a.link, a.source_id, a.description, a.pubDate));
}

async function fetchFromFinnhub(_section) {
  const url = `https://finnhub.io/api/v1/news?category=general&token=${process.env.FINNHUB_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Status: ${response.status}`);
  const data = await response.json();
  if (!data || data.length === 0) throw new Error('No articles found');
  return data.slice(0, 15).map(a => norm(a.headline, a.url, a.source, a.summary, a.datetime * 1000));
}

async function rss(section) {
    const feeds = pickRss(section);
    const all = [];
    for (const feed of feeds) {
      try {
        const r = await fetch(feed, { headers: { 'user-agent': 'thecerfreport-bot/1.0' } });
        if(!r.ok) continue;
        const xml = await r.text();
        all.push(...parseRSS(xml));
      } catch (e) {
        console.warn(`[rss] failed ${feed}:`, e?.message || e);
      }
    }
    return dedupeByUrl(all).map(a => ({
      title: a.title, url: a.url, source: a.source, description: a.summary, publishedAt: a.ts
    }));
}

const PROVIDER_IMPL = { newsapi: fetchFromNewsAPI, gnews: fetchFromGNews, newsdata: fetchFromNewsdata, finnhub: fetchFromFinnhub, rss };

/* ---------------- Main Handler ---------------- */
export async function handler(event) {
  const section = (event.queryStringParameters?.section || "frontpage").toLowerCase();
  
  for (const p of PROVIDERS[section]) {
    try {
      const articles = await PROVIDER_IMPL[p](section);
      if (articles?.length) {
        writeCache(section, articles);
        return nodeJson({ status: "ok", articles, source: p });
      }
    } catch (e) {
      console.warn(`[provider:${p}] failed for ${section}:`, e?.message || e);
    }
  }

  const cachedArticles = readCache(section);
  if (cachedArticles) {
    return nodeJson({ status: "ok", articles: cachedArticles, source: 'cache' });
  }

  return nodeJson({ status: "error", message: "All news sources are currently unavailable." }, 502);
}

/* ---------------- utils ---------------- */
function mapCategory(section) { return { world: 'general', tech: 'technology', finance: 'business' }[section] || 'general'; }
function mapGNewsTopic(section) { return { world: 'world', tech: 'technology', finance: 'business' }[section] || 'breaking-news'; }
function mapNewsDataCat(section) { return { world: 'world', tech: 'technology', finance: 'business' }[section] || 'top'; }
function pickRss(section) {
    const feeds = {
        frontpage: ["http://feeds.feedburner.com/DrudgeReportFeed", "https://feeds.bbci.co.uk/news/rss.xml"],
        world: ["https://feeds.bbci.co.uk/news/world/rss.xml", "http://feeds.reuters.com/Reuters/worldNews"],
        tech: ["http://feeds.feedburner.com/TechCrunch/", "https://www.theverge.com/rss/index.xml"],
        finance: ["http://feeds.reuters.com/reuters/businessNews", "https://www.cnbc.com/id/10000664/device/rss/rss.html"],
    };
    return feeds[section] || feeds.frontpage;
}
function norm(title, url, source, summary, ts) {
  if (!title || !url) return null;
  return {
    title: String(title).trim(),
    url: String(url).trim(),
    source: source ? String(source).trim() : host(url),
    description: (summary || '').toString().trim(),
    publishedAt: toISO(ts),
  };
}
function toISO(t) { if (!t) return new Date().toISOString(); const d = typeof t === 'number' ? new Date(t) : new Date(String(t)); return isNaN(d) ? new Date().toISOString() : d.toISOString(); }
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function parseRSS(xml) {
  const out = []; const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const T = (tag) => (b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')) || [, ''])[1].trim();
    let link = (b.match(/<link[^>]*>([\s\\S]*?)<\/link>/i) || [, ''])[1].trim();
    if (!link) { const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i); if (alt) link = alt[1]; }
    if (!link) { const href = b.match(/<link[^>]*href=["']([^"']+)["']/i); if (href) link = href[1]; }
    const title = decode(T('title'));
    const desc = decode(T('description') || T('summary') || '');
    const pub = T('pubDate') || T('updated') || T('published') || '';
    if (title && link) out.push({ title, url: link, source: host(link), summary: stripHTML(desc).slice(0, 280), ts: toISO(pub) });
  }
  return out;
}
function stripHTML(s = '') { return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function decode(s = '') { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function dedupeByUrl(items) { const seen = new Set(); const out = []; for (const it of items) { const k = (it.url || '').split('#')[0]; if (!k) continue; if (!seen.has(k)) { seen.add(k); out.push(it); } } return out; }
function nodeJson(body, status = 200, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extraHeaders },
    body: JSON.stringify(body)
  };
}
