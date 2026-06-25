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

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// --- Conviction Score -------------------------------------------------
// A composite 0-100 score built only from signals NSE's free API actually
// gives us, deliberately shaped around the user's stated investment
// philosophy: prefer stocks in a trending sector, trading at a valuation
// discount to their sector, showing price/volume strength (not just "cheap"
// for no reason). This is NOT a substitute for reading financials,
// management quality, or governance — those need a human (or a richer paid
// data source) and are explicitly out of scope for a free-API dashboard.
//
// Inputs (any may be null if data wasn't loaded):
//   peDeltaPct     : symbol PE vs sector PE, % (negative = cheaper than sector)
//   pctChange4w    : 4-week price change, %
//   vwapDeltaPct   : price vs VWAP, %
//   volRatio       : latest volume / 20-day average volume
//   sectorMomentum : the sector's own average 4-week change, % (philosophy
//                    point #1 — "pick a trending sector" — layered in
//                    separately by the caller when available)
function convictionScore({ peDeltaPct, pctChange4w, vwapDeltaPct, volRatio, sectorMomentum }) {
  const hasAny =
    peDeltaPct != null || pctChange4w != null || vwapDeltaPct != null || volRatio != null;
  if (!hasAny) return null;

  // cheaper than sector (negative delta) -> positive score, capped at +-30pp
  const valuationScore = peDeltaPct != null ? -clamp(peDeltaPct, -30, 30) : 0;

  // positive 4-week momentum -> positive score, capped at +-30pp
  const momentumScore = pctChange4w != null ? clamp(pctChange4w, -30, 30) : 0;

  // short-term price strength (vs VWAP) + volume pickup (rotation interest)
  let strengthScore = 0;
  if (vwapDeltaPct != null) strengthScore += clamp(vwapDeltaPct, -10, 10) * 2;
  if (volRatio != null) strengthScore += clamp((volRatio - 1) * 20, -20, 30);

  // sector-level trend, if the caller has it loaded
  const sectorScore = sectorMomentum != null ? clamp(sectorMomentum, -20, 20) : 0;

  // Weighted blend: valuation 30%, momentum 30%, strength 25%, sector 15%.
  const weighted =
    valuationScore * 0.30 + momentumScore * 0.30 + strengthScore * 0.25 + sectorScore * 0.15;

  const score = clamp(50 + weighted, 0, 100);

  return {
    score: Math.round(score),
    breakdown: {
      valuation: Math.round(clamp(50 + valuationScore, 0, 100)),
      momentum: Math.round(clamp(50 + momentumScore, 0, 100)),
      strength: Math.round(clamp(50 + strengthScore, 0, 100)),
      sector: sectorMomentum != null ? Math.round(clamp(50 + sectorScore, 0, 100)) : null,
    },
  };
}

function convictionLabel(score) {
  if (score == null) return 'Insufficient data';
  if (score >= 70) return 'High conviction';
  if (score >= 55) return 'Mild positive';
  if (score >= 45) return 'Neutral';
  if (score >= 30) return 'Mild caution';
  return 'High caution';
}

function convictionColor(score) {
  if (score == null) return 'var(--text-dim)';
  if (score >= 70) return 'var(--green)';
  if (score >= 45) return 'var(--amber)';
  return 'var(--red)';
}

// Shared with scripts/fetch-data.js (Node) so the screening math lives in one
// place. `module` is undefined in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pad,
    toNseDate,
    dateRangeForDays,
    normalizeRow,
    computeFromHistorical,
    peVsIndustry,
    priceVsVwap,
    clamp,
    convictionScore,
    convictionLabel,
    convictionColor,
  };
}
