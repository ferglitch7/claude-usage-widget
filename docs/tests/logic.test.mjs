// Logic tests, no browser needed. From the app folder:   node --test
//
// They cover the parts where a silent mistake would show a wrong number:
// number parsing, average cost, the portfolio series, snapshot thinning and
// the target-allocation maths.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  data: {},
  getItem(k) { return k in this.data ? this.data[k] : null; },
  setItem(k, v) { this.data[k] = String(v); },
  removeItem(k) { delete this.data[k]; },
};

const F = await import('../js/format.js');
const S = await import('../js/store.js');
const { marketSeries, realSeries, priceAt, rangeForSpan, GRID } = await import('../js/series.js');
const { thin } = await import('../js/snapshots.js');
const { plan, suggest } = await import('../js/targets.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('parseNumber follows the locale for a lone separator', () => {
  assert.equal(F.parseNumber('0,5', 'es-MX'), 0.5);
  assert.equal(F.parseNumber('0.5', 'es-ES'), 0.5);
  assert.equal(F.parseNumber('52,000', 'es-MX'), 52000);
  assert.equal(F.parseNumber('52.000', 'es-ES'), 52000);
  assert.equal(F.parseNumber('52,000', 'es-ES'), 52);
  assert.equal(F.parseNumber('1,234.56', 'es-ES'), 1234.56);
  assert.equal(F.parseNumber('1.234,56', 'es-MX'), 1234.56);
  assert.equal(F.parseNumber('1 250,5', 'es-ES'), 1250.5);
  for (const bad of ['abc', '', '.', '-5', '1.2.3,4', '12,34.5']) assert.ok(Number.isNaN(F.parseNumber(bad, 'en-US')), bad);
});

test('adding to a position re-weights the average cost', () => {
  const btc = { id: 'crypto:bitcoin', kind: 'crypto', sym: 'BTC', name: 'Bitcoin' };
  S.addHolding(btc, 0.5, 52000);
  S.addHolding(btc, 1.5, 60000);
  const h = S.getHolding(btc.id);
  assert.equal(h.qty, 2);
  assert.equal(h.cost, 58000);
  // Part of the position without a cost makes the average unknown, not wrong.
  const gold = { id: 'metal:XAU', kind: 'metal', sym: 'XAU', name: 'Oro' };
  S.addHolding(gold, 2, null);
  S.addHolding(gold, 1, 4000);
  assert.equal(S.getHolding(gold.id).cost, null);
});

test('example mode never overwrites what is saved', () => {
  const before = JSON.parse(localStorage.getItem('portfolio.v1')).holdings.length;
  S.enterDemo([{ id: 'x', kind: 'cash', qty: 1 }]);
  S.setSetting('ccy', 'EUR');
  const saved = JSON.parse(localStorage.getItem('portfolio.v1'));
  assert.equal(saved.holdings.length, before);
  assert.equal(saved.settings.ccy, 'EUR');
  S.exitDemo();
  assert.equal(S.state.holdings.length, before);
  S.setSetting('ccy', 'USD');
});

test('copies carry positions and preferences but no API keys', () => {
  S.setSetting('finnhubKey', 'secret-1');
  S.setSetting('historyKey', 'secret-2');
  const text = S.exportData({ snapshots: [[1, 2]] });
  assert.ok(!text.includes('secret-1') && !text.includes('secret-2'));
  const doc = JSON.parse(text);
  assert.ok(Array.isArray(doc.holdings) && Array.isArray(doc.snapshots));
  assert.deepEqual(Object.keys(doc.settings).sort(), ['ccy', 'targets', 'unit']);
});

const now = 1_800_000_000_000, HOUR = 3600e3, DAY = 86400e3;
const btc = { id: 'b', kind: 'crypto', name: 'Bitcoin', qty: 2 };
const gold = { id: 'g', kind: 'metal', name: 'Oro', qty: 3 };
const cash = { id: 'c', kind: 'cash', name: 'USD', qty: 1000 };
const aapl = { id: 's', kind: 'stock', name: 'Apple', qty: 10 };
const hist = {
  b: Array.from({ length: 25 }, (_, i) => [now - DAY + i * HOUR, 50000 + i * (50000 / 24)]),
  g: Array.from({ length: 13 }, (_, i) => [now - 12 * HOUR + i * HOUR, 4000]),
};
const quotes = { b: { p: 100000 }, g: { p: 4100 }, c: { p: 1 }, s: { p: 200 } };
const base = {
  range: '1D', span: DAY, now, holdings: [btc, gold, cash, aapl], rate: 1, unit: null,
  quoteOf: a => quotes[a.id] || null,
  peek: a => (hist[a.id] ? { pts: hist[a.id] } : null),
};

test('market series: past prices times current quantities, ending on the live total', () => {
  const r = marketSeries(base);
  assert.equal(r.pts.length, GRID);
  close(r.pts[0][1], 2 * 50000 + 3 * 4000 + 1000 + 10 * 200);
  close(r.pts[GRID - 1][1], 2 * 100000 + 3 * 4100 + 1000 + 10 * 200);
  assert.equal(r.pts[0][0], now - DAY);
  assert.equal(r.pts[GRID - 1][0], now);
  assert.deepEqual(r.missing, ['Apple']); // held flat, and reported
  assert.equal(r.moved, true);
});

test('market series: display currency, missing quotes and units', () => {
  const usd = marketSeries(base), mxn = marketSeries({ ...base, rate: 20 });
  close(mxn.pts[7][1] / usd.pts[7][1], 20);

  // An asset without a price is not in the balance, so not in the chart either.
  const noQuote = marketSeries({ ...base, quoteOf: a => (a.id === 's' ? null : quotes[a.id]) });
  close(noQuote.pts[GRID - 1][1], 200000 + 12300 + 1000);
  assert.deepEqual(noQuote.missing, []);

  // Counted in bitcoin, a bitcoin-only portfolio is a flat line at its quantity.
  const inBtc = marketSeries({ ...base, holdings: [btc], unit: { asset: btc, usd: 100000 } });
  assert.equal(inBtc.inUnit, true);
  for (const p of inBtc.pts) close(p[1], 2, 1e-9);

  // A unit whose history does not reach the start cannot convert old values.
  assert.equal(marketSeries({ ...base, unit: { asset: gold, usd: 4100 } }).inUnit, false);
});

test('priceAt and rangeForSpan', () => {
  assert.equal(priceAt(hist.b, now - 2 * DAY), 50000);
  assert.equal(priceAt(hist.b, now - DAY + 1.5 * HOUR), hist.b[1][1]);
  assert.equal(priceAt(hist.b, now + DAY), 100000);
  assert.deepEqual([2 * HOUR, 3 * DAY, 20 * DAY, 200 * DAY].map(rangeForSpan), ['1D', '1S', '1M', '1A']);
});

test('real series needs an hour of records and ends on the live balance', () => {
  const none = realSeries({ snaps: [[now - 10 * 60e3, 500]], now, liveUsd: 510, rate: 1, unit: null, peek: () => null });
  assert.equal(none, null);
  const r = realSeries({ snaps: [[now - 3 * DAY, 400], [now - DAY, 450]], now, liveUsd: 510, rate: 2, unit: null, peek: () => null });
  assert.deepEqual(r.pts.map(p => p[1]), [800, 900, 1020]);
});

test('snapshots thin out with age and keep the newest', () => {
  const many = [];
  for (let t = now - 400 * DAY; t <= now; t += 20 * 60e3) many.push([t, 1]);
  const out = thin(many, now);
  const count = (lo, hi) => out.filter(s => now - s[0] > lo && now - s[0] <= hi).length;
  assert.ok(Math.abs(count(-1, 2 * DAY) - 96) <= 2);          // every 30 minutes
  assert.ok(Math.abs(count(2 * DAY, 30 * DAY) - 112) <= 2);    // every 6 hours
  assert.ok(Math.abs(count(30 * DAY, Infinity) - 370) <= 2);   // daily
  assert.equal(out[out.length - 1][0], many[many.length - 1][0]);
});

test('target plan: drift and the money to move', () => {
  const kinds = [['crypto', 8000], ['cash', 2000]];
  const p = plan(kinds, 10000, { crypto: 60, stock: 0, metal: 20, cash: 20, custom: 0 });
  const by = Object.fromEntries(p.map(x => [x.kind, x]));
  close(by.crypto.drift, 0.2); close(by.crypto.move, -2000);   // sell 2,000
  close(by.metal.drift, -0.2); close(by.metal.move, 2000);     // buy 2,000
  close(by.cash.move, 0);
  close(p.reduce((n, x) => n + x.move, 0), 0);                 // moves net to zero
  assert.equal(plan(kinds, 10000, null)[0].drift, null);
});

test('suggested targets are steps of five that add up to 100', () => {
  for (const kinds of [[['crypto', 8034], ['cash', 1966]], [['crypto', 1], ['stock', 1], ['metal', 1]], [['metal', 5]]]) {
    const total = kinds.reduce((n, k) => n + k[1], 0);
    const s = suggest(kinds, total);
    assert.equal(Object.values(s).reduce((n, v) => n + v, 0), 100);
    for (const v of Object.values(s)) assert.equal(v % 5, 0);
  }
  assert.equal(Object.values(suggest([], 0)).reduce((n, v) => n + v, 0), 0);
});
