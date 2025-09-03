<script>
// ... keep helpers ...

function etagKey(section){ return `news-etag-${section}`; }

async function fetchNews(section){
  const key = etagKey(section);
  const etag = localStorage.getItem(key) || '';
  const url  = ABS("/.netlify/functions/news?section=" + encodeURIComponent(section));
  const r = await fetch(url, { headers: etag ? { 'If-None-Match': etag } : {} });

  if (r.status === 304) return { notModified: true };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const et = r.headers.get('etag');
  const data = await r.json();
  if (et) localStorage.setItem(key, et);
  return { data };
}

async function updateAll(){
  // ... keep mini-market block ...

  const sections = [
    { id: "front-card",   section: "frontpage", label: "Front Page" },
    { id: "tech-card",    section: "tech",      label: "Technology" },
    { id: "world-card",   section: "world",     label: "World News" },
    { id: "finance-card", section: "finance",   label: "Finance" }
  ];

  try {
    const promises = sections.map(s => fetchNews(s.section).catch(e => ({ error: e })));
    const results = await Promise.all(promises);

    results.forEach((res, i) => {
      const { id, label } = sections[i];
      const listEl = document.querySelector(`#${id} .list`);
      if (res?.notModified) {
        // No change — keep existing DOM as-is.
        return;
      }
      if (res?.error) {
        // Only show an error if the card is empty; otherwise leave current content.
        if (!listEl || !listEl.children.length) {
          renderNewsList(listEl, [], `Could not load ${label}.`);
        }
        return;
      }
      // We have fresh data
      renderNewsList(listEl, res.data?.articles || [], `Could not load ${label}.`);
      stamp(document.getElementById(id));
    });

  } catch (e) {
    console.error("News update error:", e);
  }

  const year = new Date().getFullYear();
  document.getElementById("updatedAt").textContent =
    `Updated ${new Date().toLocaleString()} • © ${year} Disruptive Business Solution LLC`;
}
</script>
