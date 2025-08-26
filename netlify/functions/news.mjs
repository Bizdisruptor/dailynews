// netlify/functions/news.js
// Fetches news from multiple APIs using https and caches the result. No dependencies needed.
const fs = require("fs");
const https = require("https");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const REQ_TIMEOUT = 7000;

// --- API Configurations ---
const PROVIDERS = {
  frontpage: ['newsapi', 'gnews', 'newsdata', 'rss'],
  world:     ['newsapi', 'gnews', 'newsdata', 'rss'],
  tech:      ['newsapi', 'gnews', 'newsdata', 'rss'],
  finance:   ['newsapi', 'gnews', 'newsdata', 'finnhub'],
};
const DEFAULT_SECTION = 'frontpage';
const SECTION_KEYS = new Set(Object.keys(PROVIDERS));

/* ===== Utils ===== */
function httpsGet(url, tag="request"){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=https.request({
      method:"GET", hostname:u.hostname, path:u.pathname+(u.search||""),
      headers:{ "Accept":"application/json", "User-Agent":"cerfreport/1.0" }, timeout: REQ_TIMEOUT
    },res=>{
      const chunks=[]; res.on("data",d=>chunks.push(d));
      res.on("end",()=>{
        const body=Buffer.concat(chunks).toString("utf8");
        if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`${tag} HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch(e){ reject(new Error(`${tag} JSON parse error: ${e.message}`)); }
      });
    });
    req.on("error",e=>reject(new Error(`${tag} ${e.message}`)));
    req.on("timeout",()=>req.destroy(new Error(`${tag} timeout ${REQ_TIMEOUT}ms`)));
    req.end();
  });
}

function httpsGetText(url, tag="request"){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=https.request({ method:"GET", hostname:u.hostname, path:u.pathname+(u.search||""), headers:{ "User-Agent":"cerfreport/1.0" }, timeout: REQ_TIMEOUT },res=>{
      const chunks=[]; res.on("data",d=>chunks.push(d));
      res.on("end",()=>{ const body=Buffer.concat(chunks).toString("utf8"); if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`${tag} HTTP ${res.statusCode}`)); resolve(body); });
    });
    req.on("error",e=>reject(new Error(`${tag} ${e.message}`)));
    req.on("timeout",()=>req.destroy(new Error(`${tag} timeout ${REQ_TIMEOUT}ms`)));
    req.end();
  });
}

/* ===== Caching ===== */
const cacheFile = section => `/tmp/news-cache-${section}.json`;
const readCache = section => { try { return fs.existsSync(cacheFile(section)) ? JSON.parse(fs.readFileSync(cacheFile(section),"utf8")) : null; } catch { return null; } };
const writeCache = (section, articles) => { try { fs.writeFileSync(cacheFile(section), JSON.stringify(sanitizeArticles(articles))); } catch {} };

/* ===== Providers ===== */
async function fetchFromNewsAPI(section) {
  const key = process.env.NEWSAPI_KEY;
  if (!key) throw new Error('NEWSAPI_KEY missing');
  const NEWSAPI_CONFIG = {
    world: { endpoint: 'top-headlines', params: { language: 'en', pageSize: 15, sources: 'associated-press,reuters,bbc-news' } },
    tech: { endpoint: 'top-headlines', params: { language: 'en', pageSize: 12, sources: 'techcrunch,the-verge,engadget,axios,ars-technica' } },
    finance: { endpoint: 'everything', params: { language: 'en', sortBy: 'publishedAt', pageSize: 12, q: '(stocks OR markets OR bonds OR inflation OR fed OR earnings)', domains: 'reuters.com,cnbc.com,marketwatch.com,barrons.com,wsj.com,fortune.com,financialpost.com' } },
    frontpage: { endpoint: 'everything', params: { language: 'en', sortBy: 'publishedAt', pageSize: 18, q: '(election OR border OR crime OR war OR trade OR tariffs OR immigration OR protest OR courts)', domains: 'reuters.com,apnews.com,bbc.com,cnbc.com,nypost.com,wsj.com,abcnews.go.com,nbcnews.com,foxnews.com,newsweek.com' } },
  };
  const cfg = NEWSAPI_CONFIG[section] || NEWSAPI_CONFIG.world;
  const url = new URL(`https://newsapi.org/v2/${cfg.endpoint}`);
  for (const [k, v] of Object.entries(cfg.params)) if (v) url.searchParams.set(k, v);
  url.searchParams.set('apiKey', key);
  
  const data = await httpsGet(url.toString(), "newsapi");
  if (data.status !== 'ok' || !Array.isArray(data.articles) || data.articles.length === 0) throw new Error(data.message || 'No articles');
  return data.articles.map(a => norm(a?.title, a?.url, a?.source?.name, a?.description, a?.publishedAt));
}

async function fetchFromGNews(section) {
  const key = process.env.GNEWS_API_KEY;
  if (!key) throw new Error('GNEWS_API_KEY missing');
  const GNEWS_CATEGORY_MAP = { world: 'world', tech: 'technology', finance: 'business', frontpage: 'general' };
  const category = GNEWS_CATEGORY_MAP[section] || 'general';
  const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&max=15&apikey=${key}`;
  const data = await httpsGet(url, "gnews");
  if (!Array.isArray(data.articles) || data.articles.length === 0) throw new Error('No articles');
  return data.articles.map(a => norm(a?.title, a?.url, a?.source?.name, a?.description, a?.publishedAt));
}

async function fetchFromNewsdata(section) {
  const key = process.env.NEWSDATA_KEY;
  if (!key) throw new Error('NEWSDATA_KEY missing');
  const NEWSDATA_CATEGORY_MAP = { world: 'world', tech: 'technology', finance: 'business', frontpage: 'top' };
  const category = NEWSDATA_CATEGORY_MAP[section] || 'top';
  const url = `https://newsdata.io/api/1/news?apikey=${key}&language=en&category=${category}`;
  const data = await httpsGet(url, "newsdata");
  if (data.status !== 'success' || !Array.isArray(data.results) || data.results.length === 0) throw new Error('No articles');
  return data.results.map(a => norm(a?.title, a?.link, a?.source_id, a?.description, a?.pubDate));
}

async function fetchFromFinnhub(_section) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY missing');
  const url = `https://finnhub.io/api/v1/news?category=general&token=${key}`;
  const data = await httpsGet(url, "finnhub");
  if (!Array.isArray(data) || data.length === 0) throw new Error('No articles');
  return data.slice(0, 15).map(a => norm(a?.headline, a?.url, a?.source, a?.summary, a?.datetime * 1000));
}

async function rss(section) {
  const feeds = pickRss(section);
  const all = [];
  for (const feed of feeds) {
    try {
      const xml = await httpsGetText(feed, `rss:${feed}`);
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

/* ===== Handler ===== */
exports.handler = async (event) => {
  const raw = (event?.queryStringParameters?.section || DEFAULT_SECTION).toLowerCase().trim();
  const section = SECTION_KEYS.has(raw) ? raw : DEFAULT_SECTION;
  const providers = PROVIDERS[section] || PROVIDERS[DEFAULT_SECTION];

  for (const p of providers) {
    try {
      const articles = await PROVIDER_IMPL[p](section);
      const cleaned = sanitizeArticles(articles);
      if (cleaned.length) {
        writeCache(section, cleaned);
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: 'ok', articles: cleaned, source: p }) };
      }
    } catch (e) {
      console.warn(`[provider:${p}] failed for ${section}:`, e?.message || e);
    }
  }

  const cachedArticles = readCache(section);
  if (cachedArticles?.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ status: 'ok', articles: cachedArticles, source: 'cache' }) };
  }

  return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ status: 'error', message: 'All news sources are currently unavailable.' }) };
};

/* ===== Utilities ===== */
function sanitizeArticles(articles) {
  const clean = (Array.isArray(articles) ? articles : []).filter(Boolean)
    .filter(a => a?.title && a?.url)
    .map(a => ({ ...a, publishedAt: toISO(a.publishedAt), source: a.source || host(a.url), description: (a.description || '').toString().trim() }));
  const unique = dedupeByUrl(clean);
  unique.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return unique;
}
function pickRss(section) {
  const feeds = {
    frontpage: ['https://feeds.bbci.co.uk/news/rss.xml', 'https://www.reuters.com/world/rss', 'https://apnews.com/hub/ap-top-news?utm_source=apnews.com&utm_medium=referral&utm_campaign=ap-rss'],
    world: ['https://feeds.bbci.co.uk/news/world/rss.xml', 'https://www.reuters.com/world/rss'],
    tech: ['https://techcrunch.com/feed/', 'https://www.theverge.com/rss/index.xml', 'https://arstechnica.com/feed/'],
    finance: ['https://www.reuters.com/markets/rss', 'https://www.cnbc.com/id/10000664/device/rss/rss.html'],
  };
  return feeds[section] || feeds[DEFAULT_SECTION];
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
function toISO(t) {
  if (!t) return new Date().toISOString();
  const d = typeof t === 'number' ? new Date(t) : new Date(String(t));
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function parseRSS(xml) {
  const out = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
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
function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = (it?.url || '').split('#')[0];
    if (!k) continue;
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}
