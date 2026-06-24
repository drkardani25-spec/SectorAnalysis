// Thin client for the Netlify function proxies, with localStorage caching so
// we don't hammer NSE (which blocks aggressively) and so the dashboard still
// shows something useful if a live call fails.
//
// Cache entries: { ts: <epoch ms>, data: <payload> }

const CACHE_PREFIX = "sd_cache_";

function cacheGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > maxAgeMs) return null;
    return data;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + key,
      JSON.stringify({ ts: Date.now(), data })
    );
  } catch {
    /* storage full or unavailable, ignore */
  }
}

function cacheGetStale(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw).data;
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const r = await fetch(url);
  const body = await r.json();
  if (!r.ok || body?.error) {
    const message = body?.message || body?.error || `Request failed (${r.status})`;
    const err = new Error(message);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

// freshMaxAgeMs: how old a cache entry can be before we attempt a live refetch.
// On failure, falls back to whatever is cached, however stale, with a flag.
async function cachedFetch(key, url, freshMaxAgeMs = 5 * 60 * 1000) {
  const fresh = cacheGet(key, freshMaxAgeMs);
  if (fresh) return { data: fresh, stale: false, fromCache: true };

  try {
    const data = await fetchJson(url);
    cacheSet(key, data);
    return { data, stale: false, fromCache: false };
  } catch (err) {
    const stale = cacheGetStale(key);
    if (stale) {
      return { data: stale, stale: true, fromCache: true, error: err.message };
    }
    throw err;
  }
}

const Api = {
  // Live NSE quote for one symbol (price, vwap, sector PE vs symbol PE, etc.)
  quote(symbol) {
    return cachedFetch(
      `quote_${symbol}`,
      `/api/nse?path=quote-equity&symbol=${encodeURIComponent(symbol)}`,
      2 * 60 * 1000
    );
  },

  // NSE sectoral index snapshot (constituents with price/change/volume) - used
  // for the sector rotation dashboard. `index` must be an NSE index name e.g.
  // "NIFTY IT", "NIFTY BANK", "NIFTY AUTO".
  stockIndices(index) {
    return cachedFetch(
      `idx_${index}`,
      `/api/nse?path=stock-indices&index=${encodeURIComponent(index)}`,
      5 * 60 * 1000
    );
  },

  historical(symbol, from, to) {
    return cachedFetch(
      `hist_${symbol}_${from}_${to}`,
      `/api/nse?path=historical&symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`,
      30 * 60 * 1000
    );
  },

  news(query) {
    return cachedFetch(
      `news_${query}`,
      `/api/news?q=${encodeURIComponent(query)}`,
      30 * 60 * 1000
    );
  },
};
