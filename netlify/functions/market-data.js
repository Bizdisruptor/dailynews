<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>The Cerf Report — Curated News</title>
  <style>
    :root { --blue:#0056b3; --ink:#1c1e21; --muted:#606770; --paper:#fff; --bg:#f0f2f5; --positive:#17823b; --negative:#b00020; }
    * { box-sizing:border-box; }
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:18px}
    h1{text-align:center;color:var(--blue);margin:0 0 6px}
    .subhead{text-align:center;color:var(--muted);margin:0 0 18px;font-size:.95rem}

    .market {
      background:var(--paper); border-radius:12px; box-shadow:0 2px 6px rgba(0,0,0,.08);
      padding:12px 14px; margin:0 auto 18px; max-width:1400px;
    }
    .market .row { display:flex; flex-wrap:wrap; gap:16px 24px; align-items:center; justify-content: center;}
    .chip { display:flex; gap:6px; align-items:center; font-size:.92rem; }
    .chip a { color:inherit; text-decoration:none; font-weight:600; }
    .chip a:hover { text-decoration:underline; color:var(--blue); }
    .price { font-weight:600; }
    .chg.positive{ color:var(--positive); }
    .chg.negative{ color:var(--negative); }
    .divider { height:10px }

    .mover-grid { display:grid; gap:10px 14px; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); margin-top:8px; }
    .mgroup h3 { margin:0 0 6px; font-size:.8rem; color:var(--blue); letter-spacing:.5px; text-transform:uppercase; }
    .mlist div { display:flex; justify-content:space-between; font-size:.88rem; padding:1px 0; }
    .mlist a { font-weight:600; color:inherit; text-decoration:none; }
    .mlist a:hover { text-decoration:underline; color:var(--blue); }

    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:18px; max-width:1400px; margin:0 auto}
    .card{background:var(--paper);border-radius:12px;box-shadow:0 2px 6px rgba(0,0,0,.08);padding:16px;overflow:hidden}
    .card h2{margin:0 0 8px;border-bottom:2px solid var(--blue);padding-bottom:8px;font-size:1.1rem}
    .section-link{margin:-4px 0 8px}
    .section-link a{font-size:.9rem;text-decoration:none}
    .section-link a:hover{text-decoration:underline}
    .list{max-height:520px;overflow-y:auto;padding-right:8px;min-height:100px}
    .item{margin:0 0 12px;border-bottom:1px solid #eee;padding:0 0 10px}
    .item:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
    .item a{color:#0d6efd;text-decoration:none;font-weight:600}
    .item a:hover{text-decoration:underline}
    .item p{margin:6px 0 0;color:var(--muted);font-size:.92rem;line-height:1.35}
    .loading{text-align:center;padding:14px;color:var(--muted);line-height:1.4;}
    .footer{margin:16px auto 0;text-align:center;color:#8a8f98;font-size:.85rem;max-width:1400px}
  </style>
</head>
<body>
  <h1>The Cerf Report — Curated News</h1>
  <div class="subhead">News minus the junk. Tech, finance, and interesting stuff.</div>

  <div class="market" id="market"><div class="loading">Loading market data…</div></div>

  <div class="grid">
    <div class="card" id="front-card">
      <h2>Front Page</h2>
      <div class="list"><div class="loading">Loading…</div></div>
    </div>
    <div class="card" id="tech-card">
      <h2>Technology</h2>
      <div class="list"><div class="loading">Loading…</div></div>
    </div>
    <div class="card" id="world-card">
      <h2>World News</h2>
      <div class="list"><div class="loading">Loading…</div></div>
    </div>
    <div class="card" id="finance-card">
      <h2>Finance</h2>
      <div class="list"><div class="loading">Loading…</div></div>
    </div>
    <div class="card" id="cerf-card">
      <h2>The Cerf Report</h2>
      <div class="section-link">
        <a href="https://thecerfreport.substack.com/" target="_blank" rel="noopener noreferrer">
          thecerfreport.substack.com →
        </a>
      </div>
      <div class="list"><div class="loading">Loading…</div></div>
    </div>
  </div>

  <div class="footer" id="updatedAt"></div>

  <script>
    const ABS = (path) => new URL(path, location.origin).toString();
    const FINANCE = (t) => `https://finance.yahoo.com/quote/${encodeURIComponent(t)}`;
    const $ = (sel, root=document) => root.querySelector(sel);

    const sections = [
      { id: "front-card",   section: "frontpage" },
      { id: "tech-card",    section: "tech" },
      { id: "world-card",   section: "world" },
      { id: "finance-card", section: "finance" },
    ];

    function fmt(n, d=2){ if(n==null || isNaN(n)) return "—"; return (+n).toFixed(d); }
    function chipHTML(q){
      if (!q) return '';
      const sign = (q.d ?? 0) >= 0 ? "+" : "";
      const cls  = (q.d ?? 0) >= 0 ? "positive" : "negative";
      return `<span class="chip">
        <a href="${FINANCE(q.ticker)}" target="_blank" rel="noopener">${q.name}</a>
        <span class="price">${fmt(q.c)}</span>
        <span class="chg ${cls}">${sign}${fmt(q.d)} (${sign}${fmt(q.dp)}%)</span>
      </span>`;
    }
    function listHTML(arr){
      return (arr||[]).map(q=>{
        const sign=(q.d??0)>=0?"+":""; const cls=(q.d??0)>=0?"positive":"negative";
        return `<div>
          <a href="${FINANCE(q.ticker)}" target="_blank" rel="noopener">${q.ticker}</a>
          <span class="${cls}">${sign}${fmt(q.d)} (${sign}${fmt(q.dp)}%)</span>
        </div>`;
      }).join('');
    }

    function renderMarket(data){
      const m = $('#market');
      if(!data){ m.innerHTML = '<div class="loading">Could not load market data.</div>'; return; }
      const macro   = (data.macro||[]).map(chipHTML).join('<span class="divider"></span>');
      const indices = (data.indices||[]).map(chipHTML).join('<span class="divider"></span>');
      const ai      = listHTML(data.ai);
      const crypto  = listHTML(data.crypto);
      const energy  = listHTML(data.energy);
      m.innerHTML = `
        <div class="row">${macro}</div>
        <div class="divider"></div>
        <div class="row">${indices}</div>
        <div class="mover-grid">
          <div class="mgroup"><h3>AI</h3><div class="mlist">${ai}</div></div>
          <div class="mgroup"><h3>CRYPTO</h3><div class="mlist">${crypto}</div></div>
          <div class="mgroup"><h3>ENERGY</h3><div class="mlist">${energy}</div></div>
        </div>`;
    }

    function renderNewsList(listEl, articles){
      if(!articles || !articles.length){
        if (listEl.innerHTML.includes('loading')) {
            listEl.innerHTML = '<div class="loading">Could not load news at this time.</div>';
        }
        return;
      }
      listEl.innerHTML = "";
      for(const a of articles){
        if(!a || !a.title) continue;
        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = `<a href="${a.url}" target="_blank" rel="noopener noreferrer">${a.title}</a>
                         <p>${a.description ? a.description : ""}</p>`;
        listEl.appendChild(div);
      }
    }

    async function fetchJSON(url){
      try{
        const r = await fetch(url, { redirect: "follow" });
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      }catch(e){
        console.error("Fetch failed:", url, e);
        throw e;
      }
    }

    async function fetchMarket(){
      const data = await fetchJSON(ABS("/.netlify/functions/market-data"));
      if(data.status !== "ok" || !data.data) throw new Error("Bad market payload");
      return data.data;
    }
    async function fetchNews(section){
      const data = await fetchJSON(ABS(`/.netlify/functions/news?section=${encodeURIComponent(section)}`));
      if(data.status !== "ok") return null;
      return data.articles || null;
    }
    async function fetchCerf(){
      const data = await fetchJSON(ABS("/.netlify/functions/substack?mode=archive"));
      if(data.status !== "ok" || !Array.isArray(data.articles)) return null;
      return data.articles.map(a=>({ title:a.title||"Untitled", url:a.url, description:a.description||"" }));
    }

    async function updateAll(){
      // Market
      try{
        const market = await fetchMarket();
        renderMarket(market);
      }catch(e){
        console.error("Market error:", e);
        renderMarket(null);
      }

      // News
      try{
        const results = await Promise.all([
          ...sections.map(s => fetchNews(s.section).catch(err => (console.error(s.section, err), null))),
          fetchCerf().catch(err => (console.error("substack", err), null))
        ]);
        sections.forEach((s, i) => renderNewsList($(`#${s.id} .list`), results[i]));
        renderNewsList($("#cerf-card .list"), results[results.length-1]);
      }catch(e){
        console.error("News update error:", e);
      }

      $("#updatedAt").textContent = "Updated " + new Date().toLocaleString();
    }

    document.addEventListener("DOMContentLoaded", () => {
      updateAll();
      setInterval(updateAll, 5 * 60 * 1000);
    });
  </script>
</body>
</html>
