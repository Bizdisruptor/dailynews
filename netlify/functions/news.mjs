// Durable-news function with Netlify Blobs persistent cache.
// Delete the old netlify/functions/news.js so this is the only "news" handler.

import { createClient } from '@netlify/blobs'; // Node Functions
// If your build complains, switch to:  import { createClient } from 'netlify:blobs'  (Deno runtime)

const blobs = createClient();
const store = blobs.store('news-cache'); // logical bucket

const TTL_MS = 5 * 60 * 1000; // fetch freshness; serve cache when newer than this
const MAX_ITEMS = 25;

// Map sections -> providers (rotate until one works)
const PROVIDERS = {
  frontpage: ['newsapi', 'gnews', 'newsdata'],
  world:     ['newsapi', 'gnews', 'newsdata'],
  tech:      ['newsapi', 'gnews', 'newsdata'],
  finance:   ['newsapi', 'gnews', 'newsdata', 'finnhub'], // finance has special fallback
};

export default async (req) => {
  const url = new URL(req.url);
  const section = (url.searchParams.get('section') || 'frontpage').toLowerCase();
  if (!PROVIDERS[section]) return json({ error: 'unknown section' }, 400);

  const cacheKey = `news/${section}.json`;

  // 1) Try fresh fetch (rotating providers)
  const attempt = await fetchSection(section).catch(e => ({ error: e }));

  if (!attempt.error) {
    // Write durable cache and return
    const payload = { section, items: attempt.items.slice(0, MAX_ITEMS), fetchedAt: Date.now() };
    await store.setJSON(cacheKey, payload).catch(() => {});
    return json(payload, 200, { 'cache-control': 'public, max-age=120' });
  }

  // 2) Fall back to durable cache
  const cached = await store.get(cacheKey, { type: 'json' }).catch(() => null);
  if (cached && cached.items?.length) {
    return json({ ...cached, cached: true }, 200, { 'cache-control': 'public, max-age=120' });
  }

  // 3) Nothing to serve
  return json({ error: 'no-data', detail: attempt.error?.message || 'All providers failed and cache empty' }, 502);
};

/* ---------------- providers ---------------- */

async function fetchSection(section) {
  const order = PROVIDERS[section];
  for (const p of order) {
    try {
      const items = await PROVIDER_IMPL[p](section);
      if (items?.length) return { items };
    } catch (e) {
      // log and try next
      console.warn(`[provider:${p}] failed for ${section}:`, e.status || e.message || e);
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

  // Finance fallback example using Finnhub (headlines endpoint varies by plan; adjust if needed)
  async finnhub(_section) {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) throw new Error('FINNHUB_API_KEY missing');
    const now = Math.floor(Date.now() / 1000);
    const from = now - 24 * 3600;
    const url = new URL('https://finnhub.io/api/v1/news');
    url.searchParams.set('category', 'general');
    url.searchParams.set('token', key);
    const r = await fetch(url, { signal: timeout(8000) });
    await assertOK(r);
    const j = await r.json();
    return (Array.isArray(j) ? j : []).map(a => norm(a.headline, a.url, a.source, a.summary, a.datetime * 1000));
  },
};

/* ---------------- utils ---------------- */

function mapCategory(section) {
  return { world: 'general', tech: 'technology', finance: 'business' }[section] || 'general';
}
function mapGNewsTopic(section) {
  return { world: 'world', tech: 'technology', finance: 'business' }[section] || 'breaking-news';
}
function mapNewsDataCat(section) {
  return { world: 'world', tech: 'technology', finance: 'business' }[section] || 'top';
}

function norm(title, url, source, summary, ts) {
  if (!title || !url) return null;
  return {
    title: String(title).trim(),
    url: String(url).trim(),
    source: source ? String(source).trim() : host(url),
    summary: (summary || '').toString().trim(),
    ts: toISO(ts),
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

function toISO(t) {
  if (!t) return new Date().toISOString();
  const d = typeof t === 'number' ? new Date(t) : new Date(String(t));
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; } }
function timeout(ms) { if (AbortSignal.timeout) return AbortSignal.timeout(ms); const c=new AbortController(); setTimeout(()=>c.abort(), ms); return c.signal; }

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra },
  });
}
