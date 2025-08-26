// netlify/functions/news.mjs
// Node runtime version (returns { statusCode, headers, body })
// Durable cache via Netlify Blobs + API rotation + RSS fallback.
// Requires package.json dependency: "@netlify/blobs": "^6.0.0"

import { getStore } from '@netlify/blobs'; // ✅ FIX: Changed createClient to getStore

const store = getStore('news-cache'); // ✅ FIX: Correctly initialize the store

const MAX_ITEMS = 25;

// Providers per section (RSS is last fallback except finance)
const PROVIDERS = {
  frontpage: ['newsapi', 'gnews', 'newsdata', 'rss'],
  world:     ['newsapi', 'gnews', 'newsdata', 'rss'],
  tech:      ['newsapi', 'gnews', 'newsdata', 'rss'],
  finance:   ['newsapi', 'gnews', 'newsdata', 'finnhub'],
};

export async function handler(event, _context) {
  try {
    const section = (event.queryStringParameters?.section || 'frontpage').toLowerCase();
    if (!PROVIDERS[section]) return nodeJson({ status: 'error', message: 'unknown section' }, 400);

    const cacheKey = `news/${section}.json`;

    // 1) Try fresh (rotate providers)
    let articles = null;
    try {
      articles = await fetchSection(section);
    } catch (e) {
      console.warn('fresh fetch failed', section, e?.status || e?.message || e);
    }

    if (articles?.length) {
      const payload = {
        status: 'ok',
        articles: articles.slice(0, MAX_ITEMS),
        source: 'live',
        fetchedAt: Date.now(),
      };
      await store.setJSON(cacheKey, payload).catch(() => {});
      return nodeJson(payload, 200, { 'cache-control': 'public, max-age=120' });
    }

    // 2) Serve durable cache
    const cached = await store.get(cacheKey, { type: 'json' }).catch(() => null);
    if (cached?.articles?.length) {
      return nodeJson({ ...cached, source: 'cache' }, 200, { 'cache-control': 'public, max-age=120' });
    }

    // 3) Nothing to serve
    return nodeJson({ status: 'error', message: 'All news sources are currently unavailable.' }, 502);
  } catch (err) {
    console.error('news handler fatal', err?.message || err);
    return nodeJson({ status: 'error', message: 'internal error' }, 500);
  }
}

/* ---------------- providers ---------------- */

async function fetchSection(section) {
  for (const p of PROVIDERS[section]) {
    try {
      const items = await PROVIDER_IMPL[p](section);
      if (items?.length) return items.filter(Boolean);
    } catch (e) {
      console.warn(`[provider:${p}] failed for ${section}:`, e?.status || e?.message || e);
    }
  }
  throw new Error('all providers failed');
}

const PROVIDER_IMPL = {
  async newsapi(section) {
    const key = process.env.NEWSAPI_KEY;
    if (!key) throw new Error('NEWSAPI_KEY missing');
    const url = new URL('https://newsapi.org/v2/top-headlines');
    url.searchParams.set('language', 'en');
    if (section !== 'frontpage') url.searchParams.set('category', mapCategory(section));
    const r = await fetch(url, { headers: { 'X-Api-Key': key }, signal: timeout(8000) });
    await assertOK(r);
    const j = await r.json();
    return (j.articles || []).map(a => norm(a.title, a.url, a.source?.name, a.description, a.publishedAt));
  },

  async gnews(section) {
    const key = process.env.GNEWS_API_KEY;
    if (!key) throw new Error('GNEWS_API_KEY missing');
    const url = new URL('https://gnews.io/api/v4/top-headlines');
    url.searchParams.set('lang', 'en');
    url.searchParams.set('max', '50');
    if (section !== 'frontpage') url.searchParams.set('topic', mapGNewsTopic(section));
    url.searchParams.set('apikey', key);
    const r = await fetch(url, { signal: timeout(8000) });
    await assertOK(r);
    const j = await r.json();
    return (j.articles || []).map(a => norm(a.title, a.url, a.source?.name, a.description, a.publishedAt));
  },

  async newsdata(section) {
    const key = process.env.NEWSDATA_KEY;
    if (!key) throw new Error('NEWSDATA_KEY missing');
    const url = new URL('https://newsdata.io/api/1/news');
    url.searchParams.set('language', 'en');
    if (section !== 'frontpage') url.searchParams.set('category', mapNewsDataCat(section));
    url.searchParams.set('apikey', key);
    const r = await fetch(url, { signal: timeout(8000) });
    await assertOK(r);
    const j = await r.json();
    return (j.results || []).map(a => norm(a.title, a.link, a.source_id, a.description, a.pubDate));
  },

  async finnhub(_section) {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) throw new Error('FINNHUB_API_KEY missing');
    const url = new URL('https://finnhub.io/api/v1/news');
    url.searchParams.set('category', 'general');
    url.searchParams.set('token', key);
    const r = await fetch(url, { signal: timeout(8000) });
    await assertOK(r);
    const j = await r.json();
    return (Array.isArray(j) ? j : []).map(a => norm(a.headline, a.url, a.source, a.summary, a.datetime * 1000));
  },

  // RSS fallback (no keys) — replace feeds as you prefer
  async rss(section) {
    const feeds = pickRss(section);
    const all = [];
    for (const feed of feeds) {
      try {
        const r = await fetch(feed, {
          signal: timeout(8000),
          headers: { 'user-agent': 'thecerfreport-bot/1.0' }
        });
        await assertOK(r);
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
};

/* ---------------- utils ---------------- */

function mapCategory(section)     { return { world: 'general', tech: 'technology', finance: 'business' }[section] || 'general'; }
function mapGNewsTopic(section)   { return { world: 'world',   tech: 'technology', finance: 'business' }[section] || 'breaking-news'; }
function mapNewsDataCat(section)  { return { world: 'world',   tech: 'technology', finance: 'business' }[section] || 'top'; }

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

async function assertOK(res) {
  if (res.ok) return;
  const txt = await res.text().catch(() => '');
  const err = new Error(`HTTP ${res.status} ${res.statusText}`);
  err.status = res.status;
  err.body = txt.slice(0, 300);
  throw err;
}

function toISO(t){ if(!t) return new Date().toISOString(); const d = typeof t==='number'? new Date(t): new Date(String(t)); return isNaN(d)? new Date().toISOString(): d.toISOString(); }
function host(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return ''; } }

function parseRSS(xml){
  const out=[]; const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for(const b of blocks){
    const T = (tag)=>(b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i'))||[, ''])[1].trim();
    let link = (b.match(/<link[^>]*>([\s\\S]*?)<\/link>/i)||[, ''])[1].trim();
    if(!link){ const alt=b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i); if(alt) link=alt[1]; }
    if(!link){ const href=b.match(/<link[^>]*href=["']([^"']+)["']/i); if(href) link=href[1]; }
    const title = decode(T('title'));
    const desc  = decode(T('description') || T('summary') || '');
    const pub   = T('pubDate') || T('updated') || T('published') || '';
    if(title && link) out.push({ title, url: link, source: host(link), summary: stripHTML(desc).slice(0,280), ts: toISO(pub) });
  }
  return out;
}

function stripHTML(s=''){ return s.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(); }
function decode(s=''){ return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }

function dedupeByUrl(items){ const seen=new Set(); const out=[]; for(const it of items){ const k=(it.url||'').split('#')[0]; if(!k) continue; if(!seen.has(k)){ seen.add(k); out.push(it);} } return out; }

function nodeJson(body, status = 200, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extraHeaders },
    body: JSON.stringify(body)
  };
}

function timeout(ms) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}
