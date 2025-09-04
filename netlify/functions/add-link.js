// netlify/functions/add-link.js
// Forwards a bookmark to a Zapier Catch Hook.
// Netlify env vars required: SECRET_KEY, ZAPIER_WEBHOOK_URL

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-secret",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: HEADERS, body: "" };
  }

  try {
    const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
    const SECRET_KEY = process.env.SECRET_KEY;

    if (!ZAPIER_WEBHOOK_URL) {
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: "ZAPIER_WEBHOOK_URL not set" }) };
    }
    if (!SECRET_KEY) {
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: "SECRET_KEY not set" }) };
    }

    let title, url, description, tag, providedSecret;

    if (event.httpMethod === "GET") {
      const p = event.queryStringParameters || {};
      title = p.title;
      url = p.url;
      description = p.description || "";
      tag = p.tag || "general";
      providedSecret = p.secret || event.headers["x-secret"];
    } else if (event.httpMethod === "POST") {
      const ct = (event.headers["content-type"] || "").toLowerCase();
      let body = {};
      if (ct.includes("application/json")) {
        body = event.body ? JSON.parse(event.body) : {};
      } else if (ct.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(event.body));
      }
      title = body.title;
      url = body.url;
      description = body.description || "";
      tag = body.tag || "general";
      providedSecret = body.secret || event.headers["x-secret"] || (event.queryStringParameters || {}).secret;
    } else {
      return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ status: "error", message: "Method not allowed" }) };
    }

    if (!providedSecret || providedSecret !== "curate_news_now") {
      // ^ you told me your SECRET_KEY is 'curate_news_now'. If you later change the env var, swap this to SECRET_KEY.
      return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ status: "error", message: "Unauthorized" }) };
    }
    if (!title || !url) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ status: "error", message: "Title and URL are required" }) };
    }

    const resp = await fetch(ZAPIER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, url, description, tag }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ status: "error", message: "Zapier responded " + resp.status, detail: text.slice(0, 300) }) };
    }

    // simple HTML success (avoids template literals)
    return {
      statusCode: 200,
      headers: { ...HEADERS, "Content-Type": "text/html" },
      body: '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:32px">' +
            '<h2>Saved ✅</h2><p>' + (title ? String(title) : "") + '</p>' +
            '<script>setTimeout(function(){window.close()},1200)</script>' +
            '</body></html>',
    };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: String(err) }) };
  }
};
