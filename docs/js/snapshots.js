// A sparse record of the real balance over time, kept in this browser. It is
// what the "Real" chart range draws: actual recorded values, not a simulation.
//
// Resolution fades with age so the list stays small for years:
//   last 2 days   one point per 30 minutes
//   last 30 days  one point per 6 hours
//   older         one point per day

const KEY = 'portfolio.snaps.v1';
const MIN_GAP = 30 * 60e3;
const DAY = 86400e3;

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(raw) ? clean(raw) : [];
  } catch { return []; }
}

function clean(list) {
  return list
    .filter(s => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] >= 0)
    .map(s => [s[0], s[1]])
    .sort((x, y) => x[0] - y[0]);
}

let snaps = read();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(snaps)); } catch { /* storage unavailable */ }
}

/** Keep the newest point of each time bucket; bucket size grows with age. */
export function thin(list, now) {
  const out = [];
  let lastBucket = null;
  for (const s of list) {
    const age = now - s[0];
    const size = age <= 2 * DAY ? MIN_GAP : age <= 30 * DAY ? 6 * 3600e3 : DAY;
    const bucket = size + ':' + Math.floor(s[0] / size);
    if (bucket === lastBucket) out[out.length - 1] = s; else out.push(s);
    lastBucket = bucket;
  }
  return out;
}

export function snapshots() { return snaps; }

/** Record the balance (USD) if the last record is old enough. True if stored. */
export function recordSnapshot(usd, now = Date.now()) {
  if (!Number.isFinite(usd) || usd <= 0) return false;
  const last = snaps[snaps.length - 1];
  if (last && now - last[0] < MIN_GAP) return false;
  snaps.push([now, Math.round(usd * 100) / 100]);
  snaps = thin(snaps, now);
  save();
  return true;
}

/** Replace the whole record (import, restore from a backup, wipe). */
export function replaceSnapshots(list) {
  snaps = Array.isArray(list) ? thin(clean(list), Date.now()) : [];
  save();
}
