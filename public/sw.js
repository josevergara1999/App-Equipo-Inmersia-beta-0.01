// Service worker de INMERSIA.
// Debe servirse desde la RAÍZ (/sw.js) para que su scope cubra toda la app.
const CACHE = "inmersia-v4";
const ASSETS = ['/', '/index.html', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

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
