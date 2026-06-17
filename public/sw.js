/* Meridian service worker — network-first so the installed PWA always picks up the
   latest deploy (no delete-and-reinstall). API calls are never intercepted, so
   live quotes stay live; static shell falls back to cache only when offline. */
const CACHE = 'meridian-shell-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/logo.svg', '/manifest.json'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // fonts / CDNs: default handling
  if (url.pathname.startsWith('/api/')) return;        // dynamic API: always live, never cached
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') { const idx = await caches.match('/index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
