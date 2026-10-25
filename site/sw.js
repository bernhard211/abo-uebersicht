// Immer zuerst aus dem Netz laden (so kommen App-Updates sofort an),
// bei Funkloch die zuletzt geladene Version aus dem Zwischenspeicher.
var CACHE = 'abo-v3';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // data.json?t=… immer unter demselben Schlüssel ablegen
  var key = url.pathname.endsWith('/data.json') ? 'data.json' : e.request;
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
    return r;
  }).catch(function () {
    return caches.match(key).then(function (hit) { return hit || caches.match('index.html'); });
  }));
});
