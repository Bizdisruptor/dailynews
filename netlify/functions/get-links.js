// netlify/functions/get-links.js
// Reads curated article links from a public Google Sheet.
const fetch = require("node-fetch");

const SHEET_ID = '1ZcU1KL1cg_M3AEvVt-1lQ9wjFidpVO7Ur3Tt4Q-jo9I';
const API_URL = `https://spreadsheets.google.com/feeds/cells/${SHEET_ID}/od6/public/values?alt=json`;

// Helper function to parse the strange format Google Sheets returns
function parseSheet(data) {
  const entries = data.feed.entry;
  if (!entries || entries.length === 0) return [];

  const rows = [];
  let currentRow = [];
  let lastRow = '1';

  for (const entry of entries) {
    const cell = entry.gs$cell;
    if (cell.row !== lastRow) {
      rows.push(currentRow);
      currentRow = [];
      lastRow = cell.row;
    }
    currentRow.push(cell.$t);
  }
  rows.push(currentRow);

  const headers = rows.shift().map(h => h.toLowerCase());
  return rows.map(row => {
    const article = {};
    headers.forEach((header, i) => {
      article[header] = row[i] || '';
    });
    return article;
  }).filter(a => a.url && a.title); // Ensure basic data exists
}

exports.handler = async function() {
  try {
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(`Google Sheet fetch failed: ${response.status}`);
    const data = await response.json();
    const articles = parseSheet(data).reverse(); // .reverse() for FIFO

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300" // Cache for 5 minutes
      },
      body: JSON.stringify({ status: "ok", articles }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ status: "error", message: e.message }),
    };
  }
};
