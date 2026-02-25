// netlify/functions/get-links.js
// Reads curated links from a Google Sheet with a robust caching strategy.
// Uses the platform's global fetch (no node-fetch required).

const fs = require("fs");

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=180, s-maxage=180, stale-while-revalidate=60"
};

const CACHE_FILE = "/tmp/recommended-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes

// Publish your Google Sheet as CSV and paste the link here:
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRzkojI6qgs3Nyxsv6lXbhVpyxxRi2B62TQolcAML3HpM891nm1WakftcTP6H4HQp6oL0EmG0UT-ZoU/pub?output=csv";

// --- Cache helpers ---
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch {}
  return null;
}
function writeCache(payload) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), payload }));
  } catch {}
}

// --- Robust CSV parser (handles quoted commas/double quotes) ---
function parseCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const split = (line) => {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // lookahead for escaped quote
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const headers = split(lines.shift()).map((h) => h.replace(/^\uFEFF/, "").toLowerCase());
  const idx = (name) => headers.indexOf(name);

  const out = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const cols = split(raw);
    const rec = {};
    headers.forEach((h, i) => (rec[h] = (cols[i] || "").replace(/\r/g, "")));
    // Accept Title/URL in various capitalizations
    const title = rec.title || rec.name || rec.headline || "";
    const url = rec.url || rec.link || rec.href || "";
    if (title && url) {
      out.push({
        title,
        url,
        description: rec.description || rec.summary || rec.note || ""
      });
    }
  }
  return out;
}

// --- Fetch with timeout (AbortController) ---
async function fetchTextWithTimeout(url, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "TheCerfReport/1.0 (+https://thecerfreport.com)",
        "Accept": "text/csv, */*;q=0.8"
      },
      cache: "no-store"
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// --- Main handler ---
exports.handler = async function () {
  try {
    // 1) Fresh cache?
    const cached = readCache();
    if (cached && Date.now() - (cached.ts || 0) <= TTL_MS) {
      console.log("Serving recommended from fresh cache.");
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    // 2) Live fetch
    console.log("Fetching recommended from Google Sheet…");
    const csvText = await fetchTextWithTimeout(SHEET_CSV_URL, { timeoutMs: 5500 });
    const articles = parseCsv(csvText).reverse(); // FIFO newest-first

    const payload = { status: "ok", articles };
    writeCache(payload);

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
  } catch (e) {
    console.warn(`Live fetch failed: ${e.message}. Trying stale cache…`);
    const cached = readCache();
    if (cached?.payload) {
      console.log("Serving stale recommended from cache.");
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    console.error("No cache available.");
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({ status: "error", message: e.message })
    };
  }
};
