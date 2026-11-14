// Target allocation: the split by asset class the user wants to hold, how far
// the portfolio is from it, and how much to move to get back.

import { state, setSetting } from './store.js';
import * as F from './format.js';
import { KINDS } from './catalog.js';
import { h, haptic, ICONS } from './motion.js';
import { openSheet, makeView } from './sheet.js';

export const KIND_ORDER = ['crypto', 'stock', 'metal', 'cash', 'custom'];

const sumOf = t => KIND_ORDER.reduce((n, k) => n + (Number(t[k]) || 0), 0);

/** The saved targets if they are usable (they add up to 100), else null. */
export function targets() {
  const t = state.settings.targets;
  return t && Math.abs(sumOf(t) - 100) < 0.01 ? t : null;
}

/**
 * Per class: value, actual share, target share, drift (share − target) and
 * move (money to buy if positive, sell if negative, to land on the target).
 */
export function plan(kinds, total, t) {
  return KIND_ORDER.map(kind => {
    const value = (kinds.find(k => k[0] === kind) || [kind, 0])[1];
    const share = total > 0 ? value / total : 0;
    const target = t ? (Number(t[kind]) || 0) / 100 : null;
    return { kind, value, share, target, drift: target == null ? null : share - target, move: target == null ? null : target * total - value };
  });
}

/** Today's split rounded to steps of 5 that still add up to 100. */
export function suggest(kinds, total) {
  const out = {};
  KIND_ORDER.forEach(k => { out[k] = 0; });
  if (!(total > 0)) return out;
  for (const [kind, value] of kinds) out[kind] = Math.round((value / total) * 20) * 5;
  const biggest = KIND_ORDER.reduce((a, b) => (out[b] > out[a] ? b : a));
  out[biggest] = Math.max(0, out[biggest] + 100 - sumOf(out));
  return out;
}

export function openTargets(getValuation) {
  const v0 = getValuation();
  const saved = targets();
  const vals = saved ? Object.fromEntries(KIND_ORDER.map(k => [k, Number(saved[k]) || 0])) : suggest(v0.kinds, v0.total);
  const ccy = state.settings.ccy;
  let sheet = null;

  const inputs = {};
  const status = h('div.target-status');
  const moves = h('div.group');
  const movesTitle = h('div.group-title', { text: 'Para llegar al objetivo' });
  const save = h('button.btn-primary', { type: 'button', text: 'Guardar' });

  const rows = KIND_ORDER.map(kind => {
    const input = h('input.stepper-input', { id: `target-${kind}`, type: 'text', inputmode: 'numeric', autocomplete: 'off', value: String(vals[kind]), 'aria-label': `Objetivo de ${KINDS[kind].label}` });
    inputs[kind] = input;
    const set = n => { vals[kind] = Math.min(100, Math.max(0, Math.round(n))); input.value = String(vals[kind]); refresh(); };
    input.addEventListener('input', () => { const n = parseInt(input.value.replace(/\D/g, ''), 10); vals[kind] = Number.isFinite(n) ? Math.min(100, n) : 0; refresh(); });
    input.addEventListener('blur', () => { input.value = String(vals[kind]); });
    const step = d => () => { haptic(5); set(d > 0 ? Math.floor(vals[kind] / 5) * 5 + 5 : Math.ceil(vals[kind] / 5) * 5 - 5); };
    const now = h('span.target-now');
    const row = h('div.field.target-row', null,
      h('i.dot', { style: { background: KINDS[kind].color } }),
      h('span.field-label', { text: KINDS[kind].label }),
      now,
      h('div.stepper', null,
        h('button', { type: 'button', 'aria-label': 'Menos', text: '−', onclick: step(-1) }),
        input, h('span.stepper-pct', { text: '%' }),
        h('button', { type: 'button', 'aria-label': 'Más', text: '+', onclick: step(1) })));
    row.now = now;
    row.kind = kind;
    return row;
  });

  function refresh() {
    const v = getValuation();
    const total = sumOf(vals);
    const okSum = Math.abs(total - 100) < 0.01;
    const p = plan(v.kinds, v.total, okSum ? vals : null);
    rows.forEach((row, i) => { row.now.textContent = v.total > 0 ? `ahora ${F.share(p[i].share)}` : ''; });

    status.className = 'target-status ' + (okSum ? 'ok' : 'off');
    const text = h('span', { text: okSum ? 'Suma 100 %' : total < 100 ? `Suma ${total} % · faltan ${100 - total}` : `Suma ${total} % · sobran ${total - 100}` });
    status.replaceChildren(...(okSum ? [h('span.check', { html: ICONS.check }), text] : [text]));
    save.disabled = !okSum;

    const list = okSum && v.total > 0 ? p.filter(x => Math.abs(x.move) >= v.total * 0.005) : [];
    moves.replaceChildren(...list.map(x => h('div.field', null,
      h('i.dot', { style: { background: KINDS[x.kind].color } }),
      h('span.field-label', { text: KINDS[x.kind].label }),
      h('span.field-value.strong', { text: `${x.move > 0 ? 'Comprar' : 'Vender'} ${F.money(Math.abs(x.move), ccy)}` }))));
    moves.hidden = movesTitle.hidden = list.length === 0;
  }

  save.addEventListener('click', () => { haptic(10); setSetting('targets', { ...vals }); sheet.close(); });
  const clear = saved && h('button.btn-text.danger', { type: 'button', text: 'Quitar objetivo', onclick: () => { setSetting('targets', null); sheet.close(); } });

  const view = makeView({
    title: 'Distribución objetivo',
    body: [h('div.group', null, rows), status, movesTitle, moves],
    foot: [save, clear],
  });
  refresh();
  sheet = openSheet(view);
}
