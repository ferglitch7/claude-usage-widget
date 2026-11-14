// Physics and gesture primitives: springs that carry the finger's velocity,
// rubber-banding at the edges, and one pan recognizer for touch and mouse.

const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)');
export const reduceMotion = () => !!(reduced && reduced.matches);

/**
 * Animate a number with a damped spring. velocity is in units per millisecond
 * (what tracker().get() returns), so a flick continues at the speed it had.
 */
export function spring({ from, to, velocity = 0, stiffness = 320, damping = 34, onUpdate, onRest }) {
  if (reduceMotion() || from === to && velocity === 0) {
    onUpdate(to);
    onRest && onRest();
    return { stop() {} };
  }
  let x = from, v = velocity * 1000, raf = 0, last = performance.now(), done = false;
  const frame = now => {
    if (done) return;
    const dt = Math.min(0.034, Math.max(0.001, (now - last) / 1000));
    last = now;
    const steps = Math.ceil(dt / 0.004), h = dt / steps;
    for (let i = 0; i < steps; i++) {
      v += (-stiffness * (x - to) - damping * v) * h;
      x += v * h;
    }
    if (Math.abs(x - to) < 0.3 && Math.abs(v) < 12) {
      done = true;
      onUpdate(to);
      onRest && onRest();
      return;
    }
    onUpdate(x);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return { stop() { done = true; cancelAnimationFrame(raf); } };
}

/** Tween 0→1 with an ease-out curve; used where a spring makes no sense (morphs). */
export function tween(ms, onUpdate, onDone) {
  if (reduceMotion()) { onUpdate(1); onDone && onDone(); return { stop() {} }; }
  let raf = 0, done = false;
  const t0 = performance.now();
  const frame = now => {
    if (done) return;
    const k = Math.min(1, Math.max(0, (now - t0) / ms)); // a frame can be stamped before t0
    onUpdate(1 - Math.pow(1 - k, 3));
    if (k < 1) raf = requestAnimationFrame(frame); else { done = true; onDone && onDone(); }
  };
  raf = requestAnimationFrame(frame);
  return { stop() { done = true; cancelAnimationFrame(raf); } };
}

/** Recent velocity of a dragged value, in units per millisecond. */
export function tracker() {
  const pts = [];
  return {
    add(v) {
      const t = performance.now();
      pts.push([t, v]);
      while (pts.length > 2 && t - pts[0][0] > 100) pts.shift();
    },
    get() {
      if (pts.length < 2) return 0;
      const a = pts[0], b = pts[pts.length - 1];
      return b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0;
    },
  };
}

/** iOS-style resistance past an edge: the further you pull, the less it moves. */
export function rubber(distance, dimension) {
  const d = Math.abs(distance);
  return Math.sign(distance) * (1 - 1 / (d * 0.55 / dimension + 1)) * dimension;
}

/**
 * One-axis pan recognizer. It waits until the movement clearly follows `axis`
 * before taking over, so vertical scrolling and horizontal swipes coexist.
 */
export function pan(el, { axis, canStart, shouldBegin, onStart, onMove, onEnd, slop = 8 }) {
  let active = false, began = false, sx = 0, sy = 0, vt = null, endedAt = 0;

  const start = (x, y, ev) => {
    if (canStart && !canStart(ev)) return false;
    active = true; began = false; sx = x; sy = y;
    return true;
  };
  const move = (x, y, ev) => {
    if (!active) return;
    const dx = x - sx, dy = y - sy;
    if (!began) {
      if (Math.abs(dx) < slop && Math.abs(dy) < slop) return;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      if ((axis === 'x') !== horizontal || (shouldBegin && !shouldBegin(dx, dy))) { active = false; return; }
      began = true; vt = tracker();
      sx = x; sy = y; // measure from here so the element does not jump by the slop
      onStart && onStart();
    }
    if (ev.cancelable) ev.preventDefault();
    const d = axis === 'x' ? x - sx : y - sy;
    vt.add(d);
    onMove(d);
  };
  const end = () => {
    if (!active) return;
    active = false;
    if (began) { endedAt = performance.now(); onEnd(vt.get()); }
  };

  el.addEventListener('touchstart', e => { if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY, e); }, { passive: true });
  el.addEventListener('touchmove', e => move(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);

  el.addEventListener('mousedown', e => {
    if (e.button !== 0 || !start(e.clientX, e.clientY, e)) return;
    const mm = ev => move(ev.clientX, ev.clientY, ev);
    const mu = () => { removeEventListener('mousemove', mm); removeEventListener('mouseup', mu); end(); };
    addEventListener('mousemove', mm);
    addEventListener('mouseup', mu);
  });

  // A drag must not also count as a tap on whatever was under the pointer.
  el.addEventListener('click', e => {
    if (performance.now() - endedAt < 80) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

/** A light tap where the platform supports it (Android; iOS ignores it). */
export function haptic(ms = 8) {
  try { navigator.vibrate && navigator.vibrate(ms); } catch { /* not allowed */ }
}

/** Build an element: h('div.row', { onclick }, child, 'text'). */
export function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.9-1.5-1.9-3.3-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14.1 2.700h-3.800L9.900 5.100a7.6 7.6 0 0 0-2.600 1.500l-2.300-.900-1.900 3.300 1.900 1.500a7.600 7.600 0 0 0 0 3l-1.900 1.500 1.900 3.300 2.300-.900a7.600 7.600 0 0 0 2.600 1.500l.400 2.400h3.800l.400-2.400a7.600 7.600 0 0 0 2.600-1.500l2.300.900 1.900-3.300z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.500 4.500"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.500 7h15M9.500 7V4.800h5V7M6.500 7l.800 12.200h9.400L17.500 7M10 10.500v5.500M14 10.500v5.500"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.500 19.500l.900-4.200L15.800 4.900a1.900 1.900 0 0 1 2.700 0l.600.600a1.900 1.900 0 0 1 0 2.700L8.700 18.600z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.500l4.500 4.500L19 7.500"/></svg>',
  up: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 2.200l4.300 6.800H1.700z"/></svg>',
  down: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 9.800L1.700 3h8.600z"/></svg>',
};
