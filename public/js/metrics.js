// Derives screening metrics from raw NSE responses. Kept separate from api.js
// so the parsing logic (which is the fragile, NSE-schema-dependent part) is
// easy to find and fix if NSE changes field names.

function pad(n) {
  return String(n).padStart(2, "0");
}

// NSE historical API wants DD-MM-YYYY
function toNseDate(d) {
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

function dateRangeForDays(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { from: toNseDate(from), to: toNseDate(to) };
}

// Normalizes the historical-data row shape. NSE's documented schema uses
// CH_-prefixed fields (CH_CLOSING_PRICE, CH_TOT_TRADED_QTY, CH_TIMESTAMP) but
// has changed before, so we check a couple of fallbacks.
function normalizeRow(row) {
  const close =
    row.CH_CLOSING_PRICE ?? row.close ?? row.CLOSE ?? row.lastPrice ?? null;
  const volume =
    row.CH_TOT_TRADED_QTY ?? row.totalTradedQuantity ?? row.volume ?? null;
  const date = row.CH_TIMESTAMP ?? row.date ?? row.TIMESTAMP ?? null;
  if (close == null || volume == null) return null;
  return { date, close: Number(close), volume: Number(volume) };
}

// Computes: 4-week % change, volume vs trailing-20-session average, and a
// volume-weighted average price (VWAP) over the lookback window.
// Returns null fields (not zeros) when data can't be parsed, so the UI can
// distinguish "0% change" from "unknown."
function computeFromHistorical(histResponse) {
  const rawRows = histResponse?.data || histResponse?.Data || [];
  const rows = rawRows.map(normalizeRow).filter(Boolean);
  // NSE returns most-recent-first or oldest-first depending on endpoint
  // version; sort ascending by date string defensively isn't reliable, so
  // sort by array position assuming the API is internally chronological and
  // just detect direction by comparing first/last close timestamps isn't
  // robust either — instead we rely on row order as returned and reverse if
  // the first row's volume looks like "today" (heuristic: just use as-is,
  // then flip if needed by comparing index 0 vs last using Date parse).
  let series = rows;
  try {
    const d0 = new Date(rows[0]?.date);
    const dN = new Date(rows[rows.length - 1]?.date);
    if (!isNaN(d0) && !isNaN(dN) && d0 > dN) {
      series = [...rows].reverse(); // make ascending (oldest -> newest)
    }
  } catch {
    /* keep original order */
  }

  if (series.length < 2) {
    return { pctChange4w: null, volRatio: null, vwap: null, lastClose: null };
  }

  const lastClose = series[series.length - 1].close;
  const firstClose = series[0].close;
  const pctChange4w =
    firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : null;

  const last20 = series.slice(-20);
  const avgVol20 =
    last20.reduce((s, r) => s + (r.volume || 0), 0) / Math.max(last20.length, 1);
  const lastVol = series[series.length - 1].volume;
  const volRatio = avgVol20 > 0 ? lastVol / avgVol20 : null;

  const vwapNumerator = last20.reduce((s, r) => s + r.close * (r.volume || 0), 0);
  const vwapDenominator = last20.reduce((s, r) => s + (r.volume || 0), 0);
  const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : null;

  return { pctChange4w, volRatio, vwap, lastClose };
}

// Pulls PE-vs-sector-PE straight out of NSE's quote-equity metadata, which is
// the one field NSE reliably exposes for free (no fundamentals scraping
// needed).
function peVsIndustry(quoteResponse) {
  const meta = quoteResponse?.metadata || {};
  const symbolPe = meta.pdSymbolPe ?? null;
  const sectorPe = meta.pdSectorPe ?? null;
  const delta =
    symbolPe != null && sectorPe != null && sectorPe !== 0
      ? ((symbolPe - sectorPe) / sectorPe) * 100
      : null;
  return { symbolPe, sectorPe, deltaPct: delta };
}

function priceVsVwap(quoteResponse) {
  const priceInfo = quoteResponse?.priceInfo || {};
  const price = priceInfo.lastPrice ?? null;
  const vwap = priceInfo.vwap ?? null;
  const deltaPct =
    price != null && vwap != null && vwap !== 0 ? ((price - vwap) / vwap) * 100 : null;
  return { price, vwap, deltaPct };
}
