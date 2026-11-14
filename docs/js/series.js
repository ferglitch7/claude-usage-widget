// Builds the portfolio's value over time. Pure functions: everything they need
// is passed in, so the maths can be tested without a browser.
//
// The app stores no transactions, so the market ranges (1D, 1S, 1M, 1A) answer
// "what would today's positions have been worth?": current quantities times
// each asset's past price. The 'real' range is different: it replays the
// values the app actually recorded while it was open.

export const GRID = 120;

/** Last known price at or before t. Before the first point, the first price. */
export function priceAt(pts, t) {
  let lo = 0, hi = pts.length - 1;
  if (t <= pts[0][0]) return pts[0][1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return pts[lo][1];
}

/**
 * holdings: [{ kind, name, qty, … }]
 * quoteOf(asset) -> { p } | null          live price in USD
 * peek(asset, range) -> { pts } | null    price history in USD
 * rate                                    display currency per USD
 * unit: null | { asset, usd }             show the value in units of an asset
 *
 * Returns { pts: [[t, value]], missing: [names], inUnit, moved }.
 */
export function marketSeries({ range, span, now, holdings, quoteOf, peek, rate, unit }) {
  const sum = new Float64Array(GRID);
  const times = new Float64Array(GRID);
  for (let i = 0; i < GRID; i++) times[i] = now - span + (span * i) / (GRID - 1);

  const missing = [];
  let live = 0, moved = false;
  for (const a of holdings) {
    const q = quoteOf(a);
    if (!q) continue; // not in the balance either
    live += q.p * a.qty;
    const fixed = a.kind === 'cash' || a.kind === 'custom';
    const h = fixed ? null : peek(a, range);
    if (!h || h.pts.length < 2) {
      // No history: held flat at today's price, and reported as such.
      if (!fixed) missing.push(a.name);
      for (let i = 0; i < GRID; i++) sum[i] += q.p * a.qty;
      continue;
    }
    moved = true;
    const pts = h.pts;
    let j = 0;
    for (let i = 0; i < GRID; i++) {
      while (j < pts.length - 1 && pts[j + 1][0] <= times[i]) j++;
      sum[i] += pts[j][1] * a.qty;
    }
  }
  sum[GRID - 1] = live; // the chart ends exactly on the live balance

  const div = unitDivisor(unit, times, peek, range);
  const pts = new Array(GRID);
  for (let i = 0; i < GRID; i++) pts[i] = [times[i], div ? sum[i] / div[i] : sum[i] * rate];
  return { pts, missing, inUnit: !!div, moved };
}

/** Which market range's history is fine enough to convert values across `span`. */
export function rangeForSpan(span) {
  const day = 86400e3;
  return span <= day ? '1D' : span <= 7 * day ? '1S' : span <= 30 * day ? '1M' : '1A';
}

function unitDivisor(unit, times, peek, range) {
  if (!unit) return null;
  const h = peek(unit.asset, range);
  // The unit's own history must reach back to the start, or old values would be
  // divided by the wrong price.
  if (!h || h.pts.length < 2 || h.pts[0][0] > times[0] + (times[times.length - 1] - times[0]) * 0.03) return null;
  const div = new Float64Array(times.length);
  for (let i = 0; i < times.length; i++) div[i] = priceAt(h.pts, times[i]);
  div[times.length - 1] = unit.usd;
  return div;
}

/**
 * snaps: [[t, usd]] recorded balances. Returns null until there is enough to
 * draw (two points at least an hour apart).
 */
export function realSeries({ snaps, now, liveUsd, rate, unit, peek }) {
  if (!snaps.length || now - snaps[0][0] < 3600e3) return null;
  const all = snaps.filter(s => s[0] < now - 60e3);
  all.push([now, liveUsd]);
  if (all.length < 2) return null;
  const times = Float64Array.from(all, s => s[0]);
  const div = unitDivisor(unit, times, peek, rangeForSpan(now - all[0][0]));
  const pts = all.map((s, i) => [s[0], div ? s[1] / div[i] : s[1] * rate]);
  return { pts, missing: [], inUnit: !!div, moved: true };
}
