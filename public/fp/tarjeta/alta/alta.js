/* ============================================================================
   LA PUERTA DE ENTRADA — lógica
   ============================================================================
   Decide qué ve la persona ANTES de la tarjeta, y en qué orden:

     0. Navegador de Instagram  → sacarla a Safari/Chrome (ahí no se puede instalar)
     1. Navegador normal        → cómo agregarla a la pantalla de inicio
     2. Abierta desde el ícono  → la campana, y recién ahí la tarjeta
     3. Después de inscribirse  → la campana otra vez, si la primera vez dijo que no

   POR QUÉ LA PRIMERA CAMPANA NO PIDE EL PERMISO DE VERDAD
   iOS deja preguntar UNA sola vez. Si sale el cuadro del sistema y la persona
   toca "No permitir", no se puede volver a preguntar nunca — solo se arregla
   entrando a Ajustes a mano. Así que primero preguntamos nosotros, con dos
   botones nuestros, y el cuadro real solo sale si toca "Activar". Si toca
   "Ahora no", el permiso del sistema queda intacto y nos queda el segundo
   intento, ya con la tarjeta en la mano.

   Para probar una pantalla suelta: ?pantalla=interno|ios|android|escritorio|
   campana|campana2|ajustes|listo
   ========================================================================== */

(function () {
  'use strict';

  var CLAVE = {
    campana:  'fp.campana',      // activada | ahora-no | denegada
    instalada:'fp.instalada',    // 1 en cuanto se detecta abierta desde el ícono
    ajustes:  'fp.ajustesVisto'  // 1 cuando ya se explicó cómo reactivar
  };

  function leer(k)     { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function guardar(k,v){ try { localStorage.setItem(k, v); } catch (e) {} }

  var ua = navigator.userAgent || '';

  var esIOS = /iPad|iPhone|iPod/.test(ua) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var esAndroid = /Android/i.test(ua);

  // Navegadores dentro de otra app. Ninguno ofrece "Agregar a inicio", así que
  // entrar por aquí es un callejón sin salida si no se avisa.
  var esInterno = /Instagram|FBAN|FBAV|FBIOS|FB_IAB|Line\/|TikTok|BytedanceWebview|Snapchat|Pinterest|LinkedInApp|Twitter|MicroMessenger/i.test(ua);

  var hayAvisos = ('Notification' in window);

  function estaInstalada() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }

  function permiso() { return hayAvisos ? Notification.permission : 'unsupported'; }

  // ── Iconos ───────────────────────────────────────────────────────────────
  // Dibujados, no emoji: escalan y toman el color del texto.

  var IC = {
    compartir: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/></svg>',
    bajar:     '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>',
    agregar:   '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
    puntos:    '<svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
    puntosV:   '<svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',
    safari:    '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
    ajustes:   '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.32 1.77l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.6 1.6 0 00-1.77-.32 1.6 1.6 0 00-1 1.47V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1.05-1.47 1.6 1.6 0 00-1.77.32l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.6 1.6 0 00.32-1.77 1.6 1.6 0 00-1.47-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.47-1.05 1.6 1.6 0 00-.32-1.77l-.06-.06a2 2 0 112.83-2.83l.06.06a1.6 1.6 0 001.77.32H9a1.6 1.6 0 001-1.47V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.47 1.6 1.6 0 001.77-.32l.06-.06a2 2 0 112.83 2.83l-.06.06a1.6 1.6 0 00-.32 1.77V9a1.6 1.6 0 001.47 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.47 1z"/></svg>',
    campana:   '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8z"/><path d="M13.7 19a2 2 0 01-3.4 0"/></svg>',
    abrir:     '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="11" height="11" rx="3.2"/><path d="M17 3h4v4M21 3l-7.5 7.5"/><path d="M20 13v5.5A2.5 2.5 0 0117.5 21h-11A2.5 2.5 0 014 18.5v-11"/></svg>',
    punto:     '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>'
  };

  // ── Andamiaje ────────────────────────────────────────────────────────────

  var capa, lienzo, promptAndroid = null, entregada = false;

  function montar() {
    capa = document.createElement('div');
    capa.className = 'fp-alta';
    capa.id = 'fp-alta';
    lienzo = document.createElement('div');
    lienzo.className = 'fp-lienzo';
    capa.appendChild(lienzo);
    document.body.appendChild(capa);
  }

  function pintar(html) {
    if (!capa) montar();
    capa.hidden = false;
    lienzo.innerHTML = html;
    lienzo.scrollTop = 0;
  }

  function al(id, fn) {
    var el = lienzo.querySelector('#' + id);
    if (el) el.addEventListener('click', fn);
  }

  function cabecera(titulo, bajada, eyebrow) {
    return '<div class="fp-logo fp-entra"><span>FAMILY</span><span>PET&rsquo;S</span></div>' +
      (eyebrow ? '<p class="fp-eyebrow fp-entra-2">' + eyebrow + '</p>' : '') +
      '<h1 class="fp-titulo fp-entra-2">' + titulo + '</h1>' +
      '<p class="fp-bajada fp-entra-3">' + bajada + '</p>';
  }

  function paso(icono, orden, texto, destacado) {
    return '<li class="fp-paso' + (destacado ? ' fp-paso-clave' : '') + '">' +
      '<span class="fp-paso-icono">' + icono + '</span>' +
      '<span class="fp-paso-texto"><span class="fp-paso-orden">' + orden + '</span>' + texto + '</span></li>';
  }

  // ── 0 · Navegador dentro de otra app ─────────────────────────────────────

  function pantallaInterno() {
    var nav = esIOS ? 'Safari' : 'Chrome';
    var menu = esIOS ? IC.puntos : IC.puntosV;
    pintar(
      cabecera('Ábrela en ' + nav,
        'Estás dentro del navegador de otra aplicación y desde aquí el teléfono no deja guardar la tarjeta. Son dos toques.',
        'Un paso antes') +
      '<ul class="fp-pasos fp-entra-3">' +
        paso(menu, 'Primero', 'Toca <b>' + (esIOS ? 'los tres puntos' : 'el menú') + '</b> de la esquina.') +
        paso(IC.safari, 'Después', 'Elige <b>Abrir en ' + nav + '</b>.') +
      '</ul>' +
      '<div class="fp-abajo">' +
        '<button class="fp-boton" id="fp-copiar" type="button">Copiar el enlace</button>' +
        '<p class="fp-nota">También puedes pegarlo tú mismo en la barra de direcciones.</p>' +
      '</div>'
    );
    al('fp-copiar', function () {
      var b = lienzo.querySelector('#fp-copiar');
      var url = location.href;
      function ok() { b.textContent = 'Enlace copiado'; setTimeout(function () { b.textContent = 'Copiar el enlace'; }, 2200); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(ok, function () { b.textContent = url; });
      } else { b.textContent = url; }
    });
  }

  // ── 1 · Instalar ─────────────────────────────────────────────────────────

  function pantallaIOS() {
    pintar(
      cabecera('Guarda tu tarjeta',
        'Queda como una aplicación en tu pantalla de inicio. Se abre rápido y no ocupa espacio.',
        'Family Pet&rsquo;s') +
      '<ul class="fp-pasos fp-entra-3">' +
        paso(IC.puntos,    'Paso 1', 'Toca <b>los tres puntos</b>, abajo a la derecha.') +
        paso(IC.compartir, 'Paso 2', 'Elige <b>Compartir</b>.') +
        paso(IC.agregar,   'Paso 3', 'Baja y elige <b>Agregar a inicio</b>.') +
        paso(IC.abrir,     'Paso 4', 'Cierra Safari y <b>abre la tarjeta desde su ícono</b>. Aquí dentro no funciona.', true) +
      '</ul>' +
      '<div class="fp-abajo">' +
        '<p class="fp-nota">Si tu Safari muestra el ícono de compartir en la barra de abajo, tócalo directamente.</p>' +
        '<button class="fp-menor" id="fp-saltar" type="button">Ya la agregué</button>' +
      '</div>'
    );
    al('fp-saltar', saltarInstalacion);
  }

  function pantallaAndroid() {
    var conBoton = !!promptAndroid;
    pintar(
      cabecera('Guarda tu tarjeta',
        conBoton
          ? 'Queda como una aplicación en tu pantalla de inicio. Se abre rápido y no ocupa espacio.'
          : 'Queda como una aplicación en tu pantalla de inicio. Son dos toques en el menú del navegador.',
        'Family Pet&rsquo;s') +
      (conBoton ? '' :
        '<ul class="fp-pasos fp-entra-3">' +
          paso(IC.puntosV, 'Paso 1', 'Toca <b>el menú</b> de la esquina.') +
          paso(IC.agregar, 'Paso 2', 'Elige <b>Instalar aplicación</b>.') +
        '</ul>') +
      '<div class="fp-abajo">' +
        (conBoton ? '<button class="fp-boton" id="fp-instalar" type="button">Instalar la tarjeta</button>' : '') +
        '<p class="fp-nota">Cuando la instales, ábrela desde su ícono.</p>' +
        '<button class="fp-menor" id="fp-saltar" type="button">Ya la agregué</button>' +
      '</div>'
    );
    al('fp-instalar', function () {
      if (!promptAndroid) return;
      promptAndroid.prompt();
      promptAndroid.userChoice.then(function () { promptAndroid = null; });
    });
    al('fp-saltar', saltarInstalacion);
  }

  function pantallaEscritorio() {
    pintar(
      cabecera('Esto es para el teléfono',
        'La tarjeta se guarda en la pantalla de inicio de un celular. Desde el computador puedes verla igual, pero sin avisos.',
        'Family Pet&rsquo;s') +
      '<div class="fp-abajo">' +
        '<button class="fp-boton" id="fp-ver" type="button">Ver la tarjeta igual</button>' +
      '</div>'
    );
    al('fp-ver', function () { entregar(); });
  }

  // Solo para cuando la detección falle: la persona ya la tiene instalada y aun
  // así ve el tutorial. Deja pasar, pero no marca nada como instalado — en el
  // navegador los avisos siguen sin existir y no hay que fingir lo contrario.
  function saltarInstalacion() { entregar(); }

  // ── 2 y 3 · La campana ───────────────────────────────────────────────────

  function pantallaCampana(segunda) {
    pintar(
      '<div class="fp-centrado">' +
        '<div class="fp-campana fp-entra">' + IC.campana + '</div>' +
        '<h1 class="fp-titulo fp-entra-2">' + (segunda ? 'Una cosa más' : 'Entérate primero') + '</h1>' +
        '<p class="fp-bajada fp-entra-3">' +
          (segunda
            ? 'Tu tarjeta ya está lista. Activa los avisos para no perderte lo que viene.'
            : 'Activa los avisos y sabrás antes que nadie las novedades de Family Pet&rsquo;s.') +
        '</p>' +
        '<ul class="fp-lista fp-entra-3">' +
          '<li>' + IC.punto + '<span>Las novedades, antes que nadie.</span></li>' +
          '<li>' + IC.punto + '<span>Promociones y descuentos solo para socios.</span></li>' +
          '<li>' + IC.punto + '<span>Cuando tengas un premio listo.</span></li>' +
        '</ul>' +
      '</div>' +
      '<div class="fp-abajo">' +
        '<button class="fp-boton" id="fp-activar" type="button">Activar los avisos</button>' +
        '<button class="fp-boton-2" id="fp-luego" type="button">' + (segunda ? 'Más tarde' : 'Ahora no') + '</button>' +
        '<p class="fp-nota">Al activarlos aceptas recibir novedades de Family Pet&rsquo;s. Puedes apagarlos cuando quieras.</p>' +
      '</div>'
    );

    al('fp-activar', function () {
      var b = lienzo.querySelector('#fp-activar');
      b.disabled = true;
      pedirPermiso().then(function (r) {
        if (r === 'granted') { guardar(CLAVE.campana, 'activada'); pantallaLista(); }
        else if (r === 'denied') { guardar(CLAVE.campana, 'denegada'); pantallaAjustes(); }
        else { b.disabled = false; }
      });
    });

    al('fp-luego', function () {
      // Nada de cuadro del sistema: el permiso queda virgen para el segundo intento.
      guardar(CLAVE.campana, segunda ? 'ahora-no-2' : 'ahora-no');
      entregar();
    });
  }

  function pedirPermiso() {
    if (!hayAvisos) return Promise.resolve('unsupported');
    try {
      var r = Notification.requestPermission(function (res) { /* Safari viejo */ });
      return (r && r.then) ? r : new Promise(function (ok) {
        setTimeout(function () { ok(Notification.permission); }, 400);
      });
    } catch (e) { return Promise.resolve(Notification.permission); }
  }

  function pantallaLista() {
    pintar(
      '<div class="fp-centrado">' +
        '<div class="fp-campana fp-entra">' + IC.campana + '</div>' +
        '<h1 class="fp-titulo fp-entra-2">Avisos activados</h1>' +
        '<p class="fp-bajada fp-entra-3">Listo. Ahora sigamos con tu tarjeta.</p>' +
      '</div>' +
      '<div class="fp-abajo">' +
        '<button class="fp-boton" id="fp-seguir" type="button">Ver mi tarjeta</button>' +
      '</div>'
    );
    al('fp-seguir', function () { entregar(); });
  }

  function pantallaAjustes() {
    guardar(CLAVE.ajustes, '1');
    pintar(
      cabecera('Los avisos están apagados',
        'El teléfono ya no nos deja preguntarte otra vez. Si quieres activarlos, se hace desde los ajustes del teléfono.',
        'Se puede arreglar') +
      '<ul class="fp-pasos fp-entra-3">' +
        paso(IC.ajustes, 'Paso 1', 'Abre los <b>Ajustes</b> del teléfono.') +
        paso(IC.campana.replace('46', '21').replace('46', '21'), 'Paso 2', 'Busca <b>Family Pet&rsquo;s</b> y enciende las <b>Notificaciones</b>.') +
      '</ul>' +
      '<div class="fp-abajo">' +
        '<button class="fp-boton" id="fp-seguir" type="button">Seguir sin avisos</button>' +
      '</div>'
    );
    al('fp-seguir', function () { entregar(); });
  }

  // ── Entrega: se apaga la capa y aparece la tarjeta ───────────────────────

  function entregar() {
    if (capa) capa.hidden = true;
    if (entregada) return;
    entregada = true;
    vigilarInscripcion();
  }

  // El segundo intento de la campana. No hace falta tocar el diseño para saber
  // cuándo terminó la inscripción: cada pantalla suya lleva su nombre escrito
  // en el HTML, y "Mi tarjeta" es la que aparece al final.
  function vigilarInscripcion() {
    if (!hayAvisos || !estaInstalada()) return;
    if (permiso() !== 'default') return;
    if (leer(CLAVE.campana) !== 'ahora-no') return;

    var obs = new MutationObserver(function () {
      if (!document.querySelector('[data-screen-label="Mi tarjeta"]')) return;
      obs.disconnect();
      setTimeout(function () {
        if (permiso() === 'default') pantallaCampana(true);
      }, 1200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Arranque ─────────────────────────────────────────────────────────────

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    promptAndroid = e;
    if (capa && !capa.hidden && lienzo.querySelector('#fp-saltar') && !lienzo.querySelector('#fp-instalar')) {
      pantallaAndroid();
    }
  });

  window.addEventListener('appinstalled', function () { guardar(CLAVE.instalada, '1'); });

  function arrancar() {
    montar();

    var forzada = (location.search.match(/[?&]pantalla=([a-z0-9-]+)/i) || [])[1];
    if (forzada) {
      var mapa = {
        interno: pantallaInterno, ios: pantallaIOS, android: pantallaAndroid,
        escritorio: pantallaEscritorio, ajustes: pantallaAjustes, listo: pantallaLista,
        campana:  function () { pantallaCampana(false); },
        campana2: function () { pantallaCampana(true); }
      };
      if (mapa[forzada]) { mapa[forzada](); return; }
    }

    if (estaInstalada()) {
      guardar(CLAVE.instalada, '1');
      var p = permiso();
      var dicho = leer(CLAVE.campana);
      if (hayAvisos && p === 'default' && dicho !== 'ahora-no' && dicho !== 'ahora-no-2') pantallaCampana(false);
      else if (hayAvisos && p === 'denied' && !leer(CLAVE.ajustes)) pantallaAjustes();
      else entregar();
      return;
    }

    if (esInterno) { pantallaInterno(); return; }
    if (esIOS)     { pantallaIOS();    return; }
    if (esAndroid) { pantallaAndroid(); return; }
    pantallaEscritorio();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();

  // El trabajador de servicio es lo que deja abrir la tarjeta sin señal, y en
  // Android es requisito para que el navegador ofrezca instalarla. Si no está
  // (por ejemplo al abrir el archivo suelto), no pasa nada.
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      // updateViaCache 'none': GitHub sirve con 10 minutos de cache propia, y sin
      // esto el navegador podia quedarse con el trabajador viejo — que es justo el
      // que sigue entregando la version vieja de la pagina.
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {});
    });
  }
})();
