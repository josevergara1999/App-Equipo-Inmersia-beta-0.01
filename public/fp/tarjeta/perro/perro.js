/* ============================================================================
   "PON A TU PERRO" — PRUEBA
   ============================================================================
   El cliente elige una tarjeta con el perro de muestra y después, en su casa,
   sube la foto de SU perro. Se le quita el fondo en el mismo celular y se pone
   en el lugar donde estaba el perro de muestra de cada tarjeta.

   - assets/fp-bg-N.jpg  = la tarjeta N sin perro (el fondo se rellenó aparte).
   - ZONAS[N]            = donde estaba el perro de muestra [x0, y0, x1, y1]
                           sobre la tarjeta de 750x1224.
   - El resultado se guarda como imagen en localStorage ('fp_card_N') y la app
     lo lee al arrancar a través de window.fpCardImg(N). Si no hay foto, usa la
     tarjeta original con el perro de muestra.

   Quitar el fondo: @imgly/background-removal (corre en el navegador, sin
   servidor). OJO: su licencia es AGPL; para uso comercial hay que revisarla o
   cambiarla por otro modelo.
   ========================================================================== */
(function () {
  var W = 750, H = 1224;
  var ZONAS = {
    1: [0, 494, 610, 1224],
    2: [32, 460, 569, 1204],
    3: [30, 549, 710, 1224],
    4: [259, 542, 711, 1220]
  };
  var LIB = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // La app lo llama al armar las tarjetas (antes de que exista la pantalla).
  window.fpCardImg = function (n) {
    return get('fp_card_' + n) || 'assets/fp-card-' + n + '.png';
  };

  var estado = { cut: null, scale: 1, urls: {} };

  function cargarImg(src) {
    return new Promise(function (ok, no) {
      var im = new Image();
      im.onload = function () { ok(im); };
      im.onerror = no;
      im.src = src;
    });
  }

  // Recorta el PNG transparente a la caja real del perro.
  function recortar(img) {
    var c = document.createElement('canvas');
    var s = Math.min(1, 900 / Math.max(img.width, img.height));
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    var x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
    var d = x.getImageData(0, 0, c.width, c.height).data;
    var x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (var y = 0; y < c.height; y++) for (var xx = 0; xx < c.width; xx++) {
      if (d[(y * c.width + xx) * 4 + 3] > 24) {
        if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 <= x0 || y1 <= y0) return null;
    var o = document.createElement('canvas');
    o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
    o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    return o;
  }

  // Dibuja el perro del cliente en la zona de la tarjeta N.
  function componer(n, fondo, cut, escala) {
    var z = ZONAS[n], zw = z[2] - z[0], zh = z[3] - z[1];
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.drawImage(fondo, 0, 0, W, H);
    var s = Math.min(zw / cut.width, zh / cut.height) * escala;
    var w = cut.width * s, h = cut.height * s;
    var px = z[0] + (zw - w) / 2, py = z[3] - h; // pegado al piso de la zona
    x.save();
    x.shadowColor = 'rgba(0,0,40,.28)'; x.shadowBlur = 26; x.shadowOffsetY = 10;
    x.drawImage(cut, px, py, w, h);
    x.restore();
    return c;
  }

  var css = '' +
    '#fp-pp-btn{position:fixed;left:12px;bottom:12px;z-index:8000;border:0;border-radius:999px;padding:11px 16px;font:600 14px Outfit,system-ui,sans-serif;color:#fff;background:#00008b;box-shadow:0 6px 18px rgba(0,0,80,.35);cursor:pointer}' +
    '#fp-pp{position:fixed;inset:0;z-index:9500;background:rgba(10,10,60,.78);display:none;align-items:center;justify-content:center;font-family:Outfit,system-ui,sans-serif}' +
    '#fp-pp.on{display:flex}' +
    '#fp-pp .box{background:#f4f4ff;color:#14145e;width:min(94vw,520px);max-height:94vh;overflow:auto;border-radius:20px;padding:18px 16px 16px}' +
    '#fp-pp h2{margin:0 0 4px;font:700 20px "Baloo 2",Outfit,sans-serif}' +
    '#fp-pp p{margin:0 0 12px;font-size:13px;color:#4a4f8a;line-height:1.45}' +
    '#fp-pp .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}' +
    '#fp-pp button.b{flex:1;min-width:120px;border:0;border-radius:12px;padding:12px;font:600 14px Outfit,sans-serif;cursor:pointer;background:#00008b;color:#fff}' +
    '#fp-pp button.b.g{background:#dcdcf5;color:#14145e}' +
    '#fp-pp button.b[disabled]{opacity:.45}' +
    '#fp-pp .tira{display:flex;gap:10px;overflow-x:auto;padding:4px 2px 8px;scroll-snap-type:x mandatory}' +
    '#fp-pp .tira img{height:300px;border-radius:12px;scroll-snap-align:center;box-shadow:0 6px 16px rgba(0,0,70,.25);flex:none}' +
    '#fp-pp .est{font-size:13px;margin:8px 0;min-height:18px;font-weight:500}' +
    '#fp-pp input[type=range]{width:100%}';

  function ui() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var btn = document.createElement('button'); btn.id = 'fp-pp-btn'; btn.textContent = '🐶 Pon a tu perro';
    var ov = document.createElement('div'); ov.id = 'fp-pp';
    ov.innerHTML =
      '<div class="box"><h2>Pon a tu perro en la tarjeta</h2>' +
      '<p>Elige una foto de tu perro (mejor de cuerpo entero y con buena luz). Le quitamos el fondo y lo ponemos en el mismo lugar del perro de muestra.</p>' +
      '<input id="fp-file" type="file" accept="image/*" style="display:none">' +
      '<div class="est" id="fp-est"></div>' +
      '<div class="tira" id="fp-tira"></div>' +
      '<div id="fp-ctl" style="display:none"><label style="font-size:12px">Tamaño del perro</label><input id="fp-esc" type="range" min="70" max="115" value="100"></div>' +
      '<div class="row"><button class="b" id="fp-elegir">📷 Elegir foto</button>' +
      '<button class="b" id="fp-usar" disabled>Usar en mis tarjetas</button></div>' +
      '<div class="row"><button class="b g" id="fp-reset">Volver a los de muestra</button>' +
      '<button class="b g" id="fp-cerrar">Cerrar</button></div></div>';
    document.body.appendChild(btn); document.body.appendChild(ov);

    var $ = function (id) { return document.getElementById(id); };
    var fondos = null;

    function msg(t, mal) { var e = $('fp-est'); e.textContent = t || ''; e.style.color = mal ? '#b3261e' : '#14145e'; }

    function pintar() {
      if (!estado.cut || !fondos) return;
      var t = $('fp-tira'); t.innerHTML = '';
      estado.res = {};
      [1, 2, 3, 4].forEach(function (n) {
        var c = componer(n, fondos[n], estado.cut, estado.scale);
        var u = c.toDataURL('image/jpeg', 0.88);
        estado.res[n] = u;
        var im = new Image(); im.src = u; t.appendChild(im);
      });
    }

    function abrir() {
      ov.classList.add('on'); msg('');
      if (!fondos) {
        fondos = {};
        Promise.all([1, 2, 3, 4].map(function (n) {
          return cargarImg('assets/fp-bg-' + n + '.jpg').then(function (im) { fondos[n] = im; });
        })).catch(function () { msg('No pude cargar las tarjetas base.', true); });
      }
    }
    btn.onclick = abrir;
    $('fp-cerrar').onclick = function () { ov.classList.remove('on'); };
    $('fp-elegir').onclick = function () { $('fp-file').click(); };
    $('fp-esc').oninput = function () { estado.scale = this.value / 100; pintar(); };

    $('fp-file').onchange = function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      $('fp-usar').disabled = true;
      msg('Quitando el fondo… la primera vez baja el modelo (unas decenas de MB) y puede tardar un rato.');
      import(LIB).then(function (m) {
        var rb = m.removeBackground || (m.default && m.default.removeBackground) || m.default;
        return rb(f, {
          progress: function (key, cur, tot) {
            if (tot) msg('Descargando modelo… ' + Math.round(cur / tot * 100) + '%');
          }
        });
      }).then(function (blob) {
        return cargarImg(URL.createObjectURL(blob));
      }).then(function (im) {
        var cut = recortar(im);
        if (!cut) throw new Error('No encontré al perro en la foto.');
        estado.cut = cut; estado.scale = 1; $('fp-esc').value = 100;
        $('fp-ctl').style.display = 'block';
        return (fondos ? Promise.resolve() : new Promise(function (r) { setTimeout(r, 800); })).then(function () {
          pintar(); $('fp-usar').disabled = false;
          msg('Así queda en cada tarjeta. Desliza para verlas.');
        });
      }).catch(function (e) {
        msg('No se pudo quitar el fondo: ' + (e && e.message || e), true);
      });
    };

    $('fp-usar').onclick = function () {
      try {
        [1, 2, 3, 4].forEach(function (n) { localStorage.setItem('fp_card_' + n, estado.res[n]); });
      } catch (e) { msg('No hay espacio para guardar la foto en este celular.', true); return; }
      location.reload();
    };
    $('fp-reset').onclick = function () {
      [1, 2, 3, 4].forEach(function (n) { try { localStorage.removeItem('fp_card_' + n); } catch (e) {} });
      location.reload();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui); else ui();
})();
