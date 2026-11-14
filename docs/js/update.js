// Keeps the installed app current. On iPhone a home-screen app is resumed from
// memory instead of reloaded, so it never sees new files on its own. This
// compares the running version with version.json on the server whenever the
// app comes back to the foreground (and every 30 minutes), and reloads when
// they differ, but never in the middle of something: not while a sheet is open.

export const APP_VERSION = '2026.11.14-1';

const GUARD = 'portfolio.reloaded';
let checking = false, pending = false;

function busy() {
  return !!document.querySelector('#sheets .sheet-layer');
}

async function latest() {
  try {
    const r = await fetch('version.json', { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.version === 'string' ? d.version : null;
  } catch { return null; }
}

async function apply(version) {
  // At most one reload per version, so a stale cache can never loop.
  try {
    if (sessionStorage.getItem(GUARD) === version) return;
    sessionStorage.setItem(GUARD, version);
  } catch { /* no storage: still reload once */ }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.update();
  } catch { /* the reload still fetches fresh files */ }
  location.reload();
}

export async function checkForUpdate() {
  if (checking || document.hidden) return;
  checking = true;
  try {
    const v = await latest();
    if (!v || v === APP_VERSION) { pending = false; return; }
    if (busy()) { pending = true; return; }
    await apply(v);
  } finally { checking = false; }
}

export function startUpdates() {
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, 30 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  addEventListener('pageshow', e => { if (e.persisted) checkForUpdate(); });
  // A deferred update applies as soon as the last sheet closes.
  new MutationObserver(() => { if (pending && !busy()) checkForUpdate(); })
    .observe(document.getElementById('sheets'), { childList: true });
}
