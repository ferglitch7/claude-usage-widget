// Small shared controls: the rolling number, segmented control, change pill,
// switch and sparkline.

import { state } from './store.js';
import * as F from './format.js';
import { h, haptic, ICONS, reduceMotion } from './motion.js';

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** A number whose digits roll when the value changes (the balance). */
export class Roller {
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

export function segmented(options, value, onChange) {
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
    const i = options.findIndex(o => o[0] === v);
    if (i < 0) return;
    cur = v;
    thumb.style.transform = `translateX(${i * 100}%)`;
    btns.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  }
  set(value);
  return { el, set };
}

/** Arrow + optional amount + percentage + optional dim label. */
export function setPill(el, ratio, abs, label) {
  const up = ratio > 0.00005, down = ratio < -0.00005;
  el.className = 'pill ' + (up ? 'up' : down ? 'down' : '');
  el.innerHTML = (up ? ICONS.up : down ? ICONS.down : '');
  if (abs != null) el.append(h('span', { text: F.money(Math.abs(abs), state.settings.ccy) }));
  el.append(h('span', { text: F.pct(ratio, { sign: false }) }));
  if (label) el.append(h('span.dim', { text: label }));
}

/** An iOS-style on/off switch. */
export function toggle(on, onChange, label) {
  const el = h('button.switch', { type: 'button', role: 'switch', 'aria-label': label });
  const set = v => { on = !!v; el.setAttribute('aria-checked', String(on)); };
  el.addEventListener('click', () => { set(!on); haptic(6); onChange(on); });
  set(on);
  return { el, set };
}

const SPARK_W = 56, SPARK_H = 24, SPARK_N = 28;

export function sparkEl() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path fill="none"/>';
  return svg;
}

/** Draw the last `span` ms of a series as a tiny trend line. */
export function drawSpark(svg, pts, span) {
  const end = pts[pts.length - 1][0], start = end - span;
  const win = pts.filter(p => p[0] >= start);
  if (win.length < 2) { svg.classList.remove('on'); return; }
  const t0 = win[0][0], t1 = win[win.length - 1][0];
  let lo = Infinity, hi = -Infinity;
  const ys = [];
  let j = 0;
  for (let i = 0; i < SPARK_N; i++) {
    const t = t0 + ((t1 - t0) * i) / (SPARK_N - 1);
    while (j < win.length - 2 && win[j + 1][0] < t) j++;
    const a = win[j], b = win[j + 1];
    const k = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
    const v = a[1] + (b[1] - a[1]) * k;
    ys.push(v);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo || 1, pad = 2.5;
  let d = '';
  ys.forEach((v, i) => {
    const x = (i / (SPARK_N - 1)) * SPARK_W;
    const y = pad + (1 - (v - lo) / range) * (SPARK_H - 2 * pad);
    d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  });
  svg.firstChild.setAttribute('d', d);
  svg.classList.add('on');
  svg.classList.toggle('down', ys[ys.length - 1] < ys[0]);
}
