// Latest news headlines for a stock, via Google News RSS (no API key, no CORS
// issue server-side). Returns a simplified list of {title, link, source, pubDate}.
// GET /api/news?q=Reliance%20Industries

exports.handler = async (event) => {
  const q = event.queryStringParameters?.q;
  if (!q) return resp(400, { error: "q query param is required" });

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    q + " stock"
  )}&hl=en-IN&gl=IN&ceid=IN:en`;

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SectorDashboardBot/1.0)" },
    });
    if (!r.ok) return resp(r.status, { error: `Upstream error ${r.status}` });
    const xml = await r.text();

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) && items.length < 12) {
      const block = m[1];
      const title = extract(block, "title");
      const link = extract(block, "link");
      const pubDate = extract(block, "pubDate");
      const source = extract(block, "source");
      items.push({
        title: decodeEntities(title),
        link,
        pubDate,
        source: decodeEntities(source),
      });
    }

    return resp(200, { query: q, items });
  } catch (err) {
    return resp(500, { error: String(err) });
  }
};

function extract(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return "";
  return m[1].replace("<![CDATA[", "").replace("]]>", "").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=900",
    },
    body: JSON.stringify(body),
  };
}
