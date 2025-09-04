// netlify/functions/add-link.js
const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ ok: true, msg: "add-link alive" }),
  };
};
