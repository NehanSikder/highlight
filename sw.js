/* Highlight service worker — cache-first shell so the reader opens instantly
 * and works offline. Bump VERSION on any shell change. */

const VERSION = "hl-v3";
const SHELL = [
  ".",
  "index.html",
  "reader.css",
  "app.js",
  "format-pdf.mjs",
  "vendor/jszip.min.js",
  "vendor/pdf.min.mjs",
  "vendor/pdf.worker.min.mjs",
  "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
