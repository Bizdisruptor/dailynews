// netlify/functions/add-link.js
// Receives a bookmark and forwards to a Zapier Catch Hook.
// Requires env vars: SECRET_KEY, ZAPIER_WEBHOOK_URL

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-secret",
};

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: HEADERS, body: "" };
  }

  try {
    const { ZAPIER_WEBHOOK_URL, SECRET_KEY } = process.env;

    if (!ZAPIER_WEBHOOK_URL) {
      return {
        statusCode: 500,
        headers: HEADERS,
        body: JSON.stringify({ status: "error", message: "ZAPIER_WEBHOOK_URL not set" }),
      };
    }
    if (!SECRET_KEY) {
      return {
        statusCode: 500,
        headers: HEADERS,
        body: JSON.stringify({ status: "error", message: "SECRET_KEY not set" }),
      };
    }

    // Read inputs (GET or POST)
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
      providedSecret =
        body.secret ||
        event.headers["x-secret"] ||
        (event.queryStringParameters || {}).secret;
    } else {
      return {
        statusCode: 405,
        headers: HEADERS,
        body: JSON.stringify({ status: "error", message: "Method not allowed" }),
      };
    }

    // Security + validation
    if (!providedSecret || provi
