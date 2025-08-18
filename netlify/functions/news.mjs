// netlify/functions/news.mjs
export default async (req, context) => {
  const section = new URL(req.url).searchParams.get('section') || 'frontpage';

  try {
    const url = mapSectionToEndpoint(section);      // <-- your mapping fn
    const res = await fetch(url, {
      headers: { 'user-agent': 'thecerfreport-bot/1.0' },
      redirect: 'follow',
      // simple timeout
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Upstream error', { section, status: res.status, text: text.slice(0, 300) });
      return json({ error: 'upstream', status: res.status }, res.status);
    }

    // choose json() or text() depending on the feed
    const data = await res.json();
    return json(data, 200);

  } catch (err) {
    console.error('Function error', { section, message: err.message, stack: err.stack });
    return json({ error: 'function', message: err.message }, 500);
  }
};

// helpers
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': status === 200 ? 'public, max-age=300' : 'no-store',
      ...extra
    }
  });
}
