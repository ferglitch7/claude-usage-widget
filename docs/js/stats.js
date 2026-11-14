// Context figures for the asset detail screen: the day's range, distance from
// the high, market cap. Whatever the available sources return; nothing made up.
// Each row is { label, value } already formatted for display.

import * as F from './format.js';

const CG = 'https://api.coingecko.com/api/v3';
const CB = 'https://api.exchange.coinbase.com';
const FINNHUB = 'https://finnhub.io/api/v1';
const TD = 'https://api.twelvedata.com';

const cache = new Map(); // asset id -> { t, raw }
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// raw: { high, low, peak, peakLabel, cap } in USD, any of them may be null.
async function crypto(a) {
  try {
    const d = (await json(`${CG}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(a.cg)}`))[0];
    if (d) return { dayLabel: '24 h', high: num(d.high_24h), low: num(d.low_24h), peak: num(d.ath), peakLabel: 'Máximo histórico', cap: num(d.market_cap) };
  } catch { /* rate limited: fall through to the exchange */ }
  if (!a.cb) return null;
  const s = await json(`${CB}/products/${a.cb}/stats`);
  return { dayLabel: '24 h', high: num(s.high), low: num(s.low), peak: null, cap: null };
}

async function twelve(sym, key) {
  const d = await json(`${TD}/quote?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}`);
  if (d.status === 'error' || d.code) throw new Error(d.message || 'error');
  const y = d.fifty_two_week || {};
  return { dayLabel: 'del día', high: num(d.high), low: num(d.low), peak: num(y.high), peakLabel: 'Máximo de 52 semanas', cap: null };
}

async function stock(a, { finnhubKey, historyKey }) {
  const sym = a.sym.replace('-', '.');
  if (finnhubKey) {
    try {
      const token = encodeURIComponent(finnhubKey);
      const [q, m] = await Promise.all([
        json(`${FINNHUB}/quote?symbol=${encodeURIComponent(sym)}&token=${token}`),
        json(`${FINNHUB}/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${token}`).catch(() => null),
      ]);
      const metric = (m && m.metric) || {};
      const capM = num(metric.marketCapitalization); // reported in millions
      return { dayLabel: 'del día', high: num(q.h), low: num(q.l), peak: num(metric['52WeekHigh']), peakLabel: 'Máximo de 52 semanas', cap: capM ? capM * 1e6 : null };
    } catch { /* try the other source */ }
  }
  return historyKey ? twelve(sym, historyKey) : null;
}

async function fetchRaw(a, keys) {
  if (a.kind === 'crypto') return crypto(a);
  if (a.kind === 'stock') return stock(a, keys);
  if (a.kind === 'metal' && a.sym === 'XAU' && keys.historyKey) return twelve('XAU/USD', keys.historyKey);
  return null;
}

/** price: live USD price; rate: display currency per USD. Never throws. */
export async function loadStats(a, { price, rate, ccy, finnhubKey, historyKey }) {
  let hit = cache.get(a.id);
  if (!hit || Date.now() - hit.t > 5 * 60e3) {
    try {
      const raw = await fetchRaw(a, { finnhubKey, historyKey });
      if (raw) { hit = { t: Date.now(), raw }; cache.set(a.id, hit); }
    } catch { /* keep whatever was cached */ }
  }
  if (!hit) return [];
  const s = hit.raw, rows = [];
  const money = v => F.price(v * rate, ccy);
  if (s.high) rows.push({ label: `Máximo ${s.dayLabel}`, value: money(s.high) });
  if (s.low) rows.push({ label: `Mínimo ${s.dayLabel}`, value: money(s.low) });
  if (s.peak) {
    rows.push({ label: s.peakLabel, value: money(s.peak) });
    if (price) rows.push({ label: 'Distancia al máximo', value: F.pct(Math.min(0, price / s.peak - 1)) });
  }
  if (s.cap) rows.push({ label: 'Capitalización', value: F.compactMoney(s.cap * rate, ccy) });
  return rows;
}
