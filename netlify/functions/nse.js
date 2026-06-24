// Generic proxy for NSE India's public JSON API.
//
// WHY THIS EXISTS: nseindia.com blocks plain requests without a valid session
// cookie, and it's known to rate-limit / geo-block requests from cloud
// datacenter IPs (which is exactly what serverless hosts like Netlify run
// on). This function does a best-effort: visit the NSE homepage first to
// mint a session cookie, then reuse it for the API call. If NSE blocks the
// request anyway, it returns a clear error the frontend can show as
// "data temporarily unavailable" rather than crashing.
//
// Supported via ?path=quote-equity|stock-indices|historical
//   /api/nse?path=quote-equity&symbol=RELIANCE
//   /api/nse?path=stock-indices&index=NIFTY%20IT
//   /api/nse?path=historical&symbol=RELIANCE&from=01-05-2026&to=23-06-2026

const BASE = "https://www.nseindia.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

let cachedCookie = null;
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 4 * 60 * 1000; // refresh cookie every 4 min

async function getCookie() {
  const now = Date.now();
  if (cachedCookie && now - cookieFetchedAt < COOKIE_TTL_MS) return cachedCookie;
  const r = await fetch(`${BASE}/`, { headers: HEADERS });
  const setCookie = r.headers.get("set-cookie");
  cachedCookie = setCookie || "";
  cookieFetchedAt = now;
  return cachedCookie;
}

function buildUrl(params) {
  const { path, symbol, index, from, to } = params;
  switch (path) {
    case "quote-equity":
      return `${BASE}/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;
    case "stock-indices":
      return `${BASE}/api/equity-stockIndices?index=${encodeURIComponent(index)}`;
    case "historical":
      return `${BASE}/api/historical/cm/equity?symbol=${encodeURIComponent(
        symbol
      )}&series=[%22EQ%22]&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    default:
      return null;
  }
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const url = buildUrl(params);
  if (!url) {
    return resp(400, { error: "Unknown or missing 'path' param" });
  }

  try {
    const cookie = await getCookie();
    const r = await fetch(url, {
      headers: { ...HEADERS, Cookie: cookie },
    });

    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // NSE returned an HTML block page (region/bot block) instead of JSON
      return resp(503, {
        error: "nse_unavailable",
        message:
          "NSE blocked this request (common for cloud-hosted requests). Try again shortly, or refresh data locally.",
      });
    }

    return resp(200, data);
  } catch (err) {
    return resp(500, { error: String(err) });
  }
};

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
    body: JSON.stringify(body),
  };
}
