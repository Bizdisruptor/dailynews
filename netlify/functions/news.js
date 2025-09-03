// netlify/functions/news.js (CommonJS)
// RSS-first, optional APIs, ETag/304, cooldown, no JSX-like regex.

const fs = require("fs");

// ---- config
const HEADERS = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" };
const CACHE_DIR = "/tmp";
const DEFAULT_SECTION = "frontpage";
const MAP = {
  frontpage: ["rss", "newsapi", "gnews", "newsdata"],
  world:     ["rss", "newsapi", "gnews", "newsdata"],
  tech:      ["rss", "newsapi", "gnews", "newsdata"],
  finance:   ["rss", "newsapi", "gnews", "finnhub"],
};
const COOLDOWN_MS = 5 * 60 * 1000;
const TIMEOUT_MS  = 7000;

module.exports.handler = async (event) => {
  const raw = (event?.queryStringParameters?.section || DEFAULT_SECTION).toLowerCase().trim();
  const section = Object.prototype.hasOwnProperty.call(MAP, raw) ? raw : DEFAULT_SECTION;

  const cache = readCache(section); // {articles, etag, updatedAt, lastTriedAt}
  const clientETag = event?.headers?.["if-none-match"] || event?.headers?.["If-None-Match"];

  if (cache?.etag && clientETag === cache.etag && withinCooldown(cache)) {
    return { statusCode: 304, headers: { ETag: cache.etag, ...HEADERS } };
  }
  if (withinCooldown(cache) && cache?.articles?.length) {
    return jsonWithETag({ status: "ok", articles: cache.articles, source: "cache" }, cache.etag);
  }

  let got = null;
  const providers = MAP[section] || ["rss"];
  for (const p of providers) {
    try {
      if (p === "newsapi"  && !process.env.NEWSAPI_KEY) continue;
      if (p === "gnews"    && !process.env.GNEWS_API_KEY) continue;
      if (p === "newsdata" && !process.env.NEWSDATA_KEY) continue;
      if (p === "finnhub"  && !process.env.FINNHUB_API_KEY) continue;

      const articles = await withTimeout((signal) => PROVIDERS[p](section, { signal }), TIMEOUT_MS);
      const cleaned = sanitizeArticles(articles);
      if (cleaned.length) { got = { articles: cleaned, source: p }; break; }
    } catch (e) {
      console.warn(`[news][${section}] ${p} failed:`, e?.message || e);
    }
  }

  touchLastTried(section);

  if (got) {
    const etag = makeETag(got.articles);
    writeCache(section, got.articles, etag);
    return jsonWithETag({ status: "ok", articles: got.articles, source: got.source }, etag);
  }

  if (cache?.articles?.length) {
    if (clientETag && cache.etag && clientETag === cache.etag) {
      return { statusCode: 304, headers: { ETag: cache.etag, ...HEADERS } };
    }
    return jsonWithETag({ status: "ok", articles: cache.articles, source: "cache" }, cache.etag);
  }

  return json({ status: "error", message: "No news available." }, 502);
};

// ---- providers
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
      } catch (e) { console.warn(`[rss] ${url} failed:`, e?.message || e); }
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

// ---- RSS helpers
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
  const itemRe  = new RegExp("<item[\\s\\S]*?<\\/item>", "gi");
  const entryRe = new RegExp("<entry[\\s\\S]*?<\\/entry>", "gi");
  const blocks = xml.match(itemRe) || xml.match(entryRe) || [];
  for (const b of blocks) {
    const title = grabTag(b, "title");
    let link = grabTag(b, "link");
    if (!link) link = grabAttr(b, "link", "href") || grabAttr(b, "link", "rel=\"alternate\" href");
    const desc = grabTag(b, "description") || grabTag(b, "summary") || "";
    const pub  = grabTag(b, "pubDate") || grabTag(b, "updated") || grabTag(b, "published") || "";
    if (title && link) {
      const summary = stripHTML(decode(desc)).slice(0, 280);
      out.push({ title: decode(title), url: link, source: host(link), summary, ts: toISO(pub) });
    }
  }
  return out;
}
function grabTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}
function grabAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

// ---- utils
function norm(title, url, source, summary, ts) {
  if (!title || !url) return null;
  return {
    title: String(title).trim(),
    url: String(url).trim(),
    source: source ? String(source).trim() : host(url),
    description: (summary || "").toString().trim(),
    publishedAt: toISO(ts),
  };
}
function toISO(t) {
  if (!t) return new Date().toISOString();
  const d = typeof t === "number" ? new Date(t) : new Date(String(t));
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
function stripHTML(s = "") { return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function decode(s = "") {
  return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

function cachePath(section) { return `${CACHE_DIR}/cerf-news-${section}.json`; }
function readCache(section) {
  try {
    if (!fs.existsSync(cachePath(section))) return null;
    const raw = JSON.parse(fs.readFileSync(cachePath(section), "utf8"));
    raw.articles = sanitizeArticles(raw.articles || []);
    return raw;
  } catch { return null; }
}
function writeCache(section, articles, etag) {
  try {
    const meta = { articles: sanitizeArticles(articles), etag, updatedAt: Date.now(), lastTriedAt: Date.now() };
    fs.writeFileSync(cachePath(section), JSON.stringify(meta));
  } catch {}
}
function touchLastTried(section) {
  try {
    const m = readCache(section) || { articles: [], etag: "", updatedAt: 0, lastTriedAt: 0 };
    m.lastTriedAt = Date.now();
    fs.writeFileSync(cachePath(section), JSON.stringify(m));
  } catch {}
}
function withinCooldown(cache) { return !!cache && (Date.now() - (cache.lastTriedAt || 0) < COOLDOWN_MS); }
function makeETag(articles) {
  const s = JSON.stringify(sanitizeArticles(articles));
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `"W/${h.toString(16)}-${s.length}"`;
}
function sanitizeArticles(arr) {
  const list = (Array.isArray(arr) ? arr : [])
    .filter(Boolean).filter(a => a?.title && a?.url)
    .map(a => ({ ...a, description: (a.description || "").toString().trim(), publishedAt: toISO(a.publishedAt), source: a.source || host(a.url) }));
  const seen = new Set(), out = [];
  for (const it of list) {
    const k = (it.url || "").split("#")[0];
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
  }
  out.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return out;
}
function json(body, status = 200, extra = {}) {
  return { statusCode: status, headers: { ...HEADERS, ...extra }, body: JSON.stringify(body) };
}
function jsonWithETag(body, etag) { return json(body, 200, { ETag: etag || "" }); }
function withTimeout(run, ms) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const id = setTimeout(() => { ctrl.abort(); reject(new Error("timeout")); }, ms);
    Promise.resolve(run(ctrl.signal)).then(resolve).catch(reject).finally(() => clearTimeout(id));
  });
}
