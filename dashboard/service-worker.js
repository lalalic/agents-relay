// Only public, non-sensitive, version-independent app-shell assets are cached.
// Never intercept /api/*, /events, /dashboard-config.js or navigations.
const CACHE = 'agents-relay-pwa-shell-v4-' + new URL(self.registration.scope).pathname.replace(/\W/g, '-');
// JavaScript and CSS are release-specific and must not be cached by a Service Worker.
const ASSETS = ['pwa.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'].map(path => new URL(path, self.registration.scope).pathname);
const ALLOWED = new Set(ASSETS);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('agents-relay-pwa-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !ALLOWED.has(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) || Response.error()));
});
