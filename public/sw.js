// sw.js — Wafa PWA Service Worker
const CACHE = "wafa-v4";
const ASSETS = [
  "/",
  "/index.html",
  "/src/app.js",
  "/src/storage.js",
  "/src/utils.js",
  "/src/controllers/rpcController.js",
  "/src/renderer.js",
  "/src/queryBuilder.js",
  "/src/style.css",
  "/manifest.json"
];

self.addEventListener("install", e => {
  // تفعيل فوري بدون انتظار إغلاق الـ tabs
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // API و Odoo — لا تخزن أبداً
  if (url.pathname.startsWith("/api/") || url.pathname.includes("/web/image")) {
    return;
  }

  // ملفات JS و CSS و HTML — Network First مع no-cache
  if (
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/"
  ) {
    e.respondWith(
      fetch(e.request, { cache: "no-cache" })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // باقي الملفات — Cache First
  e.respondWith(
    caches.match(e.request)
      .then(r => r || fetch(e.request).catch(() => caches.match("/index.html")))
  );
});
