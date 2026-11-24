// Offline and weak-wifi support for LPU Wayfinder.
// - The page and the block list: try the network, but if it takes longer than a few seconds (or fails),
//   show the saved copy. The fresh answer still updates the saved copy for next time.
// - The campus snapshot, icons and manifest: show the saved copy at once, refresh it in the background.
// - Built code (/_next/static, file names change every deploy): saved once, never fetched again.
// - Never saved: /api/* (visit counts, the campus proxy), anything that is not a GET, the owner's editor calls.
// shortcut: old /_next/static files stay until CACHE is renamed; bump it if the cache ever grows too big.

const CACHE = "lpu-v1";
const WAIT_MS = 3000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** Network, but fall back to the saved copy after `ms` (or on failure). The network answer is saved when it arrives. */
async function fresh(event, key, ms) {
  const cache = await caches.open(CACHE);
  const net = fetch(event.request).then((r) => {
    if (r.ok) return cache.put(key, r.clone()).then(() => r);
    return r;
  });
  event.waitUntil(net.catch(() => {}));
  const saved = await cache.match(key);
  if (!saved) return net;
  return Promise.race([net.catch(() => saved), new Promise((done) => setTimeout(() => done(saved), ms))]);
}

async function once(event) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(event.request);
  if (saved) return saved;
  const r = await fetch(event.request);
  if (r.ok) event.waitUntil(cache.put(event.request, r.clone()));
  return r;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;

  if (own && req.mode === "navigate") {
    event.respondWith(fresh(event, "/", WAIT_MS)); // one saved page; ?b=34 is read by the page itself
  } else if (own && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(once(event));
  } else if (own && (url.pathname === "/campus-raw.json" || url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest")) {
    event.respondWith(fresh(event, req, 0));
  } else if (!own && url.pathname.startsWith("/rest/v1/campus_")) {
    event.respondWith(fresh(event, req, WAIT_MS)); // the block list and labels from Supabase
  }
});
