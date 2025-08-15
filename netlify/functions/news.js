export async function handler(event) {
  try {
    const { category = "general" } = event.queryStringParameters || {};
    const url = `https://newsapi.org/v2/top-headlines?country=us&category=${encodeURIComponent(category)}&pageSize=10`;

    const r = await fetch(url, {
      headers: { "X-Api-Key": process.env.NEWSAPI_KEY }
    });

    if (!r.ok) {
      const text = await r.text();
      return {
        statusCode: r.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: text
      };
    }

    const data = await r.text();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: data
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message })
    };
  }
}
