// Минимальный service worker — кеширует оболочку приложения,
// чтобы Studio открывался офлайн. v2: НЕ трогаем /api/* (там OAuth и cookies).
const CACHE = 'studio-v2';
const FILES = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  // Никогда не кешируем API — там OAuth, куки, динамические ответы
  if (url.pathname.startsWith('/api/')) return;
  // Кросс-доменные запросы тоже не трогаем
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp.ok && resp.type === 'basic') {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
