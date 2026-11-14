// Automatic copies on the machine that serves the app.
//
// When the app is served together with server/backup_server.py (mounted at
// ./api), every device keeps its own copy there and any device can restore
// one. On a plain static host the probe fails and all of this stays off.
//
// A copy holds positions, preferences and the recorded balance history. API
// keys are never included.

const DEVICE_KEY = 'portfolio.device';
const LAST_KEY = 'portfolio.backup.t';

let enabled = false;
let getDoc = null, canPush = null;
let timer = 0, lastSig = '', lastPush = 0;
const listeners = new Set();

try { lastPush = Number(localStorage.getItem(LAST_KEY)) || 0; } catch { /* no storage */ }

function deviceLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Navegador';
}

/** A stable id for this browser's copy. A reinstall gets a new one. */
export function device() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE_KEY));
    if (saved && /^[a-z0-9]{6,40}$/.test(saved.id)) return saved;
  } catch { /* create one */ }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const d = { id: Array.from(bytes, b => (b % 36).toString(36)).join(''), label: deviceLabel() };
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(d)); } catch { /* not persisted */ }
  return d;
}

async function api(path, options) {
  const r = await fetch('api/' + path, { cache: 'no-store', ...options });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

export function onBackup(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function backupStatus() { return { enabled, lastPush }; }

/**
 * getDoc(): the object to store.  canPush(): false while there is nothing
 * worth copying (empty portfolio, example mode), so a wipe never overwrites
 * a good copy.
 */
export async function initBackup(options) {
  getDoc = options.getDoc;
  canPush = options.canPush;
  try {
    const d = await api('health');
    enabled = !!d && d.app === 'portfolio-backup';
  } catch { enabled = false; }
  listeners.forEach(fn => fn());
  if (enabled) scheduleBackup(1500);
  return enabled;
}

export async function pushBackup() {
  if (!enabled || !getDoc || !canPush()) return false;
  const doc = getDoc();
  // Skip the upload when nothing a restore would bring back has changed.
  const sig = JSON.stringify([doc.holdings, doc.settings, (doc.snapshots || []).length]);
  if (sig === lastSig) return true;
  try {
    const d = device();
    await api('backups/' + d.id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: d.label, data: doc }) });
    lastSig = sig;
    lastPush = Date.now();
    try { localStorage.setItem(LAST_KEY, String(lastPush)); } catch { /* not persisted */ }
    listeners.forEach(fn => fn());
    return true;
  } catch { return false; }
}

export function scheduleBackup(ms = 2500) {
  if (!enabled) return;
  clearTimeout(timer);
  timer = setTimeout(pushBackup, ms);
}

/** [{ id, label, updated, count }] newest first; empty when unavailable. */
export async function listBackups() {
  if (!enabled) return [];
  try {
    const list = await api('backups');
    return Array.isArray(list) ? list.sort((a, b) => String(b.updated).localeCompare(String(a.updated))) : [];
  } catch { return []; }
}

/** The stored document of one copy, or null. */
export async function fetchBackup(id) {
  try {
    const d = await api('backups/' + encodeURIComponent(id));
    return d && d.data && Array.isArray(d.data.holdings) ? d.data : null;
  } catch { return null; }
}
