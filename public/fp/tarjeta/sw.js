/* Service worker: abre sin señal y permite instalar la app (copiado del de Huemul). */

// El sello lo escribe build.mjs con la huella del index.html: cada cambio real
// estrena cache y borra la anterior. Cuando era un numero a mano, se olvidaba —
// y una version vieja servida desde la cache parece que el cambio no se subio.
var VERSION = 'fp-v11';

var GUARDAR = [
  './',
  './index.html',
  './ios-frame.jsx',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(GUARDAR); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) {
        return Promise.all(ks.map(function (k) {
          return k === VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;   // las fuentes de Google se las arregla el navegador

  // Al abrir la tarjeta se pregunta a la red PRIMERO, pero sin dejar a nadie
  // esperando: si en 3,5 segundos no contesta, entra lo guardado. Asi el que
  // tiene señal ve siempre lo ultimo, y el que no tiene abre igual.
  //
  // Al reves —lo guardado primero— la persona se queda con una version vieja
  // hasta la proxima vez que abra, y en pleno meson eso no se entiende.
  if (req.mode === 'navigate') {
    e.respondWith(
      new Promise(function (listo) {
        var resuelto = false;
        function responder(r) { if (!resuelto) { resuelto = true; listo(r); } }

        var reloj = setTimeout(function () {
          caches.match('./index.html').then(function (hit) { if (hit) responder(hit); });
        }, 3500);

        // 'no-cache' no significa no usar cache: significa preguntarle al servidor
        // si cambio. Si no cambio contesta 304 y no se baja nada. Sin esto, los 10
        // minutos de cache de GitHub tapan el cambio recien subido.
        fetch(new Request(req.url, { cache: 'no-cache' })).then(function (res) {
          clearTimeout(reloj);
          if (res && res.ok) {
            var copia = res.clone();
            caches.open(VERSION).then(function (c) { c.put('./index.html', copia); });
          }
          responder(res);
        }).catch(function () {
          clearTimeout(reloj);
          caches.match('./index.html').then(function (hit) {
            responder(hit || Response.error());
          });
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        // Se sirve lo guardado y se busca lo nuevo por detrás, sin hacer esperar.
        fetch(new Request(req.url, { cache: 'no-cache' })).then(function (res) {
          if (res && res.ok) caches.open(VERSION).then(function (c) { c.put(req, res); });
        }).catch(function () {});
        return hit;
      }
      return fetch(new Request(req.url, { cache: 'no-cache' })).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copia = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copia); });
        }
        return res;
      });
    })
  );
});
