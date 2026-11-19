// Tenojoki field map – offline support
const SHELL = "teno-shell-v2", TILES = "teno-tiles-v1";
const SHELL_FILES = ["./", "index.html", "field.js?v=1", "manifest.webmanifest", "icon.svg", "icon-192.png",
  "data/study_areas.geojson", "data/start_points.geojson",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.includes("/tiles/")) {            // our map tiles: cache first, keep what we fetch
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true }); if (hit) return hit;
      const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r;
    }));
    return;
  }
  if (url.hostname.endsWith("opentopomap.org") || url.hostname.endsWith("openstreetmap.org")) return; // online-only layers
  e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(SHELL).then(c => c.put(e.request, r.clone())); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
