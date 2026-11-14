// Price chart: a line with a soft area fill that draws itself in, morphs when
// the range changes and can be scrubbed with a finger, as in Apple Stocks.

import { tween, haptic } from './motion.js';

const NS = 'http://www.w3.org/2000/svg';
const N = 150; // every series is resampled to N points so shapes can morph
let uid = 0;

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function resample(pts) {
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const out = new Array(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    const t = t0 + (t1 - t0) * (i / (N - 1));
    while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
    const a = pts[j], b = pts[j + 1];
    const k = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
    out[i] = { t, v: a[1] + (b[1] - a[1]) * k };
  }
  return out;
}

/**
 * onScrub(point | null) is called while a finger moves over the chart.
 * deferred: wait for a sideways move or a short hold before scrubbing, so a
 * chart inside a scrolling page does not flicker when the page is scrolled.
 */
export function createChart(host, { onScrub, deferred = false } = {}) {
  const id = `chart-${++uid}`;
  host.classList.add('chart');
  const svg = svgEl('svg', { class: 'chart-svg', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  svg.innerHTML = `
    <defs>
      <linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--chart)" stop-opacity="0.26"/>
        <stop offset="1" stop-color="var(--chart)" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="${id}-clip"><rect x="0" y="-10" width="0" height="10"/></clipPath>
    </defs>
    <line class="chart-base" x1="0" x2="0" y1="0" y2="0"/>
    <g clip-path="url(#${id}-clip)">
      <path class="chart-area" fill="url(#${id}-fill)"/>
      <path class="chart-line" fill="none"/>
    </g>
    <circle class="chart-halo" r="9" cx="-20" cy="-20"/>
    <circle class="chart-end" r="3.500" cx="-20" cy="-20"/>
    <g class="chart-scrub">
      <line class="chart-cursor" y1="0" y2="0" x1="0" x2="0"/>
      <circle class="chart-dot" r="5.500"/>
    </g>`;
  host.append(svg);
  const q = sel => svg.querySelector(sel);
  const clip = q('clipPath rect'), area = q('.chart-area'), line = q('.chart-line'), base = q('.chart-base');
  const halo = q('.chart-halo'), endDot = q('.chart-end'), cursor = q('.chart-cursor'), dot = q('.chart-dot');

  let W = 0, H = 0;
  let data = null;        // resampled points of the current series
  let shape = null;       // normalized heights (0..1) currently on screen
  let reveal = 0;         // 0..1 how much of the line has been drawn in
  let anim = null, revealAnim = null, scrubbing = false, morphing = false, lastIdx = -1;
  const PAD_T = 14, PAD_B = 18, PAD_R = 16; // room on the right for the live dot

  const yOf = n => PAD_T + (1 - n) * (H - PAD_T - PAD_B);
  const xOf = i => (i / (N - 1)) * (W - PAD_R);

  function normalize(series) {
    let lo = Infinity, hi = -Infinity;
    for (const p of series) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
    const span = hi - lo || Math.abs(hi) * 0.01 || 1;
    return series.map(p => (p.v - lo) / span);
  }

  function paint() {
    if (!shape || !W) return;
    let d = '';
    for (let i = 0; i < N; i++) d += (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(shape[i]).toFixed(1);
    line.setAttribute('d', d);
    area.setAttribute('d', `${d}L${xOf(N - 1).toFixed(1)} ${H}L0 ${H}Z`);
    const y0 = yOf(shape[0]);
    base.setAttribute('x2', W); base.setAttribute('y1', y0); base.setAttribute('y2', y0);
    clip.setAttribute('width', (W + 12) * reveal);
    clip.setAttribute('height', H + 20);
    const ex = xOf(N - 1), ey = yOf(shape[N - 1]);
    const show = reveal >= 1 && !scrubbing;
    for (const c of [halo, endDot]) { c.setAttribute('cx', show ? ex : -20); c.setAttribute('cy', show ? ey : -20); }
  }

  function measure() {
    const r = host.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    paint();
  }
  const ro = new ResizeObserver(measure);
  ro.observe(host);

  function scrubAt(clientX) {
    if (!data) return;
    const r = host.getBoundingClientRect();
    const i = Math.max(0, Math.min(N - 1, Math.round(((clientX - r.left) / (r.width - PAD_R)) * (N - 1))));
    const x = xOf(i), y = yOf(shape[i]);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.setAttribute('y1', 0); cursor.setAttribute('y2', H);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    if (i !== lastIdx) {
      lastIdx = i;
      onScrub && onScrub({ t: data[i].t, v: data[i].v, first: data[0].v });
    }
  }
  function endScrub() {
    if (!scrubbing) return;
    scrubbing = false; lastIdx = -1;
    host.classList.remove('scrubbing');
    paint();
    onScrub && onScrub(null);
  }
  let armed = null, holdTimer = 0; // a touch that has not become a scrub yet
  function beginScrub(e) {
    armed = null;
    clearTimeout(holdTimer);
    scrubbing = true;
    host.classList.add('scrubbing');
    try { host.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    haptic(6);
    paint();
    scrubAt(e.clientX);
  }
  function release() {
    armed = null;
    clearTimeout(holdTimer);
    endScrub();
  }
  host.addEventListener('pointerdown', e => {
    if (!data || reveal < 1) return;
    if (!deferred || e.pointerType === 'mouse') { beginScrub(e); return; }
    armed = { x: e.clientX, y: e.clientY, e };
    holdTimer = setTimeout(() => { if (armed) beginScrub(armed.e); }, 220);
  });
  host.addEventListener('pointermove', e => {
    if (scrubbing) { scrubAt(e.clientX); return; }
    if (armed && Math.abs(e.clientX - armed.x) > 6 && Math.abs(e.clientX - armed.x) > Math.abs(e.clientY - armed.y)) beginScrub(e);
  });
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', release);
  // Taking capture moves it away from the child under the finger, and that
  // child's "lost capture" bubbles up here; only the host losing it ends the scrub.
  host.addEventListener('lostpointercapture', e => { if (e.target === host) endScrub(); });

  return {
    /** pts: [[timestampMs, value], …] ascending, or null while loading. */
    setData(pts) {
      host.classList.toggle('loading', !pts);
      if (!pts) return;
      const next = resample(pts);
      const target = normalize(next);
      const up = next[N - 1].v >= next[0].v;
      host.classList.toggle('down', !up);
      data = next;
      if (!W) measure();
      if (anim) anim.stop();
      if (!shape) {
        shape = target;
        if (revealAnim) revealAnim.stop();
        revealAnim = tween(900, k => { reveal = k; paint(); });
      } else {
        const from = shape.slice();
        morphing = true;
        anim = tween(520, k => {
          shape = from.map((v, i) => v + (target[i] - v) * k);
          paint();
        }, () => { morphing = false; });
      }
    },
    /** Move the last point with the live price so the chart never lags the header. */
    tick(v) {
      if (!data || scrubbing || morphing) return;
      data[N - 1].v = v;
      shape = normalize(data);
      host.classList.toggle('down', v < data[0].v);
      paint();
    },
    get first() { return data ? data[0].v : null; },
    destroy() { ro.disconnect(); if (anim) anim.stop(); if (revealAnim) revealAnim.stop(); svg.remove(); },
  };
}
