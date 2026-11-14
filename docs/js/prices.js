// Live price engine. All calls go straight from the browser to public,
// CORS-enabled APIs; there is no backend.
//
//   crypto  Coinbase Exchange  WebSocket ticker (tick by tick) + REST fallback
//           CoinGecko          polling, for coins Coinbase does not list
//   metal   gold-api.com       spot per troy ounce, polling
//   stock   Finnhub            US stocks/ETFs, polling, needs the user's free key
//   cash    open.er-api.com    daily FX rates
//   custom  the price the user typed
//
// Every quote is { p, prev, t } in USD: price, reference price for the
// "today" change (24h open for crypto, previous close for stocks) and time.

const CB_REST = 'https://api.exchange.coinbase.com';
const CB_WS = 'wss://ws-feed.exchange.coinbase.com';
const CG = 'https://api.coingecko.com/api/v3';
const GOLD = 'https://api.gold-api.com/price/';
const FINNHUB = 'https://finnhub.io/api/v1';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';

const QUOTES_KEY = 'portfolio.quotes';
const SAMPLES_KEY = 'portfolio.samples';
const FX_KEY = 'portfolio.fx';

const quotes = new Map();
const fx = { rates: { USD: 1 }, t: 0 };
let samples = {};
let tracked = [];
let watched = null;
let finnhubKey = '';
let finnhubState = 'none'; // none | ok | invalid
let lastOk = 0;
let running = false;

const listeners = new Set();
const dirty = new Set();
let emitTimer = 0;

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// Show the last known prices immediately on launch, then replace them.
(function restore() {
  const saved = readJSON(QUOTES_KEY, {});
  for (const [id, q] of Object.entries(saved)) {
    if (q && Number.isFinite(q.p)) quotes.set(id, { p: q.p, prev: q.prev ?? null, t: q.t || 0, stale: true });
  }
  samples = readJSON(SAMPLES_KEY, {});
  const f = readJSON(FX_KEY, null);
  if (f && f.rates) { fx.rates = f.rates; fx.t = f.t || 0; }
})();

let persistTimer = 0;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    const out = {};
    quotes.forEach((q, id) => { out[id] = { p: q.p, prev: q.prev, t: q.t }; });
    writeJSON(QUOTES_KEY, out);
    writeJSON(SAMPLES_KEY, samples);
  }, 4000);
}

export function onPrices(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emit() {
  emitTimer = 0;
  const ids = new Set(dirty);
  dirty.clear();
  listeners.forEach(fn => fn(ids));
}
function touch(id) {
  dirty.add(id);
  if (!emitTimer) emitTimer = setTimeout(emit, 200);
}

function setQuote(id, p, prev) {
  if (!Number.isFinite(p) || p <= 0) return;
  const now = Date.now();
  const old = quotes.get(id);
  quotes.set(id, { p, prev: Number.isFinite(prev) && prev > 0 ? prev : null, t: now, dir: old && !old.stale ? Math.sign(p - old.p) : 0 });
  lastOk = now;
  // Keep a sparse local history so assets whose source has no reference price
  // (metals) can still show a 24h change once the app has been used for a day.
  const s = samples[id] || (samples[id] = []);
  if (!s.length || now - s[s.length - 1][0] > 30 * 60e3) {
    s.push([now, p]);
    while (s.length && now - s[0][0] > 30 * 3600e3) s.shift();
  }
  persistSoon();
  touch(id);
}

function sampleRef(id) {
  const s = samples[id];
  if (!s || !s.length) return null;
  const target = Date.now() - 24 * 3600e3;
  let best = null, bestGap = 4 * 3600e3;
  for (const [t, p] of s) {
    const gap = Math.abs(t - target);
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  return best;
}

/** Current quote for an asset, or null when there is no price yet. */
export function quoteOf(a) {
  if (a.kind === 'cash') {
    const r = fx.rates[a.sym];
    return r ? { p: 1 / r, prev: null, t: fx.t, fixed: true } : null;
  }
  if (a.kind === 'custom') {
    return Number.isFinite(a.price) ? { p: a.price, prev: null, t: 0, fixed: true } : null;
  }
  const q = quotes.get(a.id);
  if (!q) return null;
  if (q.prev != null) return q;
  // No reference price from the live source: ask the history module first
  // (exact, when it has data), then fall back to what this browser recorded.
  return { ...q, prev: (prevProvider && prevProvider(a)) || sampleRef(a.id) };
}

/** The live price alone, with no reference lookup (safe to call from providers). */
export function livePrice(a) {
  const q = quotes.get(a.id);
  return q ? q.p : null;
}

let prevProvider = null;
/** Lets another module supply "price about 24 h ago" for assets that lack one. */
export function setPrevProvider(fn) { prevProvider = fn; }

/** Units of the display currency per 1 USD (1 when the rate is unknown). */
export function rate(ccy) { return fx.rates[ccy] || 1; }
export function hasRate(ccy) { return ccy === 'USD' || !!fx.rates[ccy]; }

export function status() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (Date.now() - lastOk < 90e3) return 'live';
  return lastOk ? 'stale' : 'loading';
}
export function stockState() { return finnhubState; }

function assets() {
  if (!watched || tracked.some(a => a.id === watched.id)) return tracked;
  return [...tracked, watched];
}

export function track(list) { tracked = list; reconcile(); }
/** Also follow one asset that is not held yet (the add screen shows its price). */
export function watch(asset) { watched = asset; reconcile(); }

export function setFinnhubKey(key) {
  if (key === finnhubKey) return;
  finnhubKey = key || '';
  finnhubState = finnhubKey ? 'ok' : 'none';
  stockCursor = 0;
  if (running) pollStocks(true);
}

// ---------- Coinbase ---------------------------------------------------------

let ws = null, wsOpen = false, wsSubs = new Set(), wsRetry = 0, wsTimer = 0;
let cbIndex = new Map(); // product -> asset id

function cbWanted() {
  cbIndex = new Map();
  for (const a of assets()) if (a.kind === 'crypto' && a.cb) cbIndex.set(a.cb, a.id);
  return new Set(cbIndex.keys());
}

function wsSync() {
  const want = cbWanted();
  if (!want.size || !running) { wsClose(); return; }
  if (!ws) { wsOpenSocket(); return; }
  if (!wsOpen) return;
  const add = [...want].filter(x => !wsSubs.has(x));
  const del = [...wsSubs].filter(x => !want.has(x));
  if (add.length) ws.send(JSON.stringify({ type: 'subscribe', product_ids: add, channels: ['ticker'] }));
  if (del.length) ws.send(JSON.stringify({ type: 'unsubscribe', product_ids: del, channels: ['ticker'] }));
  wsSubs = want;
}

function wsOpenSocket() {
  clearTimeout(wsTimer);
  let sock;
  try { sock = new WebSocket(CB_WS); } catch { wsRetryLater(); return; }
  ws = sock;
  sock.onopen = () => { if (ws !== sock) return; wsOpen = true; wsRetry = 0; wsSubs = new Set(); wsSync(); };
  sock.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'ticker') return;
    const id = cbIndex.get(m.product_id);
    if (id) setQuote(id, Number(m.price), Number(m.open_24h));
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null; wsOpen = false; wsSubs = new Set();
    if (running && cbWanted().size) wsRetryLater();
  };
  sock.onerror = () => { try { sock.close(); } catch { /* already closed */ } };
}

function wsRetryLater() {
  clearTimeout(wsTimer);
  wsRetry = Math.min(wsRetry + 1, 6);
  wsTimer = setTimeout(() => { if (running && !ws) wsSync(); }, 1000 * 2 ** wsRetry);
}

function wsClose() {
  clearTimeout(wsTimer);
  if (ws) { const s = ws; ws = null; wsOpen = false; wsSubs = new Set(); try { s.close(); } catch { /* ignore */ } }
}

async function cbRest(product, id) {
  try {
    const r = await fetch(`${CB_REST}/products/${product}/stats`);
    if (!r.ok) return;
    const s = await r.json();
    setQuote(id, Number(s.last), Number(s.open));
  } catch { /* offline: keep the last price */ }
}

function pollCoinbase(force) {
  cbWanted();
  for (const [product, id] of cbIndex) {
    const q = quotes.get(id);
    // REST only fills gaps: first paint, and whenever the socket is down.
    if (force || !q || q.stale || !wsOpen || Date.now() - q.t > 60e3) cbRest(product, id);
  }
}

// ---------- CoinGecko --------------------------------------------------------

let cgPauseUntil = 0, cgStrikes = 0, cgRetry = 0;
async function pollCoinGecko() {
  const list = assets().filter(a => a.kind === 'crypto' && !a.cb && a.cg);
  if (!list.length || Date.now() < cgPauseUntil) return;
  try {
    const ids = list.map(a => a.cg).join(',');
    const r = await fetch(`${CG}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`);
    if (r.status === 429) {
      // The public API is rate limited per IP: back off, then try again by itself.
      const wait = Math.min(120e3, 15e3 * 2 ** cgStrikes++);
      cgPauseUntil = Date.now() + wait;
      setTimeout(() => { if (running) pollCoinGecko(); }, wait + 250);
      return;
    }
    if (!r.ok) return;
    cgStrikes = 0;
    const data = await r.json();
    for (const a of list) {
      const d = data[a.cg];
      if (!d || !Number.isFinite(d.usd)) continue;
      const chg = d.usd_24h_change;
      setQuote(a.id, d.usd, Number.isFinite(chg) ? d.usd / (1 + chg / 100) : null);
    }
  } catch {
    // Offline, or a rate-limited reply without CORS headers: one early retry.
    if (!cgRetry) cgRetry = setTimeout(() => { cgRetry = 0; if (running) pollCoinGecko(); }, 15e3);
  }
}

// ---------- Metals -----------------------------------------------------------

async function pollMetals() {
  for (const a of assets()) {
    if (a.kind !== 'metal') continue;
    try {
      const r = await fetch(GOLD + a.sym);
      if (!r.ok) continue;
      const d = await r.json();
      setQuote(a.id, Number(d.price), null);
    } catch { /* offline */ }
  }
}

// ---------- Stocks (Finnhub) -------------------------------------------------

let stockCursor = 0, stockPauseUntil = 0;
const finnhubSymbol = sym => sym.replace('-', '.');

async function stockQuote(a) {
  const r = await fetch(`${FINNHUB}/quote?symbol=${encodeURIComponent(finnhubSymbol(a.sym))}&token=${encodeURIComponent(finnhubKey)}`);
  if (r.status === 401) { finnhubState = 'invalid'; touch(a.id); return; }
  if (r.status === 429) { stockPauseUntil = Date.now() + 30e3; return; }
  if (!r.ok) return;
  const d = await r.json();
  finnhubState = 'ok';
  if (Number.isFinite(d.c) && d.c > 0) setQuote(a.id, d.c, d.pc);
}

// The free tier allows 60 calls a minute, so symbols are refreshed in small
// batches that together stay well under it however many are held.
async function pollStocks(all) {
  const list = assets().filter(a => a.kind === 'stock');
  if (!list.length || !finnhubKey || finnhubState === 'invalid' || Date.now() < stockPauseUntil) return;
  const n = all ? Math.min(list.length, 30) : Math.min(list.length, 8);
  for (let i = 0; i < n; i++) {
    const a = list[(stockCursor + i) % list.length];
    try { await stockQuote(a); } catch { /* offline */ }
  }
  stockCursor = (stockCursor + n) % list.length;
}

/** Check a key before saving it: 'ok', 'invalid' or 'network'. */
export async function testFinnhubKey(key) {
  try {
    const r = await fetch(`${FINNHUB}/quote?symbol=AAPL&token=${encodeURIComponent(key)}`);
    if (r.status === 401 || r.status === 403) return 'invalid';
    if (!r.ok) return 'network';
    const d = await r.json();
    return Number.isFinite(d.c) && d.c > 0 ? 'ok' : 'invalid';
  } catch { return 'network'; }
}

// ---------- FX ---------------------------------------------------------------

async function pollFx() {
  if (Date.now() - fx.t < 3600e3) return;
  try {
    const r = await fetch(FX_URL);
    if (!r.ok) return;
    const d = await r.json();
    if (d.result !== 'success' || !d.rates) return;
    fx.rates = d.rates; fx.t = Date.now(); lastOk = fx.t;
    writeJSON(FX_KEY, fx);
    touch('fx');
  } catch { /* offline */ }
}

// ---------- Scheduler --------------------------------------------------------

const timers = [];
function every(ms, fn) { timers.push(setInterval(fn, ms)); }

function reconcile() {
  if (!running) return;
  wsSync();
  pollCoinbase(false);
  // Fetch at once anything that has no fresh price yet.
  const fresh = a => { const q = quotes.get(a.id); return q && !q.stale; };
  const need = assets().filter(a => !fresh(a));
  if (need.some(a => a.kind === 'crypto' && !a.cb)) pollCoinGecko();
  if (need.some(a => a.kind === 'metal')) pollMetals();
  if (need.some(a => a.kind === 'stock')) pollStocks(true);
}

export function start() {
  if (running) return;
  running = true;
  pollFx();
  refresh();
  every(20e3, () => pollCoinbase(false));
  every(60e3, pollCoinGecko);
  every(30e3, pollMetals);
  every(15e3, () => pollStocks(false));
  every(600e3, pollFx);
  every(30e3, () => touch('status'));
}

export function stop() {
  running = false;
  timers.splice(0).forEach(clearInterval);
  wsClose();
}

/** Pull everything now (pull-to-refresh, coming back to the tab). */
export function refresh() {
  if (!running) return Promise.resolve();
  wsSync();
  pollCoinbase(true);
  return Promise.allSettled([pollCoinGecko(), pollMetals(), pollStocks(true), pollFx()]);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });
  window.addEventListener('online', () => { if (running) refresh(); touch('status'); });
  window.addEventListener('offline', () => touch('status'));
}
