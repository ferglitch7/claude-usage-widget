// Price history for charts and sparklines. Every series is [[timeMs, usd], …]
// in ascending order.
//
//   crypto   Coinbase candles, or CoinGecko for coins Coinbase does not list
//   stocks   Twelve Data (free key)
//   gold     Coinbase PAXG-USD, a token backed one-to-one by an ounce of gold,
//            rescaled to the live spot price. Free and needs no key.
//   silver, platinum, palladium
//            Twelve Data's free plan has no spot series for these, so the chart
//            borrows the shape of a physically backed ETF (SLV, PPLT, PALL),
//            rescaled to the live spot price. Marked `approx` for the UI.
//
// Twelve Data allows 8 credits a minute on the free plan, so its requests go
// through a small queue; everything is cached (memory + localStorage) and
// served stale while it refreshes.

import { livePrice } from './prices.js';

const CB_REST = 'https://api.exchange.coinbase.com';
const CG = 'https://api.coingecko.com/api/v3';
const TD = 'https://api.twelvedata.com';
const CACHE_KEY = 'portfolio.hist.v1';

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

export const RANGES = {
  '1D': { span: DAY, cb: 300, cgDays: 1, td: ['5min', 300], ttl: 4 * MIN, tdTtl: 12 * MIN },
  '1S': { span: 7 * DAY, cb: 3600, cgDays: 7, td: ['1h', 200], ttl: 30 * MIN, tdTtl: 90 * MIN },
  '1M': { span: 30 * DAY, cb: 21600, cgDays: 30, td: ['2h', 420], ttl: 3 * HOUR, tdTtl: 6 * HOUR },
  '1A': { span: 365 * DAY, cb: 86400, cgDays: 365, td: ['1day', 370], ttl: 12 * HOUR, tdTtl: 24 * HOUR },
};

const PROXY = { XAG: 'SLV', XPT: 'PPLT', XPD: 'PALL' };
const PROXY_LABEL = { 'PAXG-USD': 'del token PAXG' };

const cache = new Map();    // "id:range" -> { t, pts, scaled? }
const pending = new Map();  // "id:range" -> Promise
const failed = new Map();   // "id:range" -> retry-not-before
const listeners = new Set();
let tdKey = '';
let version = 0;

// ---------- persistence -------------------------------------------------------

(function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    const now = Date.now();
    for (const [key, e] of Object.entries(saved)) {
      if (e && Array.isArray(e.pts) && e.pts.length > 1 && now - e.t < 7 * DAY) cache.set(key, { t: e.t, pts: e.pts });
    }
  } catch { /* no cache */ }
})();

let saveTimer = 0;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    const out = {};
    cache.forEach((e, key) => { out[key] = { t: e.t, pts: e.pts }; });
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch {
      try { localStorage.removeItem(CACHE_KEY); } catch { /* storage unavailable */ }
    }
  }, 3000);
}

// ---------- events ------------------------------------------------------------

export function onHistory(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Changes whenever new data arrives; lets views skip work when nothing changed. */
export function historyVersion() { return version; }

let emitTimer = 0;
function changed() {
  version++;
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = 0; listeners.forEach(fn => fn()); }, 150);
}

// ---------- sources -----------------------------------------------------------

function source(a) {
  if (a.kind === 'crypto') return a.cb ? { type: 'cb', sym: a.cb } : a.cg ? { type: 'cg', sym: a.cg } : null;
  if (a.kind === 'stock') return { type: 'td', sym: a.sym.replace('-', '.') };
  if (a.kind === 'metal') {
    if (a.sym === 'XAU') return { type: 'cb', sym: 'PAXG-USD', proxy: true };
    if (PROXY[a.sym]) return { type: 'td', sym: PROXY[a.sym], proxy: true };
  }
  return null;
}

/** 'yes', 'needs-key' (a Twelve Data key would unlock it) or 'none'. */
export function availability(a) {
  const s = source(a);
  if (!s) return 'none';
  return s.type === 'td' && !tdKey ? 'needs-key' : 'yes';
}

/** What stands in for this asset's history, in words ("del ETF SLV"), if anything. */
export function proxyOf(a) {
  const s = source(a);
  return s && s.proxy ? PROXY_LABEL[s.sym] || `del ETF ${s.sym}` : null;
}

export function setHistoryKey(key) {
  key = key || '';
  if (key === tdKey) return;
  tdKey = key;
  failed.clear();
  changed();
}

function round(v) { return Number(v.toPrecision(7)); }

async function fetchCoinbase(product, R) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - R.span / 1000;
  const step = R.cb * 300; // the API returns at most 300 candles per call
  const jobs = [];
  for (let s = start; s < end; s += step) {
    const e = Math.min(end, s + step);
    const url = `${CB_REST}/products/${product}/candles?granularity=${R.cb}&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`;
    jobs.push(fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))));
  }
  const seen = new Set(), pts = [];
  for (const c of (await Promise.all(jobs)).flat()) {
    if (seen.has(c[0])) continue;
    seen.add(c[0]);
    pts.push([c[0] * 1000, round(c[4])]);
  }
  return pts.sort((x, y) => x[0] - y[0]);
}

// CoinGecko's public API is rate limited per IP: one call at a time, spaced out.
let cgChain = Promise.resolve();
function fetchCoinGecko(id, R) {
  const run = async () => {
    const r = await fetch(`${CG}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${R.cgDays}`);
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    return (d.prices || []).filter(p => Number.isFinite(p[1])).map(p => [p[0], round(p[1])]);
  };
  const job = cgChain.then(run, run);
  cgChain = job.then(() => new Promise(res => setTimeout(res, 2500)), () => new Promise(res => setTimeout(res, 2500)));
  return job;
}

// ---------- Twelve Data, behind a credit-limited queue -------------------------

const TD_PER_MINUTE = 7; // the plan allows 8; keep one spare
const tdQueue = [];
let tdStamps = [], tdTimer = 0, tdPausedUntil = 0, tdStrikes = 0;

function tdPump() {
  clearTimeout(tdTimer);
  const now = Date.now();
  tdStamps = tdStamps.filter(t => now - t < 61e3);
  while (tdQueue.length && tdStamps.length < TD_PER_MINUTE && now >= tdPausedUntil) {
    tdStamps.push(now);
    tdQueue.shift().run();
  }
  if (!tdQueue.length) return;
  const wait = now < tdPausedUntil ? tdPausedUntil - now : 61e3 - (now - tdStamps[0]);
  tdTimer = setTimeout(tdPump, Math.max(400, wait));
}

function parseTdTime(s) {
  return Date.parse(s.length > 10 ? s.replace(' ', 'T') + 'Z' : s + 'T00:00:00Z');
}

function fetchTwelve(sym, R, priority) {
  return new Promise((resolve, reject) => {
    const job = {
      run: async () => {
        try {
          const [interval, size] = R.td;
          const r = await fetch(`${TD}/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${size}&timezone=UTC&apikey=${encodeURIComponent(tdKey)}`);
          const d = await r.json();
          if (d.code === 429) {
            // Out of credits for this minute (or day): wait, then try this one again.
            tdStrikes++;
            tdPausedUntil = Date.now() + (tdStrikes > 3 ? 15 * MIN : 62e3);
            tdQueue.unshift(job);
            tdPump();
            return;
          }
          tdStrikes = 0;
          if (d.status !== 'ok' || !Array.isArray(d.values)) throw new Error(d.message || String(d.code || r.status));
          const pts = [];
          for (const v of d.values) {
            const t = parseTdTime(v.datetime), p = Number(v.close);
            if (Number.isFinite(t) && Number.isFinite(p) && p > 0) pts.push([t, round(p)]);
          }
          resolve(pts.sort((x, y) => x[0] - y[0]));
        } catch (e) { reject(e); }
      },
    };
    if (priority === 0) tdQueue.unshift(job); else tdQueue.push(job);
    tdPump();
  });
}

/** Check a Twelve Data key before saving it: 'ok', 'invalid' or 'network'. */
export async function testHistoryKey(key) {
  try {
    const r = await fetch(`${TD}/time_series?symbol=AAPL&interval=1day&outputsize=1&apikey=${encodeURIComponent(key)}`);
    const d = await r.json();
    if (d.status === 'ok') return 'ok';
    return d.code === 401 || d.code === 403 ? 'invalid' : d.code === 429 ? 'ok' : 'network';
  } catch { return 'network'; }
}

// ---------- access ------------------------------------------------------------

function request(a, s, range, key, priority) {
  if (pending.has(key)) return pending.get(key);
  if ((failed.get(key) || 0) > Date.now()) return Promise.resolve(null);
  const R = RANGES[range];
  const job = (s.type === 'cb' ? fetchCoinbase(s.sym, R) : s.type === 'cg' ? fetchCoinGecko(s.sym, R) : fetchTwelve(s.sym, R, priority))
    .then(pts => {
      if (!pts || pts.length < 2) throw new Error('empty');
      cache.set(key, { t: Date.now(), pts });
      failed.delete(key);
      saveSoon();
      changed();
      return cache.get(key);
    })
    .catch(() => { failed.set(key, Date.now() + 2 * MIN); return null; })
    .finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

function present(a, s, hit) {
  if (!hit) return null;
  if (!s.proxy) return { pts: hit.pts, approx: false };
  // Rescale the stand-in so its last value equals the metal's live spot price.
  const live = livePrice(a), last = hit.pts[hit.pts.length - 1][1];
  if (!live || !last) return null;
  const k = live / last;
  if (!hit.scaled || Math.abs(hit.scaled.k / k - 1) > 0.0005) {
    hit.scaled = { k, pts: hit.pts.map(p => [p[0], p[1] * k]) };
  }
  return { pts: hit.scaled.pts, approx: true };
}

function resolve(a, range) {
  const s = source(a);
  if (!s || !RANGES[range] || (s.type === 'td' && !tdKey)) return null;
  const key = `${a.id}:${range}`;
  const hit = cache.get(key);
  const ttl = s.type === 'td' ? RANGES[range].tdTtl : RANGES[range].ttl;
  return { s, key, hit, stale: !hit || Date.now() - hit.t > ttl };
}

/**
 * What is cached right now, or null. Starts a background refresh when the
 * cache is missing or stale; listeners of onHistory() hear when it lands.
 */
export function peek(a, range) {
  const x = resolve(a, range);
  if (!x) return null;
  if (x.stale) request(a, x.s, range, x.key, 1);
  return present(a, x.s, x.hit);
}

/** Like peek(), but waits for the data (the asset detail screen). */
export async function load(a, range) {
  const x = resolve(a, range);
  if (!x) return null;
  if (x.hit && !x.stale) return present(a, x.s, x.hit);
  const got = await request(a, x.s, range, x.key, 0);
  return present(a, x.s, got || x.hit);
}

/**
 * Price about 24 hours ago, for assets whose live source has no reference
 * price (metals). Series that trade around the clock (Coinbase, including the
 * PAXG stand-in for gold) qualify; ETFs that close at night do not.
 */
export function ref24(a) {
  const x = resolve(a, '1D');
  if (!x || (x.s.proxy && x.s.type !== 'cb') || !x.hit) return null;
  if (x.stale) request(a, x.s, '1D', x.key, 1);
  const target = Date.now() - DAY, pts = x.hit.pts;
  // The series must reach back to about a day ago and not be days out of date.
  if (pts[0][0] > target + 2 * HOUR || Date.now() - pts[pts.length - 1][0] > 4 * DAY) return null;
  let p = pts[0][1];
  for (const pt of pts) { if (pt[0] <= target) p = pt[1]; else break; }
  if (!x.s.proxy) return p;
  const live = livePrice(a), last = pts[pts.length - 1][1];
  return live && last ? p * (live / last) : null; // same scale as the live price
}

/**
 * The part of a series a single-asset chart shows. Markets that close are
 * measured back from their last trade, so a weekend still shows a full session.
 */
export function windowed(a, pts, range) {
  const span = RANGES[range].span;
  const end = a.kind === 'crypto' ? Date.now() : pts[pts.length - 1][0];
  const out = pts.filter(p => p[0] >= end - span);
  return out.length > 1 ? out : pts.slice(-2);
}
