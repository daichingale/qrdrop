// Offline cache (so the app opens on a hotspot with no internet) + Android share-menu target.
const C = 'qrdrop-v6';
const FILES = ['./', 'index.html', 'app.js', 'store.js', 'peers.js', 'sink-worker.js', 'pkg/qrdrop_core.js', 'pkg/qrdrop_core_bg.wasm',
  'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k))))); self.clients.claim(); });

function shareDB() {
  return new Promise((res, rej) => { const r = indexedDB.open('qrdrop-share', 1); r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
// Files shared from another app arrive as a POST; park them for the page, then open the page.
async function handleShare(req) {
  try {
    const fd = await req.formData();
    const files = fd.getAll('files').filter((f) => f && typeof f !== 'string');
    const text = ['title', 'text', 'url'].map((k) => fd.get(k)).filter((v) => typeof v === 'string' && v.trim()).join('\n');
    const d = await shareDB();
    await new Promise((res, rej) => { const t = d.transaction('items', 'readwrite'); t.objectStore('items').put({ id: 'pending', files, text, ts: Date.now() }); t.oncomplete = res; t.onerror = () => rej(t.error); });
  } catch {}
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === 'POST' && u.pathname.endsWith('/share-target')) { e.respondWith(handleShare(e.request)); return; }
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(C).then((c) => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
