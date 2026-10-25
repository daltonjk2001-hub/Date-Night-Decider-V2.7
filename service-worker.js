'use strict';

/* Date Night Decider service worker v2.9.4.
   Full offline caching for GitHub Pages with resilient CDN vendor precaching. */

const CACHE_NAME = 'date-night-decider-v2.9.4';
const LEGACY_CACHE_PREFIX = 'date-night-decider-';

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=2.9.4',
  './app.js?v=2.9.4'
];

const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/dexie/3.2.4/dexie.min.js',
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'
];

const OPTIONAL_ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const CDN_HOSTS = new Set([
  'cdnjs.cloudflare.com',
  'unpkg.com'
]);

async function cacheSafely(cache, request, response) {
  try {
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn('Cache update failed:', request.url, error);
  }
}

async function findCachedResponse(cache, request, cacheKey) {
  return (
    await cache.match(request, { ignoreSearch: true }) ||
    await cache.match(cacheKey, { ignoreSearch: true }) ||
    null
  );
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    
    try {
      await cache.addAll(CORE_ASSETS);
    } catch (error) {
      console.error('Service worker could not cache the required app shell:', error);
      await caches.delete(CACHE_NAME);
      throw error;
    }

    await Promise.all(
      CDN_ASSETS.map(async asset => {
        try {
          await cache.add(asset);
        } catch (error) {
          console.warn(
            'Optional CDN asset not cached during SW install:',
            asset,
            error
          );
        }
      })
    );

    await Promise.all(OPTIONAL_ASSETS.map(async asset => {
      try {
        await cache.add(asset);
      } catch (error) {
        console.warn('Optional asset not cached:', asset, error);
      }
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => {
      if (key.startsWith(LEGACY_CACHE_PREFIX) && key !== CACHE_NAME) {
        return caches.delete(key);
      }
      return Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin && CDN_HOSTS.has(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      try {
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') {
          await cacheSafely(cache, request, response);
          return response;
        }
        return cached || response;
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;
  const scopeUrl = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scopeUrl.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = request.mode === 'navigate' ? new URL('./index.html', scopeUrl).href : request;

    try {
      const response = await fetch(request);
      if (response.ok) {
        await cacheSafely(cache, cacheKey, response);
        return response;
      }
      const fallback = await findCachedResponse(cache, request, cacheKey);
      if (fallback) return fallback;
      return response;
    } catch (error) {
      const fallback = await findCachedResponse(cache, request, cacheKey);
      if (fallback) return fallback;
      if (request.mode === 'navigate') {
        const indexUrl = new URL('./index.html', scopeUrl).href;
        const indexFallback = await cache.match(indexUrl);
        if (indexFallback) return indexFallback;
      }
      throw error;
    }
  })());
});
