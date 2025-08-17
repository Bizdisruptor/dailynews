// netlify/functions/get-links.js
// Reads curated links from a Google Sheet with a robust caching strategy.
const fetch = require("node-fetch");
const fs = require("fs");

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const CACHE_FILE = "/tmp/recommended-cache.json";
const TTL_MS = 1000 * 60 * 3; // Consider cache fresh for 3 minutes

// The URL for your Google Sheet, published as a CSV
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRzkojI6qgs3Nyxsv6lXbhVpyxxRi2B62TQolcAML3HpM891nm1WakftcTP6H4HQp6oL0EmG0UT-ZoU/pub?output=csv';

// --- Caching Utilities ---
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

// --- Data Fetching and Processing ---
// ✅ FIX: Replaced the simple CSV parser with a more robust one that handles commas in titles.
function parseCsv(csvText) {
    const lines = csvText.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    const headers = lines.shift().split(',').map(h => h.trim().toLowerCase());
    
    const regex = /(?:^|,)(\"(?:[^\"]+|\"\")*\"|[^,]*)/g;

    return lines.map(line => {
        let values = [];
        let match;
        while (match = regex.exec(line)) {
            let value = match[1].replace(/^"|"$/g, '').replace(/""/g, '"');
            values.push(value);
        }
        
        const article = {};
        headers.forEach((header, i) => {
            article[header] = values[i] || '';
        });
        return article;
    }).filter(a => a.url && a.title);
}


// --- Main Handler ---
exports.handler = async function() {
  try {
    // 1. Serve a fresh cache if it's new enough
    const cached = readCache();
    if (cached && (Date.now() - (cached.ts || 0) <= TTL_MS)) {
      console.log("Serving fresh recommended links from cache.");
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }

    // 2. Fetch live data
    console.log("Fetching live recommended links from Google Sheet...");
    const response = await fetch(SHEET_CSV_URL);
    if (!response.ok) throw new Error(`Google Sheet fetch failed: ${response.status}`);
    
    const csvText = await response.text();
    const articles = parseCsv(csvText).reverse(); // .reverse() for FIFO
    
    const payload = { status: "ok", articles };
    writeCache(payload);

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };

  } catch (e) {
    console.warn(`Live recommended fetch failed: ${e.message}. Attempting to serve from stale cache.`);
    // 3. Fallback to stale cache if live fetch fails
    const cached = readCache();
    if (cached?.payload) {
      console.log("Serving stale recommended links from cache.");
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cached.payload) };
    }
    
    console.error("Cache is empty. No recommended links to serve.");
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ status: "error", message: e.message }) };
  }
};
