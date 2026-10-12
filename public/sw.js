/* Domi service worker: keeps the app itself on the phone so it opens without signal.
   Patient data is not cached here. The app keeps today's round itself, and wipes it on sign-out. */
"use strict";
const CACHE = "domi-shell-v4";
const SHELL = ["/", "/app.js", "/areas.js", "/app.css", "/fonts/fonts.css", "/vendor/qrcode-generator-1.4.4.js", "/vendor/leaflet-1.9.4/leaflet.js", "/vendor/leaflet-1.9.4/leaflet.css", "/logo.svg", "/logo-lockup.svg", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return; // API: always the network
  const longLived = url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/vendor/");
  if (longLived) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  // Everything else: the network first (so a deploy shows at once), the saved copy when there's no signal.
  // Only the app's own page is saved as "/": other pages (like /book/...) are saved under their own address.
  const key = req.mode === "navigate" && url.pathname === "/" ? "/" : req;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then((hit) => hit || (req.mode === "navigate" && url.pathname === "/" ? caches.match("/") : undefined)).then((hit) => hit || Response.error())));
});
