// Service worker de INMERSIA.
// Debe servirse desde la RAÍZ (/sw.js) para que su scope cubra toda la app.
const CACHE = "inmersia-v5";

// El esqueleto: lo mínimo para pintar la app en pantalla. React, Babel y las fuentes vienen
// de CDN, otro origen, y los cachea el navegador por su cuenta con su propio max-age largo.
const SHELL = ['/index.html', '/manifest.json', '/icon-180.png', '/icon-192.png', '/icon-512.png'];

// Casi toda navegación acaba en el mismo index.html —la app es una SPA y el servidor tiene un
// `app.get("*")` al final—, así que todas comparten una sola entrada en la caché.
//
// Pero NO todas: antes de ese comodín, el servidor sirve `/guion` con su propio HTML y
// `express.static` entrega cualquier archivo suelto de public/. Si se tratan como el esqueleto
// de la app, el service worker devuelve index.html en su lugar y esas páginas desaparecen sin
// aviso. Se detectan por lo que son: una lista corta de rutas propias, más cualquier ruta que
// termine en extensión.
const NO_ES_APP = ['/guion'];
const esNavegacionApp = (req, url) =>
  req.mode === 'navigate' && !NO_ES_APP.includes(url.pathname) && !/\.[a-z0-9]+$/i.test(url.pathname);

// Los iconos se piden con `?v=2`; guardar por pathname ignora la query y evita duplicados.
const claveDe = (req, url) =>
  (esNavegacionApp(req, url) || url.pathname === '/') ? '/index.html' : url.pathname;

const esShell = (req, url) => esNavegacionApp(req, url) || url.pathname === '/' || SHELL.includes(url.pathname);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Avisa a las pestañas abiertas de que el servidor tiene una versión distinta de la que se
// está mostrando. La app decide qué hacer con eso; aquí no se recarga nada por sorpresa.
async function avisarVersionNueva() {
  const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of abiertas) c.postMessage({ tipo: 'version-nueva' });
}

// Caché primero, con refresco por detrás.
//
// Antes esto era al revés: se iba siempre a la red y solo se miraba la caché si la petición
// FALLABA. Con Render durmiendo el plan gratuito la red no falla, se queda colgada un minuto
// mientras el proceso arranca — así que la copia guardada no entraba nunca justo en el caso
// para el que se había guardado. Era una caché para cuando no hay internet, no para abrir
// rápido. Ahora la app abre desde el disco aunque el servidor esté dormido, y la versión
// nueva se descarga en segundo plano para la próxima apertura.
async function conCache(req, clave, evento) {
  const cache = await caches.open(CACHE);
  const guardado = await cache.match(clave);

  // Se pide por la clave, no por la petición original: una `Request` en modo navigate no se
  // puede reutilizar tal cual y el resultado es el mismo archivo.
  const refresco = fetch(clave, { credentials: 'same-origin' }).then(async r => {
    if (!r || r.status !== 200) return r;
    const antes = guardado && guardado.headers.get('etag');
    const ahora = r.headers.get('etag');
    await cache.put(clave, r.clone());
    // Solo se avisa si había algo guardado y cambió: en la primera visita no hay versión
    // vieja que reemplazar y el aviso no significaría nada.
    if (guardado && antes && ahora && antes !== ahora) await avisarVersionNueva();
    return r;
  }).catch(() => null);

  if (guardado) {
    // `waitUntil` mantiene vivo el service worker hasta que termine la descarga, aunque la
    // respuesta ya se haya entregado. Sin eso el navegador puede matarlo a media bajada y la
    // caché se quedaría en la versión vieja para siempre.
    evento.waitUntil(refresco);
    return guardado;
  }
  // Primera visita: no hay nada que servir, toca esperar a la red.
  return (await refresco) || Response.error();
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Nunca cachear la API ni otros orígenes: guardar respuestas de /api/ hacía que la app
  // sirviera datos viejos al reconectar, y que las llamadas a Supabase quedaran atrapadas.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // El video se pide por rangos (Range: bytes=…). Un service worker que intercepta esas
  // peticiones rompe la reproducción: el elemento se queda en negro esperando datos que
  // nunca llegan, y la respuesta 206 tampoco se puede guardar en Cache Storage. Se dejan
  // pasar directo al navegador.
  if (e.request.headers.has('range')) return;
  const dest = e.request.destination;
  if (dest === 'video' || dest === 'audio') return;

  if (esShell(e.request, url)) {
    e.respondWith(conCache(e.request, claveDe(e.request, url), e));
    return;
  }

  // Todo lo demás —material subido, lo que se agregue mañana— sigue yendo a la red primero.
  // Ahí la copia guardada es solo un respaldo para cuando no hay conexión, que es lo correcto:
  // de estos archivos nadie sabe cuándo cambian.
  e.respondWith(
    fetch(e.request).then(r => {
      // Solo se cachean respuestas completas (200); una 206 hace que cache.put falle.
      if (r.status === 200) { const rc = r.clone(); caches.open(CACHE).then(c => c.put(e.request, rc)).catch(() => {}); }
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// ── PUSH ──────────────────────────────────────────────────────────
// SIEMPRE hay que mostrar una notificación visible dentro de event.waitUntil().
// Safari aplica el contrato `userVisibleOnly` de forma estricta y puede revocar la
// suscripción si llega un push que no muestra nada.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'INMERSIA';
  const opts = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,          // agrupa/reemplaza notificaciones del mismo tema
    renotify: !!d.tag,
    data: { url: d.url || '/' },
    requireInteraction: !!d.important,
  };
  e.waitUntil(
    self.registration.showNotification(title, opts).then(() => {
      if (typeof d.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
        return self.navigator.setAppBadge(d.badge).catch(() => {});
      }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Si la app ya está abierta, la enfocamos en vez de abrir otra ventana
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          if ('navigate' in c && target !== '/') c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// iOS no expone `expirationTime`, así que no se puede anticipar el vencimiento:
// el único aviso es este evento cuando el endpoint rota.
function b64ToU8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const r = await fetch('/api/push/key');
      const { publicKey } = await r.json();
      if (!publicKey) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToU8(publicKey),   // Safari no acepta la clave en base64
      });
      // `renewedFrom` es lo único que identifica a la persona desde aquí: el servidor busca
      // por ese endpoint y hereda el correo. Sin eso la suscripción entra anónima y no vuelve
      // a recibir un solo aviso dirigido.
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ subscription: sub, renewedFrom: e.oldSubscription ? e.oldSubscription.endpoint : null }),
      });
    } catch (_) {}
  })());
});
