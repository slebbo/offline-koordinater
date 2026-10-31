// Offline cache only. Geolocation, permission checks, and stored coordinates live in
// the page: a service worker has no Geolocation API, and localStorage is unavailable here.

const CACHE_NAME = "offline-koordinater-v5";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/about.html",
  "/css/app.css",
  "/js/app.js",
  "/js/geo-store.js",
  "/js/offline-store.js",
  "/js/components.js",
  "/vendor/alpinejs/module.esm.js",
  "/vendor/@alpinejs/persist/module.esm.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  event.respondWith(fromCache(event.request));
});

async function fromCache(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    if (request.mode === "navigate") {
      const pathname = new URL(request.url).pathname;
      const byPath = await cache.match(pathname === "/" ? "/index.html" : pathname);
      if (byPath) return byPath;
      const home = await cache.match("/index.html");
      if (home) return home;
    }
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
