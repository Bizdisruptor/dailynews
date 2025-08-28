// netlify/functions/mini-market.js
// Minimal server-side fetch for just BTC-USD and XAU-USD with caching + timeouts.
// Requires Netlify Functions runtime Node 18+ (has global fetch).

const fs = require("fs");
const CACHE_FILE = "/tmp/mini-market-cache.json";
const TTL_MS = 1000 * 60 * 3; // 3 minutes
const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

function readCache() {
  try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : null; }
  catch { return null; }
}
function writeCache(obj) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj)); } catch {}
}

async function withTimeout(fetcher, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetcher(ac.signal); }
  finally { clearTimeout(t); }
}

// Providers (server-side = no CORS drama)
async function getBTC_USD() {
  // Primary: Coingecko
  const res = await withTimeout(sig => fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", { signal: sig }));
  if (!res.ok) throw new Error("BTC primary HTTP " + res.status);
  const j = await res.json();
  let val = j?.bitcoin?.usd ?? null;
  if (typeof val === "number") return val;

  // Fallback: Yahoo quote
  const y = await withTimeout(sig => fetch("https://query1.finance.yahoo.com/v7/finance/quote?symbols=BTC-USD", { signal: sig }));
  if (!y.ok) throw new Error("BTC fallback HTTP " + y.status);
  const jj = await y.json();
  const q = jj?.quoteResponse?.result?.[0];
  return (typeof q?.regularMarketPrice === "number") ? q.regularMarketPrice : null;
}

async function getXAU_USD() {
  // Primary: exchangerate.host XAU->USD
  const res = await withTimeout(sig => fetch("https://api.exchangerate.host/convert?from=XAU&to=USD"
