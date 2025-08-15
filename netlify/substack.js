// netlify/functions/substack.js
// Fetch Substack via RSS (preferred) with JSON archive fallback; return clear errors.

const DEFAULT_FEED = "https://thecerfreport.substack.com/feed"; // <-- change if your subdomain is different

function unescapeHtml(s=""){return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");}
function stripTags(s=""){return s.replace(/<\/?[^>]+(>|$)/g, "").trim();}
function absolutize(url, host){
  if(!url) return "";
  if(/^https?:\/\//i.test(url)) return url;
  if(url.startsWith("//")) return "https:"+url;
  if(url.startsWith("/")) return `https://${host}${url}`;
  return `https://${host}/${url}`;
}
function parseRss(xml, host){
  const items=[]; const re=/<item>([\s\S]*?)<\/item>/g; let m;
  while((m=re.exec(xml))){
    const b=m[1];
    const pick=(tag)=>{
      const rx=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,"i");
      const mm=rx.exec(b);
      return mm ? unescapeHtml(mm[1].trim()) : "";
    };
    const title = stripTags(pick("title"));
    const link  = pick("link") || pick("guid");
    const desc  = stripTags(pick("description") || pick("content:encoded"));
    const date  = pick("pubDate") || pick("dc:date");
    if (title || link) items.push({ title, url: absolutize(link, host), description: desc, publishedAt: date });
  }
  return items;
}

async function tryRSS(feedUrl){
  const host=new URL(feedUrl).host;
  const r=await fetch(feedUrl,{
    headers:{
      "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept":"application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "Cache-Control":"no-cache",
      "Referer":`https://${host}/`
    }
  });
  if(!r.ok) throw new Error("rss " + r.status);
  const xml=await r.text();
  const items=parseRss(xml, host);
  if(!items.length) throw new Error("rss empty");
  return items;
}

async function tryArchiveJSON(pubHost){
  const url=`https://${pubHost}/api/v1/archive?sort=new`;
  const r=await fetch(url,{ headers:{
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept":"application/json"
  }});
  if(!r.ok) throw new Error("archive " + r.status);
  const posts=await r.json();
  return posts.slice(0,10).map(p=>({
    title: stripTags(p.title || p.headline || ""),
    url: absolutize(p.canonical_url || `/p/${p.slug}`, pubHost),
    description: stripTags(p.subtitle || p.description || ""),
    publishedAt: p.post_date || p.published_at || ""
  }));
}

export async function handler(event){
  try{
    const feed = event.queryStringParameters?.feed || DEFAULT_FEED;
    const pubHost = new URL(feed).host;

    let articles = [];
    let lastError = null;

    try { articles = await tryRSS(feed); }
    catch (e) { lastError = e; }

    if (!articles.length) {
      try { articles = await tryArchiveJSON(pubHost); }
      catch (e2) { lastError = e2; }
    }

    if (!articles.length) {
      return {
        statusCode: 502,
        headers:{ "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
        body: JSON.stringify({ status:"error", message: (lastError && lastError.message) || "no articles" })
      };
    }

    return {
      statusCode: 200,
      headers:{ "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
      body: JSON.stringify({ status:"ok", articles })
    };
  } catch(e){
    return {
      statusCode: 500,
      headers:{ "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
      body: JSON.stringify({ status:"error", message: e.message })
    };
  }
}


