// Proxies Yahoo Finance chart endpoint (no auth/crumb needed) for a single symbol.
// Returns daily OHLCV history used for: price, prev close, 4-week advance %,
// VWAP approximation, and volume vs trailing average.
// GET /api/chart?symbol=RELIANCE.NS&range=6mo&interval=1d

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

exports.handler = async (event) => {
  const symbol = event.queryStringParameters?.symbol;
  const range = event.queryStringParameters?.range || "6mo";
  const interval = event.queryStringParameters?.interval || "1d";

  if (!symbol) {
    return resp(400, { error: "symbol query param is required" });
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}&includePrePost=false`;

  try {
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) {
      return resp(r.status, { error: `Upstream error ${r.status}`, symbol });
    }
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      return resp(404, { error: "No data", symbol, raw: data?.chart?.error || null });
    }

    const ts = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const closes = quote.close || [];
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const volumes = quote.volume || [];
    const meta = result.meta || {};

    const candles = ts.map((t, i) => ({
      t,
      o: opens[i],
      h: highs[i],
      l: lows[i],
      c: closes[i],
      v: volumes[i],
    })).filter((c) => c.c !== null && c.c !== undefined);

    return resp(200, {
      symbol,
      currency: meta.currency,
      exchangeName: meta.exchangeName,
      regularMarketPrice: meta.regularMarketPrice,
      previousClose: meta.chartPreviousClose ?? meta.previousClose,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      candles,
    });
  } catch (err) {
    return resp(500, { error: String(err), symbol });
  }
};

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=120",
    },
    body: JSON.stringify(body),
  };
};
