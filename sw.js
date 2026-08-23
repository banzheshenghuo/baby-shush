// 嘘嘘哄睡 Service Worker
// 策略：网络优先 + 缓存回退 —— 在线时始终拿到最新版本，离线时回退到上次缓存
const CACHE = 'baby-shush-v3';
const ASSETS = ['./', './index.html', './style.css', './app.js', './audio/xuxu.mp3', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 音频文件永不变化：缓存优先、后台静默更新——再次进入页面即刻起播。
  // Range（拖动进度）请求不走缓存，直接回源。
  const isAudio = new URL(e.request.url).pathname.endsWith('/audio/xuxu.mp3');
  if (isAudio && !e.request.headers.has('range')) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const refresh = fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./')))
  );
});
