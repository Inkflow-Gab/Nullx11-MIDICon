/* MIDICon service worker: cache the static app shell only.
 * Never cache /api/* (sessions, jobs, progress, notes, downloads, or user audio).
 */
const VERSION = 'v1';
const SHELL_CACHE = `midicon-shell-${VERSION}`;
const ASSET_CACHE = `midicon-assets-${VERSION}`;
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

async function precacheBuildAssets() {
  const cache = await caches.open(ASSET_CACHE);
  const response = await fetch('/index.html');
  if (!response.ok) return;
  const html = await response.text();
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) urls.add(match[1]);
  const initial = [...urls];
  if (initial.length) await cache.addAll(initial);
  // Vite CSS references local font files; cache those too so the offline shell keeps its type.
  for (const asset of initial) {
    if (!asset.endsWith('.css')) continue;
    try {
      const cssResponse = await fetch(asset);
      if (!cssResponse.ok) continue;
      const css = await cssResponse.text();
      for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
        const raw = match[1].trim().replace(/^['"]|['"]$/g, '');
        if (!raw || raw.startsWith('data:')) continue;
        const resolved = new URL(raw, new URL(asset, self.location.origin));
        if (resolved.origin === self.location.origin && resolved.pathname.startsWith('/assets/')) urls.add(resolved.pathname);
      }
    } catch { /* best-effort font precache */ }
  }
  const all = [...urls].filter(url => !initial.includes(url));
  if (all.length) await cache.addAll(all);
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(precacheBuildAssets)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('midicon-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match('/index.html');
    return cached || new Response('MIDICon is offline. Reconnect to load the studio.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Privacy/functionality guard: API responses are always network-only.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
    return;
  }

  const isStatic = url.pathname.startsWith('/assets/') ||
    ['script', 'style', 'font', 'image'].includes(request.destination);
  if (isStatic) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
