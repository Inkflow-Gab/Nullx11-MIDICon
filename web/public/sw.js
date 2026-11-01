/* Cache only public application assets. Never cache API responses or upload bodies. */
const VERSION = 'v4';
const SHELL_CACHE = `midicon-shell-${VERSION}`;
const ASSET_CACHE = `midicon-assets-${VERSION}`;
const BASE = new URL('./', self.location.href);
const local = path => new URL(path, BASE).href;
const SHELL = ['', 'index.html', 'manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'].map(local);

async function precacheBuildAssets() {
  const cache = await caches.open(ASSET_CACHE);
  const response = await fetch(local('index.html'));
  if (!response.ok) return;
  const html = await response.text();
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)) urls.add(new URL(match[1], BASE).href);
  const initial = [...urls];
  if (initial.length) await cache.addAll(initial);
  for (const asset of initial) {
    if (!asset.endsWith('.css')) continue;
    try {
      const cssResponse = await fetch(asset);
      if (!cssResponse.ok) continue;
      const css = await cssResponse.text();
      for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
        const raw = match[1].trim().replace(/^['"]|['"]$/g, '');
        if (!raw || raw.startsWith('data:')) continue;
        const resolved = new URL(raw, asset);
        if (resolved.origin === BASE.origin && resolved.pathname.includes('/assets/')) urls.add(resolved.href);
      }
    } catch { /* Font precaching is best effort. */ }
  }
  const extra = [...urls].filter(url => !initial.includes(url));
  if (extra.length) await cache.addAll(extra);
  // Heavy conversion assets are cached best-effort so a loaded browser studio can keep working offline.
  for (const path of ['models/basic-pitch.onnx', 'models/LICENSE', 'models/NOTICE', 'ort/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.mjs', 'ort/LICENSE', 'demo.wav']) {
    try { const url = local(path); const response = await fetch(url); if (response.ok) await cache.put(url, response); } catch { /* Optional until first online use. */ }
  }
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(precacheBuildAssets));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('midicon-') && key !== SHELL_CACHE && key !== ASSET_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

async function navigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(SHELL_CACHE)).put(local('index.html'), response.clone());
    return response;
  } catch {
    return await caches.match(local('index.html')) || new Response('Reconnect once to install the MIDICon offline shell.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}
async function staticAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  if (cached) { network.catch(() => {}); return cached; }
  try { return await network; } catch { return new Response('This browser-model asset is not cached yet. Reconnect and try again.', { status: 503 }); }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const relative = url.pathname.slice(BASE.pathname.length);
  if (relative.startsWith('api/')) return;
  if (request.mode === 'navigate') { event.respondWith(navigation(request)); return; }
  if (SHELL.includes(url.href)) { event.respondWith(caches.match(request).then(cached => cached || fetch(request))); return; }
  if (/^(assets|models|ort)\//.test(relative) || relative === 'demo.wav') event.respondWith(staticAsset(request));
});
