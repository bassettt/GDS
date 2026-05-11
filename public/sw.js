// sw.js — Wafa PWA Service Worker
const CACHE = "wafa-v2";
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
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  // Pass through API / Odoo requests — never cache
  const url = new URL(e.request.url);
if (url.pathname.startsWith("/api/") || url.pathname.includes("/web/image")) {
    return; // let browser handle
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match("/index.html")))
  );
});
