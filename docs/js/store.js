// Holdings and settings, kept only in this browser (localStorage).
//
// A holding is one position per asset: quantity plus an optional average cost
// per unit (USD). There is no transaction history by design.

const KEY = 'portfolio.v1';

const defaults = () => ({
  holdings: [],
  settings: {
    ccy: 'USD', finnhubKey: '', historyKey: '', hidden: false,
    unit: 'ccy',     // balance shown in the currency, 'btc' or 'xau'
    range: '1D',     // chart range on the home screen
    targets: null,   // { crypto: 60, cash: 20, … } percentages adding up to 100
  },
});

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const data = JSON.parse(raw);
    const d = defaults();
    return {
      holdings: Array.isArray(data.holdings) ? data.holdings.filter(validHolding) : [],
      settings: { ...d.settings, ...(data.settings || {}) },
    };
  } catch {
    return defaults();
  }
}

function validHolding(h) {
  return h && typeof h.id === 'string' && typeof h.kind === 'string' && Number.isFinite(h.qty);
}

const listeners = new Set();
export const state = read();

// Example mode shows sample positions without touching what is saved.
let demo = false, savedHoldings = null;
export const isDemo = () => demo;

export function enterDemo(list) {
  if (!demo) savedHoldings = state.holdings;
  demo = true;
  state.holdings = list;
  commit('holdings');
}

export function exitDemo() {
  if (!demo) return;
  demo = false;
  state.holdings = savedHoldings || [];
  savedHoldings = null;
  commit('holdings');
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function commit(what) {
  const out = { holdings: demo ? savedHoldings : state.holdings, settings: state.settings };
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* storage full or blocked */ }
  listeners.forEach(fn => fn(what));
}

export function getHolding(id) { return state.holdings.find(h => h.id === id); }

/**
 * Add a position. If the asset is already held, the quantities are summed and
 * the average cost is re-weighted — that is what "average cost" means.
 */
export function addHolding(asset, qty, cost) {
  const cur = getHolding(asset.id);
  if (cur) {
    const total = cur.qty + qty;
    let avg = null;
    if (cur.cost != null && cost != null) avg = (cur.cost * cur.qty + cost * qty) / total;
    else if (cur.cost != null && cost == null) avg = cur.cost;
    else if (cur.cost == null && cost != null && cur.qty === 0) avg = cost;
    cur.qty = total;
    cur.cost = avg;
    if (asset.unit) cur.unit = asset.unit;
  } else {
    state.holdings.push({ ...asset, qty, cost: cost ?? null, added: Date.now() });
  }
  commit('holdings');
}

export function updateHolding(id, patch) {
  const h = getHolding(id);
  if (!h) return;
  Object.assign(h, patch);
  commit('holdings');
}

export function removeHolding(id) {
  const i = state.holdings.findIndex(h => h.id === id);
  if (i < 0) return null;
  const [h] = state.holdings.splice(i, 1);
  commit('holdings');
  return { holding: h, index: i };
}

export function restoreHolding({ holding, index }) {
  state.holdings.splice(Math.min(index, state.holdings.length), 0, holding);
  commit('holdings');
}

export function setSetting(key, value) {
  state.settings[key] = value;
  commit('settings');
}

export function replaceAll(data) {
  demo = false; savedHoldings = null;
  const d = defaults();
  state.holdings = Array.isArray(data.holdings) ? data.holdings.filter(validHolding) : [];
  state.settings = { ...d.settings, ...state.settings, ...(data.settings || {}) };
  commit('holdings');
}

/** What a copy contains: positions and preferences, never API keys. */
export function exportObject(extra = {}) {
  const holdings = demo ? savedHoldings : state.holdings;
  const { ccy, unit, targets } = state.settings;
  return { app: 'portfolio', version: 1, exported: new Date().toISOString(), holdings, settings: { ccy, unit, targets }, ...extra };
}

export function exportData(extra) {
  return JSON.stringify(exportObject(extra), null, 2);
}
