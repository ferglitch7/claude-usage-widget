// Offline shell: the app's own files are cached so it opens without a
// connection (showing the last known prices). Price and logo requests to other
// hosts are never touched.
const CACHE = 'portfolio-v3';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/main.js', 'js/store.js', 'js/prices.js', 'js/format.js', 'js/catalog.js', 'js/catalog-data.js',
  'js/motion.js', 'js/logo.js', 'js/chart.js', 'js/sheet.js', 'js/ui.js', 'js/history.js', 'js/series.js',
  'js/snapshots.js', 'js/targets.js', 'js/stats.js', 'js/backup.js', 'js/update.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first so updates show up at once; the cache is only the fallback.
// Every request revalidates with the server: without that, the browser's own
// HTTP cache can keep serving yesterday's files to the installed app.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/version.json')) return; // always live
  const fresh = e.request.mode === 'navigate'
    ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    fresh.then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
