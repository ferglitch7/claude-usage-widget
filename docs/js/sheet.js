// Bottom sheet with iOS behaviour: springs in, follows the finger, dismisses
// on a downward flick, and holds a small navigation stack (push / pop / edge
// swipe back). One sheet is open at a time.

import { h, spring, pan, rubber, haptic, ICONS } from './motion.js';

let current = null;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const narrow = () => matchMedia('(max-width: 640px)').matches;

/** A screen inside a sheet: header (back, title, close), scroll body, footer. */
export function makeView({ title = '', body = [], foot = null, cls = '' } = {}) {
  const back = h('button.icon-btn.back', { type: 'button', 'aria-label': 'Atrás', html: ICONS.back });
  const close = h('button.icon-btn.close', { type: 'button', 'aria-label': 'Cerrar', html: ICONS.close });
  const titleEl = h('div.sheet-title', { text: title });
  const head = h('header.sheet-head', null, back, titleEl, close);
  const scroll = h('div.sheet-scroll', null, body);
  const el = h('section.sheet-view' + (cls ? '.' + cls : ''), null, head, scroll, foot && h('footer.sheet-foot', null, foot));
  scroll.addEventListener('scroll', () => head.classList.toggle('scrolled', scroll.scrollTop > 2), { passive: true });
  return { el, scroll, back, close, titleEl, onShow: null, onRemove: null };
}

export function openSheet(root, { onClose } = {}) {
  if (current) current.close({ instant: true });

  const layer = document.getElementById('sheets');
  const page = document.getElementById('page');
  const backdrop = h('div.sheet-backdrop');
  const stack = h('div.sheet-stack');
  const panel = h('div.sheet', { role: 'dialog', 'aria-modal': 'true' }, h('div.sheet-grabber'), stack);
  const wrap = h('div.sheet-layer', null, backdrop, panel);
  layer.append(wrap);
  page.inert = true;

  const views = [];
  let y = 0, H = 0, anim = null, navAnim = null, closed = false, startTarget = null;

  function apply(v) {
    y = v;
    panel.style.transform = `translate3d(0,${v}px,0)`;
    const p = clamp(1 - v / H, 0, 1);
    backdrop.style.opacity = p;
    // The page steps back behind the sheet, like a modal card on iPhone.
    if (narrow()) {
      page.style.transform = p > 0.001 ? `translate3d(0,${p * 10}px,0) scale(${1 - 0.07 * p})` : '';
      page.style.borderRadius = p > 0.001 ? `${p * 26}px` : '';
    }
  }

  function settle(to, velocity, done) {
    if (anim) anim.stop();
    anim = spring({ from: y, to, velocity, stiffness: 290, damping: 31, onUpdate: apply, onRest: done });
  }

  function close({ velocity = 0, instant = false } = {}) {
    if (closed) return;
    closed = true;
    if (current === api) current = null;
    removeEventListener('keydown', onKey);
    if (document.activeElement && panel.contains(document.activeElement)) document.activeElement.blur();
    const finish = () => {
      views.splice(0).forEach(v => v.onRemove && v.onRemove());
      wrap.remove();
      if (!current) { page.inert = false; page.style.transform = ''; page.style.borderRadius = ''; }
      onClose && onClose();
    };
    if (instant) { if (anim) anim.stop(); finish(); return; }
    wrap.classList.add('closing');
    settle(H, velocity, finish);
  }

  // ----- navigation stack ---------------------------------------------------

  function setNav(top, prev, p) {
    const W = stack.clientWidth;
    top.el.style.transform = `translate3d(${p * W}px,0,0)`;
    prev.el.style.transform = `translate3d(${-(1 - p) * 0.28 * W}px,0,0)`;
    prev.el.style.opacity = p; // views are see-through, so the one underneath fades out completely
  }
  function rest(v) { v.el.style.transform = ''; v.el.style.opacity = ''; }

  function wire(v) {
    v.back.hidden = views.length <= 1;
    v.back.onclick = () => pop();
    v.close.onclick = () => close();
  }

  function push(v) {
    const prev = views[views.length - 1];
    views.push(v);
    stack.append(v.el);
    wire(v);
    if (!prev) { v.onShow && v.onShow(); return; }
    if (navAnim) navAnim.stop();
    setNav(v, prev, 1);
    navAnim = spring({
      from: 1, to: 0, stiffness: 300, damping: 32,
      onUpdate: p => setNav(v, prev, p),
      onRest: () => { prev.el.hidden = true; rest(v); rest(prev); v.onShow && v.onShow(); },
    });
  }

  function pop({ from = 0, velocity = 0 } = {}) {
    if (views.length < 2) { close(); return; }
    const top = views.pop(), prev = views[views.length - 1];
    prev.el.hidden = false;
    if (document.activeElement && top.el.contains(document.activeElement)) document.activeElement.blur();
    if (navAnim) navAnim.stop();
    navAnim = spring({
      from, to: 1, velocity, stiffness: 300, damping: 32,
      onUpdate: p => setNav(top, prev, p),
      onRest: () => { top.el.remove(); top.onRemove && top.onRemove(); rest(prev); prev.onShow && prev.onShow(); },
    });
  }

  // Swipe from the left edge to go back.
  let navP = 0;
  pan(stack, {
    axis: 'x',
    canStart: ev => {
      if (views.length < 2) return false;
      const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
      return x - stack.getBoundingClientRect().left < 36;
    },
    shouldBegin: dx => dx > 0,
    onStart: () => { if (navAnim) navAnim.stop(); views[views.length - 2].el.hidden = false; },
    onMove: d => {
      navP = clamp(d / stack.clientWidth, 0, 1);
      setNav(views[views.length - 1], views[views.length - 2], navP);
    },
    onEnd: v => {
      const W = stack.clientWidth;
      if (navP > 0.35 || v > 0.45) { pop({ from: navP, velocity: v / W }); return; }
      const top = views[views.length - 1], prev = views[views.length - 2];
      navAnim = spring({
        from: navP, to: 0, velocity: v / W, stiffness: 300, damping: 32,
        onUpdate: p => setNav(top, prev, p),
        onRest: () => { prev.el.hidden = true; rest(top); rest(prev); },
      });
    },
  });

  // ----- drag to dismiss ----------------------------------------------------

  pan(panel, {
    axis: 'y',
    canStart: ev => { startTarget = ev.target; return !closed && !ev.target.closest('[data-nodrag]'); },
    shouldBegin: (dx, dy) => {
      if (dy < 0) return false;
      const sc = startTarget.closest && startTarget.closest('.sheet-scroll');
      return !sc || sc.scrollTop <= 0;
    },
    onStart: () => {
      if (anim) anim.stop();
      if (document.activeElement && panel.contains(document.activeElement)) document.activeElement.blur();
    },
    onMove: d => apply(d < 0 ? rubber(d, H) * 0.3 : d),
    onEnd: v => {
      if (y > H * 0.3 || v > 0.6) { haptic(); close({ velocity: v }); } else settle(0, v);
    },
  });

  backdrop.addEventListener('click', () => close());
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); views.length > 1 ? pop() : close(); } };
  addEventListener('keydown', onKey);

  const api = { push, pop, close, panel, get depth() { return views.length; } };
  current = api;

  push(root);
  H = panel.offsetHeight;
  apply(H);
  settle(0, 0);
  return api;
}

export function closeSheet() { if (current) current.close(); }

// Keep sheets above the on-screen keyboard. The layer fills the screen and only
// gives up the part the keyboard covers: in a home-screen app iOS reports a
// visual viewport shorter than the screen even with no keyboard, so its height
// cannot be used directly.
if (typeof visualViewport !== 'undefined' && visualViewport) {
  const fit = () => {
    const layer = document.getElementById('sheets');
    const app = document.getElementById('app');
    if (!layer || !app) return;
    const full = app.getBoundingClientRect().height;
    const covered = full - (visualViewport.offsetTop + visualViewport.height);
    layer.style.bottom = covered > 120 ? covered + 'px' : '0px';
  };
  visualViewport.addEventListener('resize', fit);
  visualViewport.addEventListener('scroll', fit);
}

// ----- toast -----------------------------------------------------------------

let toastTimer = 0, toastEl = null;

/** A short message at the bottom, optionally with one action (e.g. undo). */
export function toast(message, { action, duration = 4200 } = {}) {
  const host = document.getElementById('toasts');
  if (toastEl) { toastEl.remove(); toastEl = null; }
  clearTimeout(toastTimer);
  const el = h('div.toast', { role: 'status' }, h('span.toast-msg', { text: message }),
    action && h('button.toast-action', { type: 'button', text: action.label, onclick: () => { dismiss(); action.run(); } }));
  host.append(el);
  toastEl = el;
  let a = spring({ from: 80, to: 0, stiffness: 340, damping: 28, onUpdate: v => { el.style.transform = `translate3d(0,${v}px,0)`; el.style.opacity = clamp(1 - v / 80, 0, 1); } });
  function dismiss() {
    clearTimeout(toastTimer);
    if (toastEl !== el) return;
    toastEl = null;
    a.stop();
    a = spring({ from: 0, to: 80, stiffness: 340, damping: 34, onUpdate: v => { el.style.transform = `translate3d(0,${v}px,0)`; el.style.opacity = clamp(1 - v / 80, 0, 1); }, onRest: () => el.remove() });
  }
  toastTimer = setTimeout(dismiss, duration);
}
