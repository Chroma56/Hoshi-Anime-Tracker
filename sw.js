/*
 * Hoshi service worker.
 *
 * Its only job is to let the installed app open when you are offline or the site is briefly
 * unreachable. It keeps one copy of the page itself and the icons.
 *
 * The page is always fetched from the network first, so an update you upload shows up on the
 * next launch; the saved copy is used only when the network fails. Nothing else is touched:
 * API calls, images and video all go straight to the network as before.
 */
const CACHE = 'hoshi-shell-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .catch(() => {})            // a failed pre-cache must not block installing
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k.startsWith('hoshi-shell-')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  // Only the page itself (opening or reloading the app), and only on this site.
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('./', copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match('./').then(saved => saved || Response.error()))
  );
});
