// own prefix: the computer version (artist-cache-*) may share the origin
const CACHE_PREFIX = 'artist-cloud-';
const CACHE_NAME = `${CACHE_PREFIX}v2`;

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './manifest.json',
  './js/main.js',
  './js/Layer.js',
  './js/Frame.js',
  './js/BlobKey.js',
  './js/Easing.js',
  './js/ObjectLayer.js',
  './js/LayerManager.js',
  './js/History.js',
  './js/Stroke.js',
  './js/LayersPanel.js',
  './js/ViewTransform.js',
  './js/GestureMath.js',
  './js/NewCanvasDialog.js',
  './js/floodFill.js',
  './js/Selection.js',
  './js/Warp.js',
  './js/SelectionOverlay.js',
  './js/Storage.js',
  './js/HomeScreen.js',
  './js/Timeline.js',
  './js/ExportDialog.js',
  './js/VideoExport.js',
  './js/Mp4Muxer.js',
  './js/BackgroundDialog.js',
  './js/ProjectBackup.js',
  './js/VideoImport.js',
  './js/VideoImportDialog.js',
  './js/VideoPlacement.js',
  './js/DebugLog.js',
  './js/Display.js',
  './js/Icons.js',
  './js/TapFix.js',
  './js/MergeLayers.js',
  './js/ProjectFormat.js',
  './js/CloudStore.js',
  './js/firebaseConfig.js',
  './js/vendor/firebase/firebase-app.js',
  './js/vendor/firebase/firebase-auth.js',
  './js/vendor/firebase/firebase-firestore-lite.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Network-first: always prefer a fresh response while online, so active
// development never shows stale cached code. Cache is only a fallback
// for when there's no network at all (the actual offline/PWA benefit).
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // (sign-in and the cloud are other origins: never cached)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html'))),
  );
});
