// Precomputes sector/stock screening data straight from NSE and writes it
// into public/data/*.json, so the live site never has to call NSE itself
// (NSE blocks a lot of cloud/datacenter traffic, which made the old
// "Load metrics" on-demand calls flaky on Netlify). This script is meant to
// be run on a schedule by .github/workflows/refresh-data.yml, and commits the
// refreshed JSON straight into the repo.
//
// Usage: node scripts/fetch-data.js
//
// NOTE: GitHub Actions runners are themselves cloud/datacenter IPs, so NSE
// may still rate-limit or block some fraction of requests. The script
// retries each symbol once, and any stock that still fails just keeps
// whatever value was already in the JSON from the previous run (graceful
// degradation instead of wiping the dashboard).

const fs = require("fs");
const path = require("path");

const {
  dateRangeForDays,
  computeFromHistorical,
  peVsIndustry,
  priceVsVwap,
  convictionScore,
} = require("../public/js/metrics.js");

const ROOT = path.join(__dirname, "..");
const STOCKS_PATH = path.join(ROOT, "data", "stocks.json");
const SECTORS_PATH = path.join(ROOT, "data", "sectors.json");
const OUT_DIR = path.join(ROOT, "public", "data");

const BASE = "https://www.nseindia.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

const REQUEST_DELAY_MS = 350; // be polite, keep request rate sane
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let cookie = "";
async function refreshCookie() {
  const r = await fetch(`${BASE}/`, { headers: HEADERS });
  cookie = r.headers.get("set-cookie") || "";
}

async function nseGet(url) {
  const r = await fetch(url, { headers: { ...HEADERS, Cookie: cookie } });
  const text = await r.text();
  return JSON.parse(text); // throws on HTML block page -> caller catches
}

async function fetchSymbol(symbol) {
  const quoteUrl = `${BASE}/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const { from, to } = dateRangeForDays(35);
  const histUrl = `${BASE}/api/historical/cm/equity?symbol=${encodeURIComponent(
    symbol
  )}&series=[%22EQ%22]&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const quoteData = await nseGet(quoteUrl);
  await sleep(REQUEST_DELAY_MS);
  const histData = await nseGet(histUrl);

  const pe = peVsIndustry(quoteData);
  const vwap = priceVsVwap(quoteData);
  const hist = computeFromHistorical(histData);
  const priceInfo = quoteData?.priceInfo || {};
  const wk52 = priceInfo.weekHighLow || {};

  return {
    price: vwap.price,
    symbolPe: pe.symbolPe,
    sectorPe: pe.sectorPe,
    deltaPct: pe.deltaPct,
    vwapDeltaPct: vwap.deltaPct,
    pctChange4w: hist.pctChange4w,
    volRatio: hist.volRatio,
    weekHigh: wk52.max ?? null,
    weekLow: wk52.min ?? null,
    pChange: priceInfo.pChange ?? null,
  };
}

async function fetchWithRetry(symbol) {
  try {
    return await fetchSymbol(symbol);
  } catch (err) {
    await sleep(RETRY_DELAY_MS);
    try {
      await refreshCookie();
      return await fetchSymbol(symbol);
    } catch (err2) {
      return { error: err2.message || String(err2) };
    }
  }
}

async function main() {
  const stocksMap = JSON.parse(fs.readFileSync(STOCKS_PATH, "utf8"));
  const sectorsMap = JSON.parse(fs.readFileSync(SECTORS_PATH, "utf8"));
  const symbols = Object.keys(stocksMap);

  // Carry forward previous results so a handful of NSE failures this run
  // don't blank out the whole dashboard.
  const prevPath = path.join(OUT_DIR, "stock-metrics.json");
  let prev = {};
  if (fs.existsSync(prevPath)) {
    try {
      prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
    } catch {
      prev = {};
    }
  }

  console.log(`Fetching ${symbols.length} symbols from NSE...`);
  await refreshCookie();

  const stockMetrics = {};
  let success = 0, failed = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const result = await fetchWithRetry(symbol);
    if (result.error) {
      failed++;
      stockMetrics[symbol] = prev[symbol] && !prev[symbol].error
        ? { ...prev[symbol], stale: true }
        : { error: result.error };
    } else {
      success++;
      stockMetrics[symbol] = result;
    }
    if ((i + 1) % 25 === 0 || i === symbols.length - 1) {
      console.log(`  ${i + 1}/${symbols.length} (ok=${success}, failed=${failed})`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // Sector-level aggregation (avg 4-week change feeds the "trending sector"
  // half of the conviction score; avg vol ratio is shown on the home page).
  const sectorMetrics = {};
  for (const [sector, syms] of Object.entries(sectorsMap)) {
    const rows = syms.map((s) => stockMetrics[s]).filter((d) => d && !d.error);
    const changes = rows.map((d) => d.pctChange4w).filter((v) => v != null);
    const volRatios = rows.map((d) => d.volRatio).filter((v) => v != null);
    const avgChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
    sectorMetrics[sector] = {
      avgChange,
      avgVolRatio: volRatios.length ? volRatios.reduce((a, b) => a + b, 0) / volRatios.length : null,
      sampleSize: rows.length,
      totalStocks: syms.length,
    };
  }

  // Now that sector momentum is known, compute each stock's conviction score
  // (philosophy point #1 — "pick a trending sector" — folded in here).
  for (const [symbol, info] of Object.entries(stocksMap)) {
    const d = stockMetrics[symbol];
    if (!d || d.error) continue;
    const sectorMomentum = sectorMetrics[info.sector]?.avgChange ?? null;
    d.conviction = convictionScore({
      peDeltaPct: d.deltaPct,
      pctChange4w: d.pctChange4w,
      vwapDeltaPct: d.vwapDeltaPct,
      volRatio: d.volRatio,
      sectorMomentum,
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "stock-metrics.json"), JSON.stringify(stockMetrics, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "sector-metrics.json"), JSON.stringify(sectorMetrics, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, "meta.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalStocks: symbols.length,
        success,
        failed,
      },
      null,
      2
    )
  );

  console.log(`Done. ok=${success} failed=${failed}. Wrote public/data/{stock,sector}-metrics.json + meta.json`);
}

main().catch((err) => {
  console.error("Fatal error in fetch-data.js:", err);
  process.exit(1);
});
