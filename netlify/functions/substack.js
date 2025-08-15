// netlify/functions/substack.js
// Substack → JSON: use RSS first, fall back to archive JSON.
// Always provide a usable `title` (fallbacks if missing).

const DEFAULT_FEED = "https://thecerfreport.substack.com/feed";

const ENT = { "&lt;":"<", "&gt;":">", "&amp;":"&", "&quot;":'"', "&#39;":"'" };
const unescapeHtml = (s="") => s.replace(/(&lt;|&gt;|&amp;|&quot;|&#39;)/g, m => ENT[m] || m);
const stripTags      = (s="") => unescapeHtml(s).replace(/<\/?[^>]+>/g,"").replace(/\s+/g," ").trim();

function absolutize(url, host){
  if(!url) return "";
  if(/^https?:\/\//i.test(url)) return url;
  if(url.startsWith("//")) return "https:"+url;
  if(url.startsWith("/"))  return `https://${host}${url}`;
  return `https://${host}/${url}`;
}

function fallbackTitle({title, description}) {
  const t = (title || "").trim();
  if (t) return t;
  const d = (description || "").trim();
  if (d) return (d.length > 90 ? d.slice(0, 87) + "…" : d);
  return "Untitled";
}

// ---------- RSS ----------
function parseRss(xml, host) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      const rx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const mm = rx.exec(block);
      return mm ? mm[1] : "";
    };
    const rawTitle = stripTags(pick("title"));
    const rawDesc  = stripTags(pick("description") || pick("content:encoded"));
    const rawLink  = stripTags(pick("link") || pick("guid"));
    items.push({
      title: fallbackTitle({ title: rawTitle, description: rawDesc }),
      url: absolutize(rawLink, host),
      description: rawDesc,
      publishedAt: stripTags(pick("pubDate") || pick("dc:date")),
    });
  }
  return items;
}

async function tryRSS(feedUrl) {
  const host = new URL(feedUrl).host;
  const r = await fetch(feedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "Cache-Control": "no-cache",
      "Referer": `https://${host}/`
    }
  });
  if (!r.ok) throw new Error("rss " + r.status);
  const xml = await r.text();
  const items = parseRss(xml, host);
  if (!items.length) throw new Error("rss empty");
  return items;
}

// ---------- Archive JSON fallback ----------
async function tryArchiveJSON(pubHost){
  const url = `https://${pubHost}/api/v1/archive?sort=new`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept": "application/json"
    }
  });
  if (!r.ok) throw new Error("archive " + r.status);
  const posts = await r.json();
  return posts.slice(0, 10).map(p => {
    const title = p.title || p.headline || p.subject_line || p.name || "";
    const desc  = p.subtitle || p.description || "";
    return {
      title: fallbackTitle({ title: stripTags(title), description: stripTags(desc) }),
      url: absolutize(p.canonical_url || `/p/${p.slug}`, pubHost),
      description: stripTags(desc),
      publishedAt: p.post_date || p.published_at || ""
    };
  });
}

export async function handler(event){
  try{
    const feed = event.queryStringParameters?.feed || DEFAULT_FEED;
    const pubHost = new URL(feed).host;
    // ✅ FIX: This logic checks for "mode=archive" and skips the failing RSS step.
    const mode = (event.queryStringParameters?.mode || 'auto').toLowerCase();

    let articles = [];
    try {
      if (mode === 'archive') throw new Error('skip rss'); // Force archive path
      articles = await tryRSS(feed);
    } catch {
      articles = await tryArchiveJSON(pubHost);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
      body: JSON.stringify({ status:"ok", articles })
    };
  }catch(e){
    return {
      statusCode: 500,
      headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
      body: JSON.stringify({ status: "error", message: e.message })
    };
  }
}

