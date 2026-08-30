// sw.js — Wafa PWA Service Worker
const CACHE = "wafa-v3";
// كاش منفصل ودائم لتايلات خرائط OpenStreetMap (Leaflet) — لا يُحذف عند
// تحديث CACHE أعلاه، ويُستخدم بإستراتيجية cache-first لتفادي إعادة تحميل
// نفس مربعات خريطة الجزائر في كل مرة تُفتح فيها "Carte de la tournée".
const TILE_CACHE = "wafa-tiles-v1";
const TILE_HOST_RE = /(^|\.)tile\.openstreetmap\.org$/;
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
      Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Pass through API / Odoo requests — never cache
  if (url.pathname.startsWith("/api/") || url.pathname.includes("/web/image")) {
    return; // let browser handle
  }
  if (e.request.method !== "GET") return; // Cache API only supports GET

  // Tuiles de carte OSM: cache-first, une fois téléchargée une zone
  // (ex: l'Algérie) elle reste en local et n'est plus re-téléchargée.
  if (TILE_HOST_RE.test(url.hostname)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async c => {
        const cached = await c.match(e.request);
        if (cached) return cached;
        try {
          const res = await fetch(e.request);
          if (res.ok) c.put(e.request, res.clone());
          return res;
        } catch (_) {
          return cached || new Response("", { status: 504 });
        }
      })
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("/index.html")))
  );
});
