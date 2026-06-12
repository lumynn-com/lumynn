/* Lumynn service worker.
 *
 * Goals:
 *   - Satisfy Android Chrome's PWA install criteria.
 *   - Make the app shell available when the network is unreachable so
 *     opening the app on the lock screen doesn't show Chrome's
 *     "no internet" page.
 *   - Let media attachments referenced by cached notes render from
 *     cache while the document editor runs in offline mode.
 *
 * Non-goals:
 *   - Caching authenticated JSON API responses (POST/PUT/DELETE + GET
 *     /api/* except media blobs). Library and auth state are handled
 *     by the app's IndexedDB offline layer.
 *   - Background sync, push, periodic sync. Those add attack surface
 *     and we don't need them.
 *
 * Strategy:
 *   - install:  pre-cache the SPA shell entry (/) so we have an
 *               offline fallback for navigations.
 *   - activate: drop any older caches.
 *   - fetch:    same-origin GET only.
 *               * /api/documents/media -> user-scoped network first,
 *                                           cached fallback.
 *               * other /api/*     -> network only, no caching.
 *               * navigations (HTML)-> network first, fall back to
 *                                     the cached shell entry.
 *               * static assets    -> stale-while-revalidate so the
 *                                     app starts instantly on repeat
 *                                     visits and silently updates.
 */

const CACHE_VERSION = "owd-v6";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSETS_CACHE = `${CACHE_VERSION}-assets`;
const MEDIA_CACHE_PREFIX = `${CACHE_VERSION}-media-`;
const SHELL_ENTRY = "/";
const PWA_ASSET_PATHS = new Set([
  "/manifest.webmanifest",
  "/icon.svg",
  "/favicon.ico",
  "/favicon-16.png",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png"
]);

let activeUserKey = "";

function userCacheKey(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36) || "user";
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "LUMYNN_ACTIVE_USER" && typeof data.username === "string" && data.username) {
    activeUserKey = userCacheKey(data.username);
    return;
  }
  if (data.type === "LUMYNN_CLEAR_ACTIVE_USER") {
    activeUserKey = "";
    event.waitUntil(
      caches.keys().then((names) =>
        Promise.all(names.map((name) => (name.startsWith(MEDIA_CACHE_PREFIX) ? caches.delete(name) : null)))
      )
    );
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Try to seed the shell. If the network is offline at install
      // time we just skip silently; navigations will populate it later.
      try {
        const response = await fetch(SHELL_ENTRY, { cache: "reload" });
        if (response && response.ok) {
          await cache.put(SHELL_ENTRY, response.clone());
        }
      } catch {
        // ignore: shell will be cached on the first successful navigation.
      }
      const assets = await caches.open(ASSETS_CACHE);
      await Promise.all(
        [...PWA_ASSET_PATHS].map(async (path) => {
          try {
            const response = await fetch(path, { cache: "reload" });
            if (response && response.ok) {
              await assets.put(path, response.clone());
            }
          } catch {
            // ignore: icons/manifest will be cached on the first successful fetch.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSETS_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => (keep.has(name) || name.startsWith(MEDIA_CACHE_PREFIX) ? null : caches.delete(name)))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === "/api/documents/media") {
    event.respondWith(mediaStrategy(request));
    return;
  }

  // Never cache other API calls. Always go straight to the network.
  if (url.pathname.startsWith("/api/")) return;

  // Navigation requests: network first, fall back to the cached shell.
  if (request.mode === "navigate") {
    event.respondWith(navigationStrategy(request));
    return;
  }

  // PWA install metadata should prefer the network so desktop/mobile
  // shortcuts don't pick an old or previously failed icon from cache.
  if (PWA_ASSET_PATHS.has(url.pathname)) {
    event.respondWith(networkFirstAsset(request));
    return;
  }

  // Static assets (built JS/CSS, fonts, icons, manifest):
  // stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});

async function navigationStrategy(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(SHELL_ENTRY, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(SHELL_ENTRY);
    if (cached) return cached;
    return Response.error();
  }
}

async function networkFirstAsset(request) {
  const cache = await caches.open(ASSETS_CACHE);
  try {
    const response = await fetch(request, { cache: "reload" });
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSETS_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function cachedMediaResponse(request) {
  if (activeUserKey) {
    const activeCache = await caches.open(`${MEDIA_CACHE_PREFIX}${activeUserKey}`);
    const cached = await activeCache.match(request);
    if (cached) return cached;
  }

  const names = await caches.keys();
  for (const name of names) {
    if (!name.startsWith(MEDIA_CACHE_PREFIX)) continue;
    const cache = await caches.open(name);
    const cached = await cache.match(request);
    if (cached) return cached;
  }
  return null;
}

async function mediaStrategy(request) {
  const cache = activeUserKey ? await caches.open(`${MEDIA_CACHE_PREFIX}${activeUserKey}`) : null;
  try {
    const response = await fetch(request);
    if (response && response.ok && cache) {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await cachedMediaResponse(request);
    if (cached) return cached;
    return Response.error();
  }
}
