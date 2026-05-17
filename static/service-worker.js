/*
 * YaSE service worker — offline-first caching.
 *
 * Strategy:
 *   - On install: pre-cache the app shell (HTML, manifest, icons).
 *   - On runtime: cache JS / wasm / ROM / tape-loader fetches as they happen,
 *     serve cache-first on subsequent loads. Everything else (HTTP search
 *     queries, game downloads via archive.org CORS) hits the network only.
 *
 * Cache name is versioned so a redeploy invalidates the old shell. Bump
 * APP_VERSION whenever you ship build-breaking changes.
 */

const APP_VERSION = 'yase-v1';
const PRECACHE = [
    './',
    'index.html',
    'manifest.webmanifest',
    'favicon.ico',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(APP_VERSION).then((cache) => cache.addAll(PRECACHE).catch(() => null))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== APP_VERSION).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;     // skip cross-origin

    // Don't cache the service worker itself (browsers manage that).
    if (url.pathname.endsWith('/service-worker.js')) return;

    // Cache-first for everything else under our origin.
    event.respondWith((async () => {
        const cache = await caches.open(APP_VERSION);
        const cached = await cache.match(req);
        if (cached) {
            // Revalidate in the background so we pick up fresh JS/wasm/ROMs
            // without forcing the user to hard-reload.
            fetch(req).then((resp) => {
                if (resp.ok) cache.put(req, resp.clone());
            }).catch(() => {});
            return cached;
        }
        try {
            const resp = await fetch(req);
            if (resp.ok) cache.put(req, resp.clone());
            return resp;
        } catch (err) {
            // Offline + not cached — surface a clean failure.
            return new Response('Offline and not cached', { status: 503 });
        }
    })());
});
