# Sector Analysis Dashboard

A free-hosted dashboard for screening NSE-listed Indian equities (Nifty 500
universe) by sector, then drilling into individual stocks.

## What it does

- **Home (`index.html`)** — 20 NSE sectors as cards. Click "Load metrics" to
  pull live NSE data for a sample of stocks per sector and see average 4-week
  price momentum and volume vs 20-day average. Sort by name, momentum, or size.
- **Sector page (`sector.html`)** — every stock in a sector, with PE vs
  Sector PE, price vs VWAP, 4-week change, and volume ratio. Filter by
  "cheap vs sector," "expensive vs sector," or "momentum positive."
- **Stock page (`stock.html`)** — live price, VWAP, 52-week range, PE vs
  sector PE, a "Quality Snapshot" built from those same signals, latest news
  (Google News RSS), and outbound links to NSE filings and Screener.in for
  full financials.

## Data sources and a known limitation

All live data comes from NSE's public (unofficial) JSON API, proxied through
a Netlify serverless function to dodge browser CORS restrictions. This was
the only viable source — Yahoo Finance's API was completely blocked in the
build environment, and NSE itself blocks some traffic from cloud-datacenter
IPs with a "Service Temporarily Unavailable... not accessible in your region"
page. Netlify's serverless IPs may or may not be treated the same way as the
ones blocked during development.

To cope with this, every API call:
1. Checks a local cache (in the browser's `localStorage`) first.
2. Falls back to the last successfully cached value, clearly marked
   **STALE**, if the live call fails.
3. Loads on demand (click-to-load) rather than all at once, to keep request
   volume low.

**Fundamentals gap:** NSE's free quote API only reliably exposes PE vs
Sector PE and price/volume data. It does **not** expose multi-year balance
sheets, so a true Piotroski F-score or "Book Value vs Industry BV" comparison
isn't possible from this data source alone. The "Quality Snapshot" on the
stock page is an honest, labeled approximation using only valuation
(PE vs sector) and momentum (price vs VWAP) signals — not a full fundamental
score. To get real Piotroski/BV-vs-industry screening, the natural next step
is importing a Screener.in export (CSV) as a second data layer; the stock
page already links out to Screener.in for that data in the meantime.

## Deploying to Netlify (free tier)

1. Push this `sector-dashboard/` folder to a GitHub repo.
2. Go to [app.netlify.com](https://app.netlify.com) → "Add new site" →
   "Import an existing project" → pick the repo.
3. Build settings: leave the build command blank, publish directory
   `public` (already set in `netlify.toml`). Netlify auto-detects the
   functions in `netlify/functions`.
4. Deploy. No environment variables or API keys are needed — everything
   uses free, public endpoints.
5. Open the deployed URL. If a sector or stock shows "data unavailable,"
   that's NSE's anti-bot blocking kicking in for that request — retry after
   a minute, or rely on the stale-cache fallback.

## Refreshing the stock/sector universe

`data/nifty500_raw.csv` is NSE's official Nifty 500 constituent list. To
regenerate `stocks.json` / `sectors.json` from a fresh CSV (NSE updates this
list periodically), re-run the same Symbol → Sector grouping logic used to
build the current `data/stocks.json` and `data/sectors.json`, then copy both
into `public/data/` (the site reads from there).

## File map

```
netlify.toml                 # publish dir, function dir, /api/* redirect
netlify/functions/nse.js     # NSE proxy (quote, sector index, historical)
netlify/functions/news.js    # Google News RSS proxy
netlify/functions/chart.js   # Yahoo Finance fallback (currently blocked in dev sandbox)
public/index.html            # sector grid
public/sector.html           # stock list + filters for one sector
public/stock.html            # stock detail: quote, quality snapshot, news, results links
public/js/api.js             # fetch + localStorage caching layer
public/js/metrics.js         # NSE response parsing + derived metrics (VWAP, PE delta, etc.)
public/css/style.css         # dark theme
public/data/                 # generated stocks.json / sectors.json (served to the browser)
data/                        # source CSV + the same JSON, kept outside public/ as the "source"
```
