// Screens and wiring: home (balance, chart, allocation, list), add, detail, settings.

import {
  state, subscribe, addHolding, updateHolding, removeHolding, restoreHolding,
  setSetting, replaceAll, exportData, exportObject, getHolding, enterDemo, exitDemo, isDemo,
} from './store.js';
import * as P from './prices.js';
import * as H from './history.js';
import * as F from './format.js';
import { KINDS, UNITS, METALS, CRYPTO, STOCKS, CASH, searchLocal, searchRemote, newCustomAsset } from './catalog.js';
import { h, spring, pan, rubber, haptic, ICONS, reduceMotion } from './motion.js';
import { logo } from './logo.js';
import { createChart } from './chart.js';
import { openSheet, makeView, toast } from './sheet.js';
import { Roller, segmented, setPill, toggle, sparkEl, drawSpark } from './ui.js';
import { marketSeries, realSeries, rangeForSpan } from './series.js';
import { snapshots, recordSnapshot, replaceSnapshots } from './snapshots.js';
import { targets, plan, openTargets } from './targets.js';
import { loadStats } from './stats.js';
import { startUpdates, APP_VERSION } from './update.js';
import { initBackup, scheduleBackup, backupStatus, fetchBackup, copyCode, onBackup } from './backup.js';

const $ = id => document.getElementById(id);
const ccy = () => state.settings.ccy;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const RANGE_LABEL = { '1D': '24 h', '1S': '7 días', '1M': '30 días', '1A': '1 año' };
const meter = document.createElement('canvas').getContext('2d');

// The balance can also be counted in bitcoin or in ounces of gold; both are
// followed all the time so switching is instant.
const BTC = CRYPTO.find(a => a.cg === 'bitcoin');
const XAU = METALS[0];
const UNIT_CYCLE = ['ccy', 'btc', 'xau'];

// ============================================================================
// Valuation
// ============================================================================

function valuation() {
  const r = P.rate(ccy());
  let total = 0, day = 0, hasDay = false, cost = 0, costValue = 0, loading = false;
  const rows = state.holdings.map(a => {
    const q = P.quoteOf(a);
    const value = q ? q.p * a.qty * r : null;
    const dayAbs = q && q.prev ? (q.p - q.prev) * a.qty * r : null;
    const dayPct = q && q.prev ? q.p / q.prev - 1 : null;
    const gainAbs = q && a.cost != null ? (q.p - a.cost) * a.qty * r : null;
    const gainPct = q && a.cost ? q.p / a.cost - 1 : null;
    if (value != null) total += value;
    else if (a.kind !== 'stock' || P.stockState() === 'ok') loading = true; // a price is still on its way
    if (dayAbs != null) { day += dayAbs; hasDay = true; }
    if (gainAbs != null) { cost += a.cost * a.qty * r; costValue += value; }
    return { a, q, value, dayAbs, dayPct, gainAbs, gainPct };
  });
  rows.sort((x, y) => (y.value ?? -1) - (x.value ?? -1));
  const kinds = new Map();
  for (const row of rows) if (row.value) kinds.set(row.a.kind, (kinds.get(row.a.kind) || 0) + row.value);
  return {
    rows, total, totalUsd: total / r, rate: r, loading,
    day: hasDay && total - day > 0 ? { abs: day, pct: day / (total - day) } : null,
    gain: cost > 0 ? { abs: costValue - cost, pct: costValue / cost - 1 } : null,
    kinds: [...kinds].sort((x, y) => y[1] - x[1]),
  };
}

/** The asset the balance is counted in, or null for the display currency. */
function unitNow() {
  const id = state.settings.unit;
  const asset = id === 'btc' ? BTC : id === 'xau' ? XAU : null;
  const q = asset && P.quoteOf(asset);
  return q ? { id, asset, usd: q.p, prev: q.prev } : null;
}

function qtyLabel(a) {
  if (a.kind === 'metal') {
    const u = UNITS[a.unit] ? a.unit : 'oz';
    return `${F.qty(a.qty * UNITS[u].perOz)} ${UNITS[u].label}`;
  }
  if (a.kind === 'cash') return `${F.qty(a.qty)} ${a.sym}`;
  if (a.kind === 'custom') return 'Manual';
  return `${F.qty(a.qty)} ${a.sym}`;
}

// ============================================================================
// Home
// ============================================================================

const roller = new Roller($('roller'));
const rowMap = new Map();    // holding id -> row refs
const segMap = new Map();    // kind -> allocation segment
const tsegMap = new Map();   // kind -> target segment
const chipMap = new Map();   // kind -> legend chip
let filter = null;           // show only one class when set
let pillMode = 'range';      // 'range' (follows the chart) | 'total' (vs cost)
let lastShown = null, lastShownMode = '';
let openRow = null;
let firstPaint = true;
let ctx = null;              // what the last render computed: { v, u, info }
let homeScrub = null;        // { t, v, first } while a finger is on the chart
let chartSig = '', chartInfo = null;
const ACT = 148;             // width of the two swipe actions

const homeChart = createChart($('pchart'), { deferred: true, onScrub: s => { homeScrub = s; if (ctx) paintHero(ctx); } });
const rangeSeg = segmented([['1D', '1D'], ['1S', '1S'], ['1M', '1M'], ['1A', '1A'], ['real', 'Real']], state.settings.range, r => setSetting('range', r));
$('prange').append(rangeSeg.el);

/** The chart's series, rebuilt only when something it depends on changed. */
function chartSeries(v, u) {
  const range = state.settings.range;
  const sig = [
    range, u ? u.id : 'ccy', ccy(), H.historyVersion(), snapshots().length,
    state.holdings.map(a => `${a.id}:${a.qty}:${P.quoteOf(a) ? 1 : 0}`).join(','),
  ].join('|');
  if (sig === chartSig) return { info: chartInfo, fresh: false };
  chartSig = sig;
  const now = Date.now();
  const unit = u ? { asset: u.asset, usd: u.usd } : null;
  chartInfo = range === 'real'
    ? realSeries({ snaps: snapshots(), now, liveUsd: v.totalUsd, rate: v.rate, unit, peek: H.peek })
    : marketSeries({ range, span: H.RANGES[range].span, now, holdings: state.holdings, quoteOf: P.quoteOf, peek: H.peek, rate: v.rate, unit });
  return { info: chartInfo, fresh: true };
}

/** What the pill under the balance says, or null to hide it. */
function pillData({ v, u, info }) {
  const range = state.settings.range;
  if (homeScrub && info) {
    const span = info.pts[info.pts.length - 1][0] - info.pts[0][0];
    return { ratio: homeScrub.v / homeScrub.first - 1, abs: null, label: F.timeLabel(homeScrub.t, range === 'real' ? rangeForSpan(span) : range) };
  }
  if (pillMode === 'total' && v.gain) return { ratio: v.gain.pct, abs: v.gain.abs, label: 'total' };
  if (range !== '1D' && info && info.moved) {
    const first = info.pts[0][1], last = info.pts[info.pts.length - 1][1];
    if (first > 0) {
      return { ratio: last / first - 1, abs: info.inUnit ? null : last - first, label: range === 'real' ? `desde ${F.dateLabel(info.pts[0][0])}` : RANGE_LABEL[range] };
    }
  }
  if (!v.day) return null;
  if (u && u.prev) {
    // Today's change measured in the unit: the unit's own move is taken out.
    const prevUsd = v.totalUsd - v.day.abs / v.rate;
    if (prevUsd > 0) return { ratio: (v.totalUsd / u.usd) / (prevUsd / u.prev) - 1, abs: null, label: 'hoy' };
  }
  return { ratio: v.day.pct, abs: v.day.abs, label: 'hoy' };
}

/** Balance, pill and glow. Cheap enough to run on every scrub move. */
function paintHero(c) {
  const { v, u, info } = c;
  const has = state.holdings.length > 0, hidden = state.settings.hidden;
  const scrubbing = !!(homeScrub && info);
  const asUnit = scrubbing ? info.inUnit : !!u;
  const value = !has ? 0 : scrubbing ? homeScrub.v : asUnit ? v.totalUsd / u.usd : v.total;

  const parts = hidden ? [{ type: 'integer', value: '•••••' }] : asUnit ? F.unitParts(value, u.id) : F.moneyParts(value, ccy());
  const len = parts.reduce((n, p) => n + p.value.length, 0);
  $('balance').dataset.size = len <= 9 ? 'l' : len <= 11 ? 'm' : len <= 13 ? 's' : 'xs';
  const mode = hidden ? 'hidden' : asUnit ? u.id : ccy();
  const dir = scrubbing || lastShown == null || mode !== lastShownMode ? 0 : Math.sign(value - lastShown);
  roller.set(parts, dir);
  lastShown = value; lastShownMode = mode;
  if (!scrubbing) $('nav-title').textContent = hidden ? 'Portfolio' : asUnit ? F.unitText(value, u.id) : F.money(value, ccy());

  const pill = $('change');
  if (pillMode === 'total' && !v.gain) pillMode = 'range';
  const m = has ? pillData(c) : null;
  pill.hidden = !m;
  if (m) setPill(pill, m.ratio, hidden ? null : m.abs, m.label);
  pill.dataset.toggle = v.gain ? '1' : '';
  $('page').dataset.trend = !m || hidden ? '' : m.ratio > 0.00005 ? 'up' : m.ratio < -0.00005 ? 'down' : '';
}

function renderChart(c) {
  const has = state.holdings.length > 0;
  $('home-chart').hidden = !has;
  if (!has) { c.info = null; return; }
  const { info, fresh } = chartSeries(c.v, c.u);
  c.info = info;
  $('pchart').classList.toggle('empty', !info);
  $('chart-empty').hidden = !!info;
  if (info) {
    if (fresh) homeChart.setData(info.pts);
    else if (!homeScrub) homeChart.tick(info.inUnit ? c.v.totalUsd / c.u.usd : c.v.total);
  }
  const note = $('chart-note');
  const missing = info ? info.missing : [];
  note.hidden = missing.length === 0;
  if (missing.length) {
    const names = missing.length > 3 ? `${missing.slice(0, 2).join(', ')} y ${missing.length - 2} más` : missing.join(', ');
    const needsKey = state.holdings.some(a => H.availability(a) === 'needs-key');
    note.textContent = `Sin histórico: ${names}`;
    note.dataset.action = needsKey ? '1' : '';
  }
}

function renderHome() {
  const v = valuation();
  const u = unitNow();
  const has = state.holdings.length > 0;
  const hidden = state.settings.hidden;
  ctx = { v, u, info: null };

  $('hero').hidden = !has;
  renderChart(ctx);
  paintHero(ctx);
  renderAlloc(v);
  renderNotice();
  renderList(v);

  $('empty').hidden = has;
  $('demo-bar').hidden = !isDemo();
  $('list').classList.toggle('masked', hidden);
  const st = P.status();
  $('live').classList.toggle('on', st === 'live');
  $('live').title = { live: 'En vivo', stale: 'Reconectando', loading: 'Conectando', offline: 'Sin conexión' }[st];

  // The real history: one record of the balance every half hour the app is open.
  if (has && !isDemo() && !v.loading && recordSnapshot(v.totalUsd)) scheduleBackup(4000);

  if (firstPaint) hideSplash();
  firstPaint = false;
}

function renderAlloc(v) {
  const bar = $('alloc-bar'), tbar = $('alloc-target'), legend = $('alloc-legend');
  const t = targets();
  const rows = plan(v.kinds, v.total, t).filter(x => x.value > 0 || (x.target || 0) > 0);
  rows.sort((x, y) => y.value - x.value || (y.target || 0) - (x.target || 0));
  $('alloc').hidden = v.kinds.length === 0;
  if (filter && !v.kinds.some(k => k[0] === filter)) filter = null;

  const live = new Set();
  rows.forEach((x, i) => {
    const kind = x.kind;
    live.add(kind);

    let seg = segMap.get(kind);
    if (x.value > 0) {
      if (!seg) { seg = h('div.alloc-seg', { style: { background: KINDS[kind].color } }); bar.append(seg); segMap.set(kind, seg); }
      seg.style.order = i;
      seg.style.flex = `${Math.max(x.share, 0.004)} 1 0px`;
      seg.classList.toggle('on', filter === kind);
    } else if (seg) { seg.remove(); segMap.delete(kind); }

    let tseg = tsegMap.get(kind);
    if (t && x.target > 0) {
      if (!tseg) { tseg = h('div.alloc-seg', { style: { background: KINDS[kind].color } }); tbar.append(tseg); tsegMap.set(kind, tseg); }
      tseg.style.order = i;
      tseg.style.flex = `${x.target} 1 0px`;
    } else if (tseg) { tseg.remove(); tsegMap.delete(kind); }

    let chip = chipMap.get(kind);
    if (!chip) {
      chip = h('button.chip', { type: 'button', onclick: () => { filter = filter === kind ? null : kind; haptic(5); renderHome(); } },
        h('i', { style: { background: KINDS[kind].color } }), h('span', { text: KINDS[kind].label }), h('b'), h('em'));
      legend.append(chip);
      chipMap.set(kind, chip);
    }
    chip.style.order = i;
    chip.children[2].textContent = F.share(x.share);
    // How far this class is from its target, in percentage points.
    const pts = x.drift == null ? 0 : Math.round(x.drift * 100);
    chip.children[3].textContent = pts ? (pts > 0 ? `+${pts}` : `−${-pts}`) : '';
    chip.classList.toggle('on', filter === kind);
    chip.setAttribute('aria-pressed', String(filter === kind));
  });
  for (const [kind, chip] of chipMap) {
    if (live.has(kind)) continue;
    chip.remove(); chipMap.delete(kind);
    const seg = segMap.get(kind); if (seg) { seg.remove(); segMap.delete(kind); }
    const tseg = tsegMap.get(kind); if (tseg) { tseg.remove(); tsegMap.delete(kind); }
  }
  tbar.hidden = !t;
  bar.classList.toggle('filtered', !!filter);
  $('btn-targets').classList.toggle('set', !!t);
}

function renderNotice() {
  const box = $('notice');
  const stocks = state.holdings.some(a => a.kind === 'stock');
  const st = P.stockState();
  const show = stocks && st !== 'ok';
  box.hidden = !show;
  if (!show) return;
  const msg = st === 'invalid' ? 'La llave de Finnhub no es válida' : 'Acciones sin precio en vivo';
  if (box.dataset.msg === msg) return;
  box.dataset.msg = msg;
  box.replaceChildren(h('span', { text: msg }), h('button', { type: 'button', text: st === 'invalid' ? 'Revisar' : 'Conectar', onclick: () => openSettings() }));
}

function slideRow(row, to, velocity = 0) {
  if (row.anim) row.anim.stop();
  row.anim = spring({ from: row.x, to, velocity, stiffness: 420, damping: 38, onUpdate: x => setRowX(row, x) });
}
function setRowX(row, x) {
  row.x = x;
  row.main.style.transform = x ? `translate3d(${x}px,0,0)` : '';
  row.el.classList.toggle('swiped', x < -0.5);
}
function closeOpenRow(except) {
  if (openRow && openRow !== except) { slideRow(openRow, 0); openRow = null; }
}

function createRow(a) {
  const name = h('div.row-name'), sub = h('div.row-sub'), val = h('div.row-val'), chg = h('div.row-chg');
  const spark = sparkEl();
  const main = h('div.row-main', { role: 'button', tabIndex: 0 },
    logo(a), h('div.row-mid', null, name, sub), spark, h('div.row-end', null, val, chg));
  const edit = h('button.act.edit', { type: 'button', tabIndex: -1, 'aria-label': 'Editar', html: ICONS.pencil });
  const del = h('button.act.del', { type: 'button', tabIndex: -1, 'aria-label': 'Eliminar', html: ICONS.trash });
  const el = h('div.row', null, h('div.row-actions', null, edit, del), main);
  const row = { id: a.id, el, main, name, sub, val, chg, spark, sparkSrc: null, x: 0, base: 0, w: 0, full: false, anim: null };

  const open = () => {
    if (row.x < -4) { slideRow(row, 0); openRow = null; return; }
    closeOpenRow();
    openDetail(a.id);
  };
  main.addEventListener('click', open);
  main.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  edit.addEventListener('click', () => { slideRow(row, 0); openRow = null; openDetail(a.id, { edit: true }); });
  del.addEventListener('click', () => deleteHolding(a.id));

  pan(main, {
    axis: 'x',
    onStart: () => { closeOpenRow(row); if (row.anim) row.anim.stop(); row.base = row.x; row.w = el.offsetWidth; },
    onMove: d => {
      let x = row.base + d;
      if (x > 0) x = rubber(x, row.w) * 0.35;
      setRowX(row, x);
      const full = x < -row.w * 0.6;
      if (full !== row.full) { row.full = full; el.classList.toggle('full', full); haptic(12); }
    },
    onEnd: v => {
      if (row.full) { deleteHolding(a.id); return; }
      if (row.x < -ACT / 2 || v < -0.4) { slideRow(row, -ACT, v); openRow = row; }
      else { slideRow(row, 0, v); if (openRow === row) openRow = null; }
    },
  });
  return row;
}

function renderList(v) {
  const list = $('list');
  const rows = filter ? v.rows.filter(r => r.a.kind === filter) : v.rows;

  // FLIP: remember where each row is, reorder, then animate from the old place.
  const before = new Map();
  if (!firstPaint) rowMap.forEach((row, id) => before.set(id, row.el.getBoundingClientRect().top));

  const wanted = new Set(rows.map(r => r.a.id));
  for (const [id, row] of rowMap) {
    if (wanted.has(id)) continue;
    if (openRow === row) openRow = null;
    row.el.remove();
    rowMap.delete(id);
  }

  const order = [];
  let longest = 0;
  for (const r of rows) {
    const a = r.a;
    let row = rowMap.get(a.id);
    const isNew = !row;
    if (isNew) { row = createRow(a); rowMap.set(a.id, row); }
    row.name.textContent = a.name;
    row.sub.textContent = qtyLabel(a);
    row.val.textContent = r.value != null ? F.money(r.value, ccy()) : '—';
    longest = Math.max(longest, row.val.textContent.length);

    // Second line on the right: change (today or vs cost), else the unit price.
    const ratio = pillMode === 'total' ? r.gainPct : r.dayPct;
    if (ratio != null) {
      row.chg.textContent = F.pct(ratio);
      row.chg.className = 'row-chg ' + (ratio > 0.00005 ? 'up' : ratio < -0.00005 ? 'down' : '');
    } else {
      row.chg.className = 'row-chg';
      if (a.kind === 'custom' || (a.kind === 'cash' && a.sym === ccy())) row.chg.textContent = '';
      else row.chg.textContent = r.q ? F.price(r.q.p * v.rate, ccy()) : a.kind === 'stock' ? 'Sin precio' : 'Cargando';
    }

    // Seven-day trend, redrawn only when its data changes.
    const week = H.peek(a, '1S');
    const src = week ? week.pts : null;
    if (src !== row.sparkSrc) {
      row.sparkSrc = src;
      if (src) drawSpark(row.spark, src, 7 * 86400e3); else row.spark.classList.remove('on');
    }
    order.push({ row, isNew });
  }
  // Long amounts leave no room for the trend line on a phone.
  list.classList.toggle('no-spark', longest > 11 && list.clientWidth < 440);

  const current = [...list.children];
  const same = current.length === order.length && order.every((o, i) => current[i] === o.row.el);
  if (!same) order.forEach(o => list.append(o.row.el));

  if (firstPaint || reduceMotion()) return;
  for (const { row, isNew } of order) {
    if (isNew) {
      const hgt = row.el.offsetHeight;
      row.el.animate([{ height: '0px', opacity: 0 }, { height: hgt + 'px', opacity: 1 }], { duration: 420, easing: EASE });
      continue;
    }
    const dy = before.get(row.id) - row.el.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) row.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 520, easing: EASE });
  }
}

function deleteHolding(id) {
  const a = getHolding(id);
  if (!a) return;
  const row = rowMap.get(id);
  const finish = () => {
    const undo = removeHolding(id);
    if (undo) toast(`${a.name} eliminado`, { action: { label: 'Deshacer', run: () => restoreHolding(undo) } });
  };
  haptic(14);
  if (row && !reduceMotion()) {
    if (openRow === row) openRow = null;
    const hgt = row.el.offsetHeight;
    row.el.animate([{ height: hgt + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 300, easing: EASE, fill: 'forwards' }).onfinish = finish;
  } else finish();
}

// Price ticks arrive several times a second; the home repaints about once a second.
let renderTimer = 0, lastRender = 0;
function scheduleRender(now) {
  if (now) { clearTimeout(renderTimer); renderTimer = 0; lastRender = performance.now(); renderHome(); return; }
  if (renderTimer) return;
  const wait = Math.max(0, 900 - (performance.now() - lastRender));
  renderTimer = setTimeout(() => { renderTimer = 0; lastRender = performance.now(); renderHome(); }, wait);
}

function hideSplash() {
  const s = $('splash');
  if (!s) return;
  s.classList.add('gone');
  setTimeout(() => s.remove(), 500);
}

// ============================================================================
// Add
// ============================================================================

function pickRow(a, onPick, { all }) {
  const held = getHolding(a.id);
  const sub = all && a.kind !== 'cash' ? `${a.sym} · ${KINDS[a.kind].label}` : a.sym;
  return h('button.pick', { type: 'button', onclick: onPick },
    logo(a),
    h('div.pick-mid', null, h('div.pick-name', { text: a.name }), h('div.pick-sub', { text: sub })),
    h('div.pick-end', null, held && h('span', { text: qtyLabel(held) }), h('span', { html: ICONS.chevron })));
}

function openAdd() {
  let kind = 'all', seq = 0, timer = 0, ctrl = null, sheet = null;
  const input = h('input.search-input', {
    id: 'add-search', type: 'search', placeholder: 'Buscar', autocomplete: 'off', autocorrect: 'off',
    autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Buscar activo',
  });
  const seg = segmented([['all', 'Todo'], ['crypto', 'Crypto'], ['stock', 'Acciones'], ['metal', 'Metales'], ['cash', 'Efectivo']], kind, k => { kind = k; update(); });
  const list = h('div.pick-list');
  const busy = h('div.searching', { hidden: true }, h('span.spinner.spin'));
  const hint = h('p.hint', { hidden: true }, 'Para buscar cualquier acción o ETF de EE. UU., conecta Finnhub en ',
    h('button', { type: 'button', text: 'Ajustes', onclick: () => openSettings() }), '.');
  const other = h('div.pick-list', null, h('button.pick', { type: 'button', onclick: () => sheet.push(amountView(sheet, newCustomAsset(''))) },
    h('span.logo.pick-plus', { html: ICONS.plus }),
    h('div.pick-mid', null, h('div.pick-name', { text: 'Otro activo' }), h('div.pick-sub', { text: 'Inmueble, fondo, negocio…' })),
    h('div.pick-end', null, h('span', { html: ICONS.chevron }))));

  const paint = items => {
    list.replaceChildren(...items.map(a => pickRow(a, () => {
      const v = amountView(sheet, a);
      sheet.push(v);
      v.focus();
    }, { all: kind === 'all' })));
  };

  function update() {
    const q = input.value;
    const local = searchLocal(q, kind);
    paint(local);
    clearTimeout(timer);
    if (ctrl) ctrl.abort();
    const my = ++seq;
    const remote = q.trim().length >= 2 && (kind === 'all' || kind === 'crypto' || kind === 'stock');
    busy.hidden = !remote;
    hint.hidden = !((kind === 'stock' || (kind === 'all' && q.trim())) && !state.settings.finnhubKey);
    other.hidden = !(kind === 'all');
    if (!remote) return;
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      const found = await searchRemote(q, kind, { finnhubKey: state.settings.finnhubKey, signal: ctrl.signal });
      if (my !== seq) return;
      busy.hidden = true;
      const ids = new Set(local.map(a => a.id));
      paint([...local, ...found.filter(a => !ids.has(a.id) && ids.add(a.id))]);
    }, 320);
  }
  input.addEventListener('input', update);

  const view = makeView({
    title: 'Añadir',
    body: [h('div.search-wrap', null, h('label.search-bar', null, h('span', { html: ICONS.search }), input), seg.el), list, busy, other, hint],
  });
  view.onRemove = () => { clearTimeout(timer); if (ctrl) ctrl.abort(); };
  sheet = openSheet(view);
  update();
}

/** Quantity (and optional average cost) for a new or existing position. */
function amountView(sheet, asset, { edit = false } = {}) {
  const held = getHolding(asset.id);
  const isMetal = asset.kind === 'metal', isCash = asset.kind === 'cash', isCustom = asset.kind === 'custom';
  let unit = isMetal ? (held && UNITS[held.unit] ? held.unit : 'oz') : null;
  const per = () => (isMetal ? UNITS[unit].perOz : 1);            // display units per stored unit
  const unitLabel = () => (isMetal ? UNITS[unit].label : isCustom ? ccy() : asset.sym);

  const priceEl = h('div.amt-price');
  const valueEl = h('div.amt-value');
  const unitEl = h('span.amt-unit', { text: unitLabel() });
  const qtyInput = h('input.amt-input', { id: 'amt-qty', type: 'text', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', 'aria-label': isCustom ? 'Valor' : 'Cantidad' });
  const costInput = h('input.field-input', { id: 'amt-cost', type: 'text', inputmode: 'decimal', placeholder: 'Opcional', autocomplete: 'off' });
  const costSuffix = h('span.field-suffix');
  const nameInput = isCustom && h('input.field-input', { id: 'amt-name', type: 'text', placeholder: 'Departamento, fondo…', autocomplete: 'off', value: asset.name || '' });
  const btn = h('button.btn-primary', { type: 'button', text: edit ? 'Guardar' : 'Añadir', disabled: true });
  const nameEl = h('div.amt-name', { text: isCustom ? (asset.name || 'Otro activo') : asset.name });

  const r = () => P.rate(ccy());
  // The big number is exactly as wide as its text so the unit sits right after it.
  const fit = () => {
    const text = qtyInput.value || '0';
    qtyInput.style.fontSize = text.length > 12 ? '30px' : text.length > 8 ? '40px' : '';
    const cs = getComputedStyle(qtyInput);
    if (!cs.fontSize) { qtyInput.style.width = `${text.length + 0.3}ch`; return; }
    meter.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    qtyInput.style.width = Math.ceil(meter.measureText(text).width + parseFloat(cs.fontSize) * 0.1) + 'px';
  };

  function refresh() {
    const q = P.quoteOf(asset);
    const n = F.parseNumber(qtyInput.value);
    costSuffix.textContent = isCustom ? ccy() : `${ccy()} / ${unitLabel()}`;
    if (isCustom) {
      priceEl.textContent = 'Valor que tú defines';
      valueEl.textContent = '';
    } else if (isCash) {
      priceEl.textContent = asset.sym === ccy() ? '' : q ? `1 ${asset.sym} = ${F.price(q.p * r(), ccy())}` : '';
      valueEl.textContent = asset.sym !== ccy() && q && n > 0 ? '≈ ' + F.money(n * q.p * r(), ccy()) : '';
    } else {
      const unitPrice = q ? (q.p * r()) / per() : null;
      priceEl.textContent = unitPrice != null ? `${F.price(unitPrice, ccy())} / ${unitLabel()}` : asset.kind === 'stock' ? 'Sin precio en vivo' : 'Cargando precio…';
      valueEl.textContent = unitPrice != null && n > 0 ? '≈ ' + F.money(n * unitPrice, ccy()) : '';
    }
    const nameOk = !isCustom || nameInput.value.trim().length > 0;
    const costRaw = costInput.value.trim();
    const costOk = !costRaw || F.parseNumber(costRaw) >= 0;
    btn.disabled = !(n > 0 && nameOk && costOk);
  }

  // Prefill when editing.
  if (edit && held) {
    qtyInput.value = F.editable(isCustom ? held.price * r() : held.qty * per());
    if (held.cost != null) costInput.value = F.editable(isCustom ? held.cost * r() : (held.cost * r()) / per());
  }
  fit();

  const unitSeg = isMetal && segmented(Object.entries(UNITS).map(([k, u]) => [k, u.label]), unit, u => { unit = u; unitEl.textContent = unitLabel(); refresh(); });
  qtyInput.addEventListener('input', () => { fit(); refresh(); });
  costInput.addEventListener('input', refresh);
  if (nameInput) nameInput.addEventListener('input', () => { nameEl.textContent = nameInput.value.trim() || 'Otro activo'; refresh(); });

  function save() {
    const n = F.parseNumber(qtyInput.value);
    if (!(n > 0)) return;
    const c = F.parseNumber(costInput.value);
    const hasCost = costInput.value.trim() !== '' && Number.isFinite(c);
    haptic(10);
    if (isCustom) {
      const patch = { name: nameInput.value.trim(), price: n / r(), cost: hasCost ? c / r() : null };
      if (edit) updateHolding(asset.id, patch);
      else addHolding({ ...asset, ...patch }, 1, patch.cost);
    } else {
      const qty = n / per();
      const cost = hasCost && !isCash ? (c / r()) * per() : null;
      if (edit) updateHolding(asset.id, { qty, cost, ...(isMetal ? { unit } : {}) });
      else addHolding(isMetal ? { ...asset, unit } : asset, qty, cost);
    }
    if (edit && sheet.depth > 1) sheet.pop(); else sheet.close();
  }
  btn.addEventListener('click', save);
  for (const el of [qtyInput, costInput, nameInput]) {
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter' && !btn.disabled) save(); });
  }

  const fields = [];
  if (nameInput) fields.push(h('label.field', null, h('span.field-label', { text: 'Nombre' }), nameInput));
  if (!isCash) fields.push(h('label.field', null, h('span.field-label', { text: isCustom ? 'Costo' : 'Costo promedio' }), costInput, costSuffix));

  const view = makeView({
    title: edit ? 'Editar' : '',
    body: [
      h('div.amt-top', null, logo(isCustom && !asset.name ? { ...asset, name: '+' } : asset), nameEl, priceEl),
      h('div.amt-entry', null, h('div.amt-line', null, qtyInput, unitEl), valueEl, unitSeg && unitSeg.el),
      fields.length ? h('div.group', null, fields) : null,
      held && !edit && !isCustom ? h('p.hint', { text: `Se suma a tu posición actual (${qtyLabel(held)}).`, style: { textAlign: 'center' } }) : null,
    ],
    foot: btn,
  });

  P.watch(isCustom ? null : asset);
  const off = P.onPrices(refresh);
  view.onRemove = () => { off(); P.watch(null); };
  view.onShow = fit;
  view.focus = () => { fit(); try { (nameInput && !edit ? nameInput : qtyInput).focus({ preventScroll: true }); } catch { /* not focusable yet */ } };
  refresh();
  return view;
}

// ============================================================================
// Detail
// ============================================================================

function openDetail(id, { edit = false } = {}) {
  const a0 = getHolding(id);
  if (!a0) return;
  let range = '1D', chart = null, scrub = null, loadSeq = 0, sheet = null;
  const avail = H.availability(a0);

  const big = h('div.big');
  const pill = h('span.pill');
  const meta = h('span');
  const fv = () => h('span.field-value');
  const vQty = fv(), vVal = fv(), vCost = fv(), vGain = fv(), vShare = fv();
  vVal.classList.add('strong');
  const nameEl = h('div.detail-name'), symEl = h('div.detail-sym');
  const chartHost = avail === 'yes' ? h('div', { 'data-nodrag': '' }) : null;
  const seg = segmented(Object.keys(H.RANGES).map(k => [k, k]), range, k => { range = k; load(); });
  const approx = h('p.hint', { hidden: true });
  const needKey = avail === 'needs-key' && h('div.notice', null,
    h('span', { text: 'El gráfico necesita tu llave de Twelve Data' }),
    h('button', { type: 'button', text: 'Añadir', onclick: () => openSettings() }));
  const statsGroup = h('div.group', { hidden: true });
  const fieldRow = (label, value) => h('div.field', null, h('span.field-label', { text: label }), value);

  function paint() {
    const a = getHolding(id);
    if (!a) return;
    const q = P.quoteOf(a), r = P.rate(ccy());
    const v = valuation();
    const row = v.rows.find(x => x.a.id === id);
    nameEl.textContent = a.name;
    symEl.textContent = a.kind === 'metal' ? `${a.sym} · por oz troy` : a.kind === 'custom' ? 'Valor manual' : a.kind === 'cash' ? a.sym : `${a.sym} · ${KINDS[a.kind].label}`;

    if (scrub) {
      big.textContent = F.price(scrub.v * r, ccy());
      setPill(pill, scrub.v / scrub.first - 1, null, null);
      pill.hidden = false;
      meta.textContent = F.timeLabel(scrub.t, range);
    } else {
      big.textContent = q ? F.price(q.p * r, ccy()) : '—';
      const first = chart && chart.first;
      const ratio = q && first ? q.p / first - 1 : row && row.dayPct;
      pill.hidden = ratio == null;
      if (ratio != null) setPill(pill, ratio, null, null);
      meta.textContent = ratio == null ? (q ? '' : 'Sin precio en vivo') : first ? RANGE_LABEL[range] : 'hoy';
    }

    vQty.textContent = a.kind === 'custom' ? '—' : qtyLabel(a);
    vVal.textContent = row && row.value != null ? F.money(row.value, ccy()) : '—';
    const perUnit = a.kind === 'metal' && UNITS[a.unit] ? UNITS[a.unit].perOz : 1;
    vCost.textContent = a.cost != null ? F.price((a.cost * r) / (a.kind === 'custom' ? 1 : perUnit), ccy()) : '—';
    if (row && row.gainAbs != null) {
      vGain.textContent = `${F.signedMoney(row.gainAbs, ccy())}  ${F.pct(row.gainPct)}`;
      vGain.className = 'field-value ' + (row.gainAbs > 0 ? 'up' : row.gainAbs < 0 ? 'down' : '');
    } else { vGain.textContent = '—'; vGain.className = 'field-value'; }
    vShare.textContent = row && row.value != null && v.total > 0 ? F.share(row.value / v.total) : '—';
    if (chart && range === '1D' && q && !scrub) chart.tick(q.p);
  }

  async function load() {
    if (!chart) return;
    const my = ++loadSeq;
    const a = getHolding(id) || a0;
    chart.setData(null);
    const got = await H.load(a, range);
    if (my !== loadSeq || !chart) return;
    if (!got) {
      // No history for this asset after all: drop the chart rather than show an empty box.
      if (range === '1D') { chart.destroy(); chart = null; chartHost.hidden = true; seg.el.hidden = true; }
      paint();
      return;
    }
    chart.setData(H.windowed(a, got.pts, range));
    approx.hidden = !got.approx;
    if (got.approx) approx.textContent = `Histórico aproximado a partir ${H.proxyOf(a)}.`;
    paint();
  }

  async function stats() {
    const a = getHolding(id) || a0;
    if (a.kind === 'cash' || a.kind === 'custom') return;
    const q = P.quoteOf(a);
    const rows = await loadStats(a, { price: q && q.p, rate: P.rate(ccy()), ccy: ccy(), finnhubKey: state.settings.finnhubKey, historyKey: state.settings.historyKey });
    if (!rows.length) return;
    statsGroup.replaceChildren(...rows.map(x => fieldRow(x.label, h('span.field-value', { text: x.value }))));
    statsGroup.hidden = false;
  }

  const view = makeView({
    body: [
      h('div.detail-top', null, logo(a0), h('div', null, nameEl, symEl)),
      h('div.detail-price', null, big, h('div.detail-meta', null, pill, meta)),
      chartHost, chartHost && seg.el, approx, needKey,
      h('div.group', null,
        a0.kind !== 'custom' && fieldRow('Cantidad', vQty), fieldRow('Valor', vVal),
        a0.kind !== 'cash' && fieldRow(a0.kind === 'custom' ? 'Costo' : 'Costo promedio', vCost),
        a0.kind !== 'cash' && fieldRow('Ganancia', vGain), fieldRow('Peso', vShare)),
      statsGroup,
      h('div.detail-actions', null,
        h('button.btn-secondary', { type: 'button', text: 'Editar', onclick: () => pushEdit() }),
        h('button.btn-text.danger', { type: 'button', text: 'Eliminar', onclick: () => { sheet.close(); setTimeout(() => deleteHolding(id), 280); } })),
    ],
  });

  function pushEdit() {
    const a = getHolding(id);
    if (!a) return;
    const v = amountView(sheet, a, { edit: true });
    sheet.push(v);
    v.focus();
  }

  if (chartHost) chart = createChart(chartHost, { onScrub: s => { scrub = s; paint(); } });
  const offP = P.onPrices(paint), offS = subscribe(paint);
  view.onRemove = () => { offP(); offS(); if (chart) { chart.destroy(); chart = null; } };
  view.onShow = paint;
  sheet = openSheet(view);
  paint();
  load();
  stats();
  if (edit) pushEdit();
}

// ============================================================================
// Settings
// ============================================================================

function fieldButton(label, { value, onclick, danger, chevron } = {}) {
  return h('button.field' + (danger ? '.danger' : ''), { type: 'button', onclick },
    h('span.field-label', { text: label }),
    h('span.field-value', null, value || ''),
    chevron && h('span.chev', { html: ICONS.chevron }));
}

/** A text field for an API key that is checked before it is saved. */
function keyField({ id, placeholder, value, initial, test, save }) {
  let timer = 0, seq = 0;
  const input = h('input.field-input.left', { id, type: 'text', placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value, 'aria-label': placeholder });
  const mark = h('span.field-suffix');
  const show = s => {
    mark.className = s === 'ok' ? 'check' : 'field-suffix';
    mark.innerHTML = s === 'ok' ? ICONS.check : s === 'busy' ? '<span class="spinner spin" style="display:block;width:18px;height:18px"></span>' : '';
    if (s === 'invalid') mark.textContent = 'No válida';
    if (s === 'network') mark.textContent = 'Sin conexión';
    mark.style.color = s === 'invalid' ? 'var(--down)' : '';
  };
  if (value) show(initial || 'ok');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const key = input.value.trim();
    const my = ++seq;
    if (!key) { show(''); save(''); return; }
    show('busy');
    timer = setTimeout(async () => {
      const res = await test(key);
      if (my !== seq) return;
      show(res);
      if (res === 'ok') { haptic(10); save(key); }
    }, 600);
  });
  return h('label.field', null, input, mark);
}

function currencyView(sheet) {
  const items = CASH.map(c => h('button.field', {
    type: 'button',
    onclick: () => { haptic(6); setSetting('ccy', c.sym); sheet.pop(); },
  }, logo(c), h('span.field-label', { text: c.name }), h('span.field-value', { text: c.sym }),
  c.sym === ccy() && h('span.check', { html: ICONS.check })));
  return makeView({ title: 'Moneda', body: [h('div.group', null, items)] });
}

function applyCopy(data) {
  replaceAll(data);
  replaceSnapshots(data.snapshots || []);
}

/**
 * Restore a copy by its code. Copies are not listed: everyone who opens the app
 * reaches the same server, so the code is what keeps a copy private.
 */
function restoreView(sheet) {
  let timer = 0, seq = 0, found = null;
  const input = h('input.field-input.left', { id: 'restore-code', type: 'text', placeholder: 'Código de copia', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Código de copia' });
  const mark = h('span.field-suffix');
  const btn = h('button.btn-primary', { type: 'button', text: 'Restaurar', disabled: true });
  const note = h('p.hint', { text: 'Está en Ajustes → Copia automática del dispositivo original. Restaurar reemplaza las posiciones de este.' });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    found = null; btn.disabled = true; mark.textContent = '';
    const my = ++seq;
    if (input.value.replace(/[^a-z0-9]/gi, '').length < 6) return;
    timer = setTimeout(async () => {
      const d = await fetchBackup(input.value);
      if (my !== seq) return;
      found = d && d.count ? d : null;
      mark.style.color = found ? '' : 'var(--down)';
      mark.textContent = found ? `${d.count} ${d.count === 1 ? 'activo' : 'activos'} · ${F.ago(Date.parse(d.updated))}` : 'No existe';
      btn.disabled = !found;
    }, 450);
  });
  btn.addEventListener('click', () => {
    if (!found) return;
    applyCopy(found.data);
    haptic(10);
    sheet.close();
    toast('Copia restaurada');
  });
  const view = makeView({ title: 'Restaurar copia', body: [h('div.group', null, h('label.field', null, input, mark)), note], foot: btn });
  view.onShow = () => { try { input.focus({ preventScroll: true }); } catch { /* not focusable yet */ } };
  return view;
}

function openSettings() {
  let sheet = null, wipeArmed = 0;
  const ccyValue = h('span', { text: ccy() });
  const hide = toggle(state.settings.hidden, on => setSetting('hidden', on), 'Ocultar importes');

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, id: 'set-import' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.holdings)) throw new Error('shape');
      applyCopy(data);
      sheet.close();
      toast('Portfolio importado');
    } catch { toast('Ese archivo no es una copia de Portfolio'); }
    fileInput.value = '';
  });

  const doExport = () => {
    const url = URL.createObjectURL(new Blob([exportData({ snapshots: snapshots() })], { type: 'application/json' }));
    const link = h('a', { href: url, download: `portfolio-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const wipe = h('button.field.danger', { type: 'button' }, h('span.field-label', { text: 'Borrar todo' }));
  wipe.addEventListener('click', () => {
    if (Date.now() - wipeArmed < 3500) { replaceAll({ holdings: [] }); replaceSnapshots([]); sheet.close(); toast('Portfolio borrado'); return; }
    wipeArmed = Date.now();
    wipe.firstChild.textContent = 'Toca otra vez para borrar';
    setTimeout(() => { wipe.firstChild.textContent = 'Borrar todo'; }, 3500);
  });

  // Copies on the serving machine: only shown where that server exists.
  const copyValue = h('span');
  const codeValue = h('span', { text: copyCode() });
  const copyTitle = h('div.group-title', { text: 'Copia automática' });
  const copyGroup = h('div.group', null,
    h('div.field', null, h('span.field-label', { text: 'Última copia' }), h('span.field-value', null, copyValue)),
    fieldButton('Código de esta copia', {
      value: codeValue,
      onclick: async () => {
        try { await navigator.clipboard.writeText(copyCode()); toast('Código copiado'); } catch { toast('Anótalo: ' + copyCode()); }
      },
    }),
    fieldButton('Restaurar una copia', { chevron: true, onclick: () => sheet.push(restoreView(sheet)) }));
  const codeHint = h('p.hint', { text: 'Guarda el código: es lo único que permite recuperar esta copia en otro dispositivo. Nadie más ve tus copias.' });
  const paintCopy = () => {
    const b = backupStatus();
    copyTitle.hidden = copyGroup.hidden = codeHint.hidden = !b.enabled;
    copyValue.textContent = isDemo() ? 'En pausa (ejemplo)' : b.lastPush ? F.ago(b.lastPush) : 'Pendiente';
  };
  paintCopy();
  const offCopy = onBackup(paintCopy);

  const view = makeView({
    title: 'Ajustes',
    body: [
      h('div.group', null,
        fieldButton('Moneda', { value: ccyValue, chevron: true, onclick: () => sheet.push(currencyView(sheet)) }),
        h('div.field', null, h('span.field-label', { text: 'Ocultar importes' }), h('span.field-value'), hide.el)),
      h('div.group-title', { text: 'Acciones en vivo' }),
      h('div.group', null, keyField({
        id: 'set-key', placeholder: 'Llave de Finnhub', value: state.settings.finnhubKey,
        initial: P.stockState() === 'invalid' ? 'invalid' : 'ok',
        test: P.testFinnhubKey, save: key => setSetting('finnhubKey', key),
      })),
      h('p.hint', { html: 'Llave gratuita en <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a>. Da precio en tiempo real de acciones y ETFs de EE. UU.' }),
      h('div.group-title', { text: 'Gráficos de acciones' }),
      h('div.group', null, keyField({
        id: 'set-history-key', placeholder: 'Llave de Twelve Data', value: state.settings.historyKey,
        test: H.testHistoryKey, save: key => setSetting('historyKey', key),
      })),
      h('p.hint', { html: 'Llave gratuita en <a href="https://twelvedata.com/pricing" target="_blank" rel="noopener">twelvedata.com</a>. Da el histórico de acciones y ETFs, y el aproximado de plata, platino y paladio. Crypto y oro no la necesitan.' }),
      copyTitle, copyGroup, codeHint,
      h('div.group-title', { text: 'Datos' }),
      h('div.group', null, fieldButton('Exportar copia', { onclick: doExport }), fieldButton('Importar copia', { onclick: () => fileInput.click() }), wipe),
      fileInput,
      h('p.hint', { text: 'Tus posiciones se guardan en este dispositivo. Precios de Coinbase, CoinGecko, gold-api.com, Finnhub, Twelve Data y open.er-api.com.' }),
      h('p.hint.version', { text: `Versión ${APP_VERSION}` }),
    ],
  });
  view.onShow = () => { ccyValue.textContent = ccy(); hide.set(state.settings.hidden); };
  view.onRemove = offCopy;
  sheet = openSheet(view);
}

// ============================================================================
// Example data
// ============================================================================

function demoHoldings() {
  const c = id => CRYPTO.find(a => a.cg === id);
  const s = sym => STOCKS.find(a => a.sym === sym);
  const m = code => CASH.find(a => a.sym === code);
  return [
    { ...c('bitcoin'), qty: 0.42, cost: 52000 },
    { ...c('ethereum'), qty: 3.5, cost: 2900 },
    { ...c('solana'), qty: 40, cost: 95 },
    { ...METALS[0], qty: 2, cost: 2650, unit: 'oz' },
    { ...METALS[1], qty: 60, cost: 31, unit: 'oz' },
    { ...s('AAPL'), qty: 25, cost: 182 },
    { ...s('NVDA'), qty: 30, cost: 96 },
    { ...s('VOO'), qty: 12, cost: 455 },
    { ...m('USD'), qty: 4200, cost: null },
    { ...m('EUR'), qty: 1500, cost: null },
  ].filter(x => x.id);
}

// ============================================================================
// Boot
// ============================================================================

function sync() {
  P.setFinnhubKey(state.settings.finnhubKey);
  H.setHistoryKey(state.settings.historyKey);
  const held = new Set(state.holdings.map(a => a.id));
  P.track([...state.holdings, ...[BTC, XAU].filter(a => !held.has(a.id))]);
  rangeSeg.set(state.settings.range);
}

$('btn-settings').innerHTML = ICONS.gear;
$('btn-add').innerHTML = ICONS.plus;
$('btn-settings').addEventListener('click', () => openSettings());
$('btn-add').addEventListener('click', () => openAdd());
$('empty-add').addEventListener('click', () => openAdd());
$('empty-demo').addEventListener('click', () => { haptic(8); enterDemo(demoHoldings()); });
$('empty-restore').addEventListener('click', () => { const s = openSheet(restoreView({ close: () => s.close() })); });
$('demo-exit').addEventListener('click', () => exitDemo());
$('btn-targets').addEventListener('click', () => openTargets(valuation));
$('chart-note').addEventListener('click', () => { if ($('chart-note').dataset.action) openSettings(); });
$('change').addEventListener('click', () => {
  if (!$('change').dataset.toggle) return;
  pillMode = pillMode === 'total' ? 'range' : 'total';
  haptic(5);
  scheduleRender(true);
});
$('empty-logos').append(logo(CRYPTO[0]), logo(METALS[0]), logo(STOCKS[0]), logo(CASH[0]));

// Balance: a tap changes the unit (currency → bitcoin → gold), a long press hides it.
{
  const bal = $('balance');
  let hold = 0, held = false;
  bal.addEventListener('pointerdown', () => {
    held = false;
    clearTimeout(hold);
    hold = setTimeout(() => { held = true; haptic(14); setSetting('hidden', !state.settings.hidden); }, 480);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) bal.addEventListener(ev, () => clearTimeout(hold));
  bal.addEventListener('contextmenu', e => e.preventDefault());
  bal.addEventListener('click', () => {
    if (held) { held = false; return; }
    haptic(6);
    if (state.settings.hidden) { setSetting('hidden', false); return; }
    const i = UNIT_CYCLE.indexOf(state.settings.unit);
    setSetting('unit', UNIT_CYCLE[(i + 1) % UNIT_CYCLE.length]);
  });
}

// Compact bar + pull to refresh (iOS reports a negative scrollTop while bouncing).
const scroller = $('scroll'), nav = $('nav'), ptr = $('ptr');
let refreshing = false;
scroller.addEventListener('scroll', () => {
  const y = scroller.scrollTop;
  const p = clamp((y - 92) / 34, 0, 1);
  nav.style.opacity = p;
  $('nav-title').style.transform = `translateY(${(1 - p) * 6}px)`;
  closeOpenRow();
  if (!refreshing) {
    ptr.style.opacity = y < 0 ? clamp(-y / 64, 0, 1) : 0;
    ptr.firstElementChild.style.transform = y < 0 ? `rotate(${-y * 4}deg)` : '';
  }
}, { passive: true });
scroller.addEventListener('touchend', async () => {
  if (refreshing || scroller.scrollTop > -64) return;
  refreshing = true;
  haptic(10);
  ptr.classList.add('spin');
  ptr.style.opacity = 1;
  await Promise.all([P.refresh(), new Promise(res => setTimeout(res, 700))]);
  ptr.classList.remove('spin');
  ptr.style.opacity = 0;
  refreshing = false;
}, { passive: true });

// iOS only applies :active styles when a touch listener exists.
document.addEventListener('touchstart', () => {}, { passive: true });

P.setPrevProvider(a => H.ref24(a));
subscribe(() => { sync(); scheduleRender(true); scheduleBackup(); });
P.onPrices(() => scheduleRender(false));
H.onHistory(() => scheduleRender(false));

if (location.hash === '#demo' && !state.holdings.length) enterDemo(demoHoldings());
sync();
P.start();
renderHome();

// Copies on the serving machine, where that exists. An empty app is offered a restore.
initBackup({
  getDoc: () => exportObject({ snapshots: snapshots() }),
  canPush: () => !isDemo() && state.holdings.length > 0,
}).then(on => {
  $('empty-restore').hidden = !on;
});

startUpdates();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* the app works without it */ });
}
