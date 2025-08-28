// netlify/functions/mini-market.js
exports.handler = async () => {
  const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  const payload = {
    status: "ok",
    data: { btcUSD: 0, xauUSD: 0 }
  };
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(payload) };
};
