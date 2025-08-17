// netlify/functions/add-link.js
// Securely receives data from a bookmarklet and forwards it to a Zapier webhook.
const fetch = require("node-fetch");

exports.handler = async function(event) {
  const { title, url, description, tag } = event.queryStringParameters;
  const secret = event.headers['x-secret-key'];

  // --- Security Check ---
  // Compare the secret from the header with the one set in your Netlify environment.
  if (secret !== process.env.SECRET_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }

  // --- Data Validation ---
  if (!title || !url) {
    return {
      statusCode: 400,
      body: "Title and URL are required.",
    };
  }

  const zapierWebhookUrl = process.env.ZAPIER_WEBHOOK_URL;
  if (!zapierWebhookUrl) {
    return {
      statusCode: 500,
      body: "Zapier webhook URL is not configured.",
    };
  }

  // --- Forward data to Zapier ---
  try {
    await fetch(zapierWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        url,
        description: description || '',
        tag: tag || 'general'
      })
    });

    // Return a simple success page
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <html lang="en">
        <body style="font-family: sans-serif; background: #f0f2f5; text-align: center; padding-top: 50px;">
          <h1 style="color: #0056b3;">Success!</h1>
          <p>The link has been added to your sheet.</p>
          <script>setTimeout(() => window.close(), 1500);</script>
        </body>
        </html>
      `
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: `Error forwarding to Zapier: ${e.message}`,
    };
  }
};
