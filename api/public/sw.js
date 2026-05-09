// public/sw.js
// Mismatch Finder — Service Worker
// Strategy: app-shell cache + network-first for API calls + offline fallback
//
// Caches the main HTML + fonts + landing page so the app opens instantly.
// API responses are NOT cached long-term (projections change throughout the day),
// but served stale-while-revalidate so the user sees something immediately.

const VERSION = 'v1.0.0';
const SHELL_CACHE = `mf-shell-${VERSION}`;
const RUNTIME_CACHE = `mf-runtime-${VERSION}`;

// Files that make up the app shell — cached on install
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/landing.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS).catch(err => {
        // Don't fail install if one asset is missing — log and continue
        console.warn('[SW] Some shell assets failed to cache:', err);
        // Cache what we can individually
        return Promise.all(
          SHELL_ASSETS.map(url =>
            cache.add(url).catch(e => console.warn(`[SW] Failed: ${url}`, e))
          )
        );
      }))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy:
//  - Navigation requests (HTML pages): network first, fall back to cache, then offline page
//  - API requests (/api/*): network only, with short stale-while-revalidate for GET
//  - Static assets (fonts, images, icons): cache first
//  - Everything else: network first with cache fallback

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests (POST, PUT, DELETE etc. pass through)
  if (request.method !== 'GET') return;

  // Skip cross-origin requests (fonts from Google, external APIs, etc.)
  // Let browser handle these normally
  if (url.origin !== self.location.origin) {
    // Exception: Google Fonts — cache them aggressively
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      event.respondWith(cacheFirstStrategy(request));
    }
    return;
  }

  // API requests — network first, fall back to nothing (don't serve stale bets data)
  if (url.pathname.startsWith('/api/')) {
    // Exception: analyze endpoint can be cached briefly for back/forward nav
    if (url.pathname === '/api/analyze' || url.pathname === '/api/probables') {
      event.respondWith(networkFirstStrategy(request, RUNTIME_CACHE, 60));
    }
    return;  // Everything else, pass through to network
  }

  // Navigation requests — network first, offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache fresh HTML in runtime cache
          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request)
            .then(cached => cached || caches.match('/'))
        )
    );
    return;
  }

  // Static assets — cache first
  if (url.pathname.startsWith('/icons/') ||
      url.pathname.endsWith('.png') ||
      url.pathname.endsWith('.jpg') ||
      url.pathname.endsWith('.svg') ||
      url.pathname.endsWith('.woff2') ||
      url.pathname.endsWith('.css') ||
      url.pathname === '/manifest.webmanifest') {
    event.respondWith(cacheFirstStrategy(request));
    return;
  }

  // Default: network first
  event.respondWith(networkFirstStrategy(request, RUNTIME_CACHE));
});

async function cacheFirstStrategy(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Return offline placeholder if nothing cached
    return new Response('Offline and not cached', { status: 503 });
  }
}

async function networkFirstStrategy(request, cacheName, maxAgeSeconds) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) {
      // Check age if maxAgeSeconds provided
      if (maxAgeSeconds) {
        const dateHeader = cached.headers.get('date');
        if (dateHeader) {
          const age = (Date.now() - new Date(dateHeader).getTime()) / 1000;
          if (age < maxAgeSeconds) return cached;
        }
      }
      return cached;
    }
    return new Response('Offline', { status: 503 });
  }
}

// Message handler — lets the main app trigger a cache bust or check version
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: VERSION });
  }
});
