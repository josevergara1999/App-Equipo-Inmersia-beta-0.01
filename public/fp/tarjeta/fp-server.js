/* Conexión de la tarjeta con el servidor de fidelización (multiempresa: el programa sale de ?p=<slug>). */
(function () {
  var q = new URLSearchParams(location.search);
  var slug = (q.get('p') || '').replace(/[^a-z0-9-]/g, '') || localStorage.getItem('fp_slug') || 'family-pets';
  try { localStorage.setItem('fp_slug', slug); } catch (e) {}

  // El manifest se pide con la empresa, para que "instalar" abra SU tarjeta.
  var mf = document.querySelector('link[rel="manifest"]');
  if (mf) mf.href = './manifest.webmanifest?p=' + slug;

  var CRED = 'fp_cred_' + slug;
  function cred() { try { return JSON.parse(localStorage.getItem(CRED) || 'null'); } catch (e) { return null; } }
  function guardar(c) { try { localStorage.setItem(CRED, JSON.stringify(c)); } catch (e) {} }

  function api(path, body) {
    return fetch('/api/fp/' + slug + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || 'Error ' + r.status); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  function registrar(datos) {
    return api('/alta', datos).then(function (r) {
      guardar({ codigo: r.codigo, clave: r.clave, codigo6: r.codigo6, qrSeg: r.qrSeg || 120, meta: r.meta || 8 });
      return r;
    });
  }

  function estado() {
    var c = cred(); if (!c) return Promise.reject(new Error('sin tarjeta'));
    return api('/tarjeta', { codigo: c.codigo, clave: c.clave }).then(function (e) {
      c.qrSeg = e.qrSeg || c.qrSeg; c.meta = e.meta || c.meta; c.codigo6 = e.socio.codigo6 || c.codigo6; guardar(c);
      return e;
    });
  }

  function elegir(tarjeta) {
    var c = cred(); if (!c) return Promise.resolve();
    return api('/elegir', { codigo: c.codigo, clave: c.clave, tarjeta: tarjeta }).catch(function () {});
  }

  // QR que cambia solo: FP1.<codigo>.<ventana>.<firma>. La clave nunca viaja; el servidor
  // recalcula la firma con la que tiene guardada. Una foto del QR deja de servir en unos minutos.
  function ventana() { var c = cred(); return Math.floor(Date.now() / 1000 / ((c && c.qrSeg) || 120)); }
  function qrText() {
    var c = cred(); if (!c) return Promise.reject(new Error('sin tarjeta'));
    var t = ventana(), enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(c.clave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (k) { return crypto.subtle.sign('HMAC', k, enc.encode(c.codigo + '.' + t)); })
      .then(function (sig) {
        var hex = Array.prototype.map.call(new Uint8Array(sig), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        return 'FP1.' + c.codigo + '.' + t + '.' + hex.slice(0, 16);
      });
  }

  // Dibuja el QR en un canvas cuadrado con margen blanco.
  function qrCanvas(texto, px) {
    var qr = qrcode(0, 'M'); qr.addData(texto); qr.make();
    var n = qr.getModuleCount(), margen = 2, cel = Math.floor(px / (n + margen * 2));
    var tam = cel * (n + margen * 2), off = Math.floor((px - tam) / 2);
    var cv = document.createElement('canvas'); cv.width = px; cv.height = px;
    var x = cv.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, px, px);
    x.fillStyle = '#000000';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) x.fillRect(off + (c + margen) * cel, off + (r + margen) * cel, cel, cel);
    return cv;
  }

  window.FP = { slug: slug, cred: cred, api: api, registrar: registrar, estado: estado, elegir: elegir, qrText: qrText, qrCanvas: qrCanvas, ventana: ventana };
})();
