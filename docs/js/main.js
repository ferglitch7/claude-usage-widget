// Screens and wiring: home (balance, allocation, list), add, detail, settings.

import {
  state, subscribe, addHolding, updateHolding, removeHolding, restoreHolding,
  setSetting, replaceAll, exportData, getHolding, enterDemo, exitDemo, isDemo,
} from './store.js';
import * as P from './prices.js';
import * as F from './format.js';
import { KINDS, UNITS, METALS, CRYPTO, STOCKS, CASH, searchLocal, searchRemote, newCustomAsset } from './catalog.js';
import { h, spring, pan, rubber, haptic, ICONS, reduceMotion } from './motion.js';
import { logo } from './logo.js';
import { createChart } from './chart.js';
import { openSheet, makeView, toast } from './sheet.js';

const $ = id => document.getElementById(id);
const ccy = () => state.settings.ccy;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// ============================================================================
// Valuation
// ============================================================================

function valuation() {
  const r = P.rate(ccy());
  let total = 0, day = 0, hasDay = false, cost = 0, costValue = 0;
  const rows = state.holdings.map(a => {
    const q = P.quoteOf(a);
    const value = q ? q.p * a.qty * r : null;
    const dayAbs = q && q.prev ? (q.p - q.prev) * a.qty * r : null;
    const dayPct = q && q.prev ? q.p / q.prev - 1 : null;
    const gainAbs = q && a.cost != null ? (q.p - a.cost) * a.qty * r : null;
    const gainPct = q && a.cost ? q.p / a.cost - 1 : null;
    if (value != null) total += value;
    if (dayAbs != null) { day += dayAbs; hasDay = true; }
    if (gainAbs != null) { cost += a.cost * a.qty * r; costValue += value; }
    return { a, q, value, dayAbs, dayPct, gainAbs, gainPct };
  });
  rows.sort((x, y) => (y.value ?? -1) - (x.value ?? -1));
  const kinds = new Map();
  for (const row of rows) if (row.value) kinds.set(row.a.kind, (kinds.get(row.a.kind) || 0) + row.value);
  return {
    rows, total,
    day: hasDay && total - day > 0 ? { abs: day, pct: day / (total - day) } : null,
    gain: cost > 0 ? { abs: costValue - cost, pct: costValue / cost - 1 } : null,
    kinds: [...kinds].sort((x, y) => y[1] - x[1]),
  };
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
// Rolling number (the balance)
// ============================================================================

class Roller {
  constructor(el) { this.el = el; this.slots = []; }

  /** parts come from Intl formatToParts; dir > 0 rolls digits upwards. */
  set(parts, dir = 0) {
    const chars = [];
    let seenInt = false;
    for (const p of parts) {
      let cls = '';
      if (p.type === 'fraction' || p.type === 'decimal') cls = 'minor';
      else if (p.type === 'currency' || p.type === 'literal') cls = seenInt ? 'sym after' : 'sym';
      if (p.type === 'integer') seenInt = true;
      for (const ch of p.value) chars.push({ ch: ch === ' ' ? ' ' : ch, cls });
    }
    const animate = this.slots.length > 0 && dir !== 0 && !reduceMotion();
    const n = chars.length, next = [];
    // Slots are matched from the right so digits keep their place value.
    for (let i = 0; i < n; i++) {
      const c = chars[n - 1 - i];
      let slot = this.slots[i];
      if (!slot) {
        slot = { el: h('span.slot'), cur: null, ch: null, cls: null };
        this.el.prepend(slot.el);
      }
      this.fill(slot, c, dir, animate);
      next.push(slot);
    }
    for (let i = n; i < this.slots.length; i++) this.slots[i].el.remove();
    this.slots = next;
  }

  fill(slot, c, dir, animate) {
    if (slot.ch === c.ch && slot.cls === c.cls) return;
    slot.el.className = 'slot ' + c.cls;
    const fresh = h('span', { text: c.ch });
    const old = slot.cur;
    slot.el.append(fresh);
    if (old) {
      if (animate && /\d/.test(c.ch)) {
        const off = dir > 0 ? 1 : -1, opt = { duration: 460, easing: EASE };
        old.classList.add('out');
        old.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${-off * 80}%)`, opacity: 0 }], opt).onfinish = () => old.remove();
        fresh.animate([{ transform: `translateY(${off * 80}%)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], opt);
      } else old.remove();
    }
    slot.cur = fresh; slot.ch = c.ch; slot.cls = c.cls;
  }
}

// ============================================================================
// Small controls
// ============================================================================

function segmented(options, value, onChange) {
  const thumb = h('span.seg-thumb');
  const el = h('div.seg', { role: 'group' }, thumb);
  thumb.style.width = `calc((100% - 4px) / ${options.length})`;
  let cur = value;
  const btns = options.map(([v, label]) => h('button', {
    type: 'button', text: label,
    onclick: () => { if (cur === v) return; set(v); haptic(5); onChange(v); },
  }));
  el.append(...btns);
  function set(v) {
    cur = v;
    const i = options.findIndex(o => o[0] === v);
    thumb.style.transform = `translateX(${i * 100}%)`;
    btns.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  }
  set(value);
  return { el, set };
}

function setPill(el, ratio, abs, label) {
  const up = ratio > 0.00005, down = ratio < -0.00005;
  el.className = 'pill ' + (up ? 'up' : down ? 'down' : '');
  el.innerHTML = (up ? ICONS.up : down ? ICONS.down : '');
  if (abs != null) el.append(h('span', { text: F.money(Math.abs(abs), ccy()) }));
  el.append(h('span', { text: F.pct(ratio, { sign: false }) }));
  if (label) el.append(h('span.dim', { text: label }));
}

// ============================================================================
// Home
// ============================================================================

const roller = new Roller($('roller'));
const rowMap = new Map();   // holding id -> row refs
const segMap = new Map();   // kind -> allocation segment
const chipMap = new Map();  // kind -> legend chip
let filter = null;          // show only one class when set
let pillMode = 'day';       // 'day' | 'total'
let lastTotal = null;
let openRow = null;
let firstPaint = true;
const ACT = 148;            // width of the two swipe actions

function renderHome() {
  const v = valuation();
  const has = state.holdings.length > 0;
  const hidden = state.settings.hidden;

  // --- balance
  const parts = hidden ? [{ type: 'integer', value: '•••••' }] : F.moneyParts(has ? v.total : 0, ccy());
  const len = parts.reduce((n, p) => n + p.value.length, 0);
  $('balance').dataset.size = len <= 9 ? 'l' : len <= 11 ? 'm' : len <= 13 ? 's' : 'xs';
  roller.set(parts, lastTotal == null || hidden ? 0 : Math.sign(v.total - lastTotal));
  lastTotal = v.total;
  $('nav-title').textContent = hidden ? 'Portfolio' : F.money(v.total, ccy());
  $('hero').hidden = !has;

  // --- change pill
  const pill = $('change');
  if (pillMode === 'total' && !v.gain) pillMode = 'day';
  const m = pillMode === 'total' ? v.gain : v.day;
  pill.hidden = !has || !m;
  if (m) setPill(pill, m.pct, hidden ? null : m.abs, pillMode === 'total' ? 'total' : 'hoy');
  pill.dataset.toggle = v.gain && v.day ? '1' : '';

  renderAlloc(v);
  renderNotice();
  renderList(v);

  $('empty').hidden = has;
  $('demo-bar').hidden = !isDemo();
  $('list').classList.toggle('masked', hidden);
  const st = P.status();
  $('live').classList.toggle('on', st === 'live');
  $('live').title = { live: 'En vivo', stale: 'Reconectando', loading: 'Conectando', offline: 'Sin conexión' }[st];
  firstPaint = false;
}

function renderAlloc(v) {
  const bar = $('alloc-bar'), legend = $('alloc-legend');
  $('alloc').hidden = v.kinds.length === 0;
  if (filter && !v.kinds.some(k => k[0] === filter)) filter = null;
  const live = new Set();
  v.kinds.forEach(([kind, value], i) => {
    live.add(kind);
    const share = value / v.total;
    let seg = segMap.get(kind);
    if (!seg) {
      seg = h('div.alloc-seg', { style: { background: KINDS[kind].color } });
      bar.append(seg);
      segMap.set(kind, seg);
    }
    seg.style.order = i;
    seg.style.flex = `${Math.max(share, 0.004)} 1 0px`;
    seg.classList.toggle('on', filter === kind);

    let chip = chipMap.get(kind);
    if (!chip) {
      chip = h('button.chip', { type: 'button', onclick: () => { filter = filter === kind ? null : kind; haptic(5); renderHome(); } },
        h('i', { style: { background: KINDS[kind].color } }), h('span', { text: KINDS[kind].label }), h('b'));
      legend.append(chip);
      chipMap.set(kind, chip);
    }
    chip.style.order = i;
    chip.lastChild.textContent = F.share(share);
    chip.classList.toggle('on', filter === kind);
    chip.setAttribute('aria-pressed', String(filter === kind));
  });
  for (const [kind, seg] of segMap) if (!live.has(kind)) { seg.remove(); segMap.delete(kind); chipMap.get(kind).remove(); chipMap.delete(kind); }
  bar.classList.toggle('filtered', !!filter);
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
  const main = h('div.row-main', { role: 'button', tabIndex: 0 },
    logo(a), h('div.row-mid', null, name, sub), h('div.row-end', null, val, chg));
  const edit = h('button.act.edit', { type: 'button', tabIndex: -1, 'aria-label': 'Editar', html: ICONS.pencil });
  const del = h('button.act.del', { type: 'button', tabIndex: -1, 'aria-label': 'Eliminar', html: ICONS.trash });
  const el = h('div.row', null, h('div.row-actions', null, edit, del), main);
  const row = { id: a.id, el, main, name, sub, val, chg, x: 0, base: 0, w: 0, full: false, anim: null, value: null };

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
  for (const r of rows) {
    const a = r.a;
    let row = rowMap.get(a.id);
    const isNew = !row;
    if (isNew) { row = createRow(a); rowMap.set(a.id, row); }
    row.name.textContent = a.name;
    row.sub.textContent = qtyLabel(a);
    row.val.textContent = r.value != null ? F.money(r.value, ccy()) : '—';
    row.value = r.value;

    // Second line on the right: change (today or vs cost), else the unit price.
    const ratio = pillMode === 'total' ? r.gainPct : r.dayPct;
    if (ratio != null) {
      row.chg.textContent = F.pct(ratio);
      row.chg.className = 'row-chg ' + (ratio > 0.00005 ? 'up' : ratio < -0.00005 ? 'down' : '');
    } else {
      row.chg.className = 'row-chg';
      if (a.kind === 'custom' || (a.kind === 'cash' && a.sym === ccy())) row.chg.textContent = '';
      else row.chg.textContent = r.q ? F.price(r.q.p * P.rate(ccy()), ccy()) : a.kind === 'stock' ? 'Sin precio' : 'Cargando';
    }
    order.push({ row, isNew });
  }

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

const meter = document.createElement('canvas').getContext('2d');
const RANGE_LABEL = { '1D': '24 h', '1S': '7 días', '1M': '30 días', '1A': '1 año' };

function openDetail(id, { edit = false } = {}) {
  const a0 = getHolding(id);
  if (!a0) return;
  let range = '1D', chart = null, scrub = null, loadSeq = 0, sheet = null;

  const big = h('div.big');
  const pill = h('span.pill');
  const meta = h('span');
  const fv = () => h('span.field-value');
  const vQty = fv(), vVal = fv(), vCost = fv(), vGain = fv(), vShare = fv();
  vVal.classList.add('strong');
  const nameEl = h('div.detail-name'), symEl = h('div.detail-sym');
  const chartHost = P.hasHistory(a0) ? h('div', { 'data-nodrag': '' }) : null;
  const seg = segmented(Object.keys(P.RANGES).map(k => [k, k]), range, k => { range = k; load(); });

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
    chart.setData(null);
    const pts = await P.history(getHolding(id) || a0, range);
    if (my !== loadSeq) return;
    if (!pts) {
      // No history for this asset after all: drop the chart rather than show an empty box.
      if (range === '1D') { chart.destroy(); chart = null; chartHost.hidden = true; seg.el.hidden = true; }
      paint();
      return;
    }
    chart.setData(pts);
    paint();
  }

  const row = (label, value) => h('div.field', null, h('span.field-label', { text: label }), value);
  const view = makeView({
    body: [
      h('div.detail-top', null, logo(a0), h('div', null, nameEl, symEl)),
      h('div.detail-price', null, big, h('div.detail-meta', null, pill, meta)),
      chartHost, chartHost && seg.el,
      h('div.group', null,
        a0.kind !== 'custom' && row('Cantidad', vQty), row('Valor', vVal),
        a0.kind !== 'cash' && row(a0.kind === 'custom' ? 'Costo' : 'Costo promedio', vCost),
        a0.kind !== 'cash' && row('Ganancia', vGain), row('Peso', vShare)),
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
  view.onRemove = () => { offP(); offS(); if (chart) chart.destroy(); };
  view.onShow = paint;
  sheet = openSheet(view);
  paint();
  load();
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

function currencyView(sheet) {
  const items = CASH.map(c => h('button.field', {
    type: 'button',
    onclick: () => { haptic(6); setSetting('ccy', c.sym); sheet.pop(); },
  }, logo(c), h('span.field-label', { text: c.name }), h('span.field-value', { text: c.sym }),
  c.sym === ccy() && h('span.check', { html: ICONS.check })));
  return makeView({ title: 'Moneda', body: [h('div.group', null, items)] });
}

function openSettings() {
  let sheet = null, keyTimer = 0, keySeq = 0, wipeArmed = 0;
  const ccyValue = h('span', { text: ccy() });
  const keyInput = h('input.field-input.left', {
    id: 'set-key', type: 'text', placeholder: 'Llave de Finnhub', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: 'false', value: state.settings.finnhubKey, 'aria-label': 'Llave de Finnhub',
  });
  const keyState = h('span.field-suffix');
  const setKeyState = s => {
    keyState.className = s === 'ok' ? 'check' : 'field-suffix';
    keyState.innerHTML = s === 'ok' ? ICONS.check : s === 'busy' ? '<span class="spinner spin" style="display:block;width:18px;height:18px"></span>' : '';
    if (s === 'invalid') keyState.textContent = 'No válida';
    if (s === 'network') keyState.textContent = 'Sin conexión';
    keyState.style.color = s === 'invalid' ? 'var(--down)' : '';
  };
  if (state.settings.finnhubKey) setKeyState(P.stockState() === 'invalid' ? 'invalid' : 'ok');

  keyInput.addEventListener('input', () => {
    clearTimeout(keyTimer);
    const key = keyInput.value.trim();
    const my = ++keySeq;
    if (!key) { setKeyState(''); setSetting('finnhubKey', ''); return; }
    setKeyState('busy');
    keyTimer = setTimeout(async () => {
      const res = await P.testFinnhubKey(key);
      if (my !== keySeq) return;
      setKeyState(res);
      if (res === 'ok') { haptic(10); setSetting('finnhubKey', key); }
    }, 600);
  });

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, id: 'set-import' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.holdings)) throw new Error('shape');
      replaceAll(data);
      sheet.close();
      toast('Portfolio importado');
    } catch { toast('Ese archivo no es una copia de Portfolio'); }
    fileInput.value = '';
  });

  const doExport = () => {
    const url = URL.createObjectURL(new Blob([exportData()], { type: 'application/json' }));
    const link = h('a', { href: url, download: `portfolio-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const wipe = h('button.field.danger', { type: 'button' }, h('span.field-label', { text: 'Borrar todo' }));
  wipe.addEventListener('click', () => {
    if (Date.now() - wipeArmed < 3500) { replaceAll({ holdings: [] }); sheet.close(); toast('Portfolio borrado'); return; }
    wipeArmed = Date.now();
    wipe.firstChild.textContent = 'Toca otra vez para borrar';
    setTimeout(() => { wipe.firstChild.textContent = 'Borrar todo'; }, 3500);
  });

  const view = makeView({
    title: 'Ajustes',
    body: [
      h('div.group', null, fieldButton('Moneda', { value: ccyValue, chevron: true, onclick: () => sheet.push(currencyView(sheet)) })),
      h('div.group-title', { text: 'Acciones en vivo' }),
      h('div.group', null, h('label.field', null, keyInput, keyState)),
      h('p.hint', { html: 'Llave gratuita en <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a>. Da precio en tiempo real de acciones y ETFs de EE. UU.' }),
      h('div.group-title', { text: 'Datos' }),
      h('div.group', null, fieldButton('Exportar copia', { onclick: doExport }), fieldButton('Importar copia', { onclick: () => fileInput.click() }), wipe),
      fileInput,
      h('p.hint', { text: 'Tus posiciones se guardan solo en este dispositivo. Precios de Coinbase, CoinGecko, gold-api.com, Finnhub y open.er-api.com.' }),
    ],
  });
  view.onShow = () => { ccyValue.textContent = ccy(); };
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
  P.track(state.holdings);
}

$('btn-settings').innerHTML = ICONS.gear;
$('btn-add').innerHTML = ICONS.plus;
$('btn-settings').addEventListener('click', () => openSettings());
$('btn-add').addEventListener('click', () => openAdd());
$('empty-add').addEventListener('click', () => openAdd());
$('empty-demo').addEventListener('click', () => { haptic(8); enterDemo(demoHoldings()); });
$('demo-exit').addEventListener('click', () => exitDemo());
$('balance').addEventListener('click', () => { haptic(6); setSetting('hidden', !state.settings.hidden); });
$('change').addEventListener('click', () => {
  if (!$('change').dataset.toggle) return;
  pillMode = pillMode === 'day' ? 'total' : 'day';
  haptic(5);
  scheduleRender(true);
});
$('empty-logos').append(logo(CRYPTO[0]), logo(METALS[0]), logo(STOCKS[0]), logo(CASH[0]));

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

subscribe(() => { sync(); scheduleRender(true); });
P.onPrices(() => scheduleRender(false));

if (location.hash === '#demo' && !state.holdings.length) enterDemo(demoHoldings());
sync();
P.start();
renderHome();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* the app works without it */ });
}
