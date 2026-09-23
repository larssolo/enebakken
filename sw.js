// Offline support: keeps the page and the checklist usable with no or a weak
// connection. Only public, non-personal responses are cached; everything
// else (sign-in, photos, anything behind a login) goes straight to the
// network untouched.
const VERSION = 'v1';
const SHELL_CACHE = 'eb-shell-' + VERSION;
const DATA_CACHE = 'eb-data-' + VERSION;
const FONT_CACHE = 'eb-fonts-' + VERSION;
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(['/', '/logo.webp', '/favicon.png']);
    const data = await caches.open(DATA_CACHE);
    await data.add('/api/checklist').catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const current = [SHELL_CACHE, DATA_CACHE, FONT_CACHE];
    for (const key of await caches.keys()) {
      if (!current.includes(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Navigations are stored under '/' alone: the query string can carry an
  // invite or password-reset token, which must never become a cache key.
  if (request.mode === 'navigate' && sameOrigin && (url.pathname === '/' || url.pathname === '/Enebakken.html')) {
    event.respondWith(networkFirst(event, SHELL_CACHE, '/'));
  } else if (sameOrigin && url.pathname === '/api/checklist' && url.search === '') {
    event.respondWith(networkFirst(event, DATA_CACHE, '/api/checklist'));
  } else if (sameOrigin && (url.pathname === '/logo.webp' || url.pathname === '/favicon.png')) {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, url.pathname));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(event, FONT_CACHE, request));
  }
});

// A weak signal gets NETWORK_TIMEOUT_MS before the cached copy is shown;
// the network answer, when it does arrive, still refreshes the cache.
async function networkFirst(event, cacheName, key) {
  const cache = await caches.open(cacheName);
  const network = fetch(event.request).then(async (response) => {
    if (response.ok && !response.redirected) await cache.put(key, response.clone()).catch(() => {});
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_TIMEOUT_MS); });
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch (e) {
    // offline: fall through to the cache
  } finally {
    clearTimeout(timer);
  }
  const cached = await cache.match(key);
  return cached ? markOffline(cached) : network;
}

async function staleWhileRevalidate(event, cacheName, key) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key);
  const network = fetch(event.request).then(async (response) => {
    if (response.ok || response.type === 'opaque') await cache.put(key, response.clone()).catch(() => {});
    return response;
  });
  event.waitUntil(network.catch(() => {}));
  return cached || network;
}

// Lets the page tell it's showing saved data rather than live data.
function markOffline(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Eb-Offline', '1');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
