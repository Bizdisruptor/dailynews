// netlify/functions/get-links.js
// Reads curated article links from a Google Sheet published as a CSV.
const fetch = require("node-fetch");

// IMPORTANT: This must be the URL from the "Publish to web" dialog
// after you select "Comma-separated values (.csv)".
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRzkojI6qgs3Nyxsv6lXbhVpyxxRi2B62TQolcAML3HpM891nm1WakftcTP6H4HQp6oL0EmG0UT-ZoU/pub?output=csv';

// Helper function to parse CSV text into an array of objects
function parseCsv(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines.shift().split(',').map(h => h.trim().toLowerCase());
  
  return lines.map(line => {
    const values = line.split(',');
    const article = {};
    headers.forEach((header, i) => {
      // Handle cases where a value might contain a comma by joining the rest of the array
      const value = (i === values.length - 1) ? values[i] : values.slice(i).join(',');
      // Basic cleanup to remove potential quotes from CSV values
      article[header] = values[i] ? values[i].replace(/"/g, '').trim() : '';
    });
    return article;
  }).filter(a => a.url && a.title); // Ensure basic data exists
}

exports.handler = async function() {
  try {
    const response = await fetch(SHEET_CSV_URL);
    if (!response.ok) throw new Error(`Google Sheet fetch failed: ${response.status}`);
    
    const csvText = await response.text();
    const articles = parseCsv(csvText).reverse(); // .reverse() for FIFO

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
