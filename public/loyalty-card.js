// ============================================================================
// TARJETA DE FIDELIZACIÓN — dibujo compartido por las páginas públicas
// ============================================================================
// Lo usan /unirse/:id y /tarjeta/:codigo. Es un port en JS plano del preview que vive dentro de
// la SPA (`LyPasePreview` en index.html): mismo layout de storeCard, mismos números.
//
// POR QUÉ ESTÁ DUPLICADO Y NO IMPORTADO
// El original está enterrado en un archivo de 650 KB que se transpila con Babel en el navegador.
// Importarlo obligaría a bajar todo eso para pintar una tarjeta. Se copia a propósito, y por eso
// las dos copias tienen que moverse juntas: **si cambia el layout del preview en index.html,
// cambia acá**. Lo que las mantiene honestas es que ambas imitan un formato que no es nuestro
// —el storeCard de Apple, que es fijo—, así que la deriva sería un error visible, no un gusto.
// ============================================================================

const LY = (() => {

  // Mientras alguien escribe un hex a mano pasan valores intermedios inválidos ("#", "#FF") y el
  // canvas LANZA con esos en addColorStop. Nunca se le pasa el valor crudo al canvas ni al CSS.
  const color = (c, fb) =>
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(c || "").trim()) ? String(c).trim() : fb;

  // ── La banda ──────────────────────────────────────────────────────────────
  // `strip.png` es 320×123 pt (960×369 @3x). En un storeCard es la única imagen grande que Apple
  // admite —no acepta fondo—, así que es el único lugar donde se puede diseñar de verdad.
  function dibujarStrip(ctx, e, w, h) {
    const c1 = color(e.c1, "#161B2A"), c2 = color(e.c2, "#6FE7F2"), preset = e.preset || "degradado";
    ctx.clearRect(0, 0, w, h);
    if (preset === "solido") { ctx.fillStyle = c1; }
    else {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.strokeStyle = "#fff"; ctx.fillStyle = "#fff";
    if (preset === "diagonal") {
      ctx.globalAlpha = .11; ctx.lineWidth = h * 0.055;
      for (let x = -h; x < w + h; x += h * 0.24) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
    } else if (preset === "puntos") {
      ctx.globalAlpha = .15;
      const paso = h * 0.17, r = h * 0.028;
      for (let y = paso / 2; y < h; y += paso) for (let x = paso / 2; x < w; x += paso) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    } else if (preset === "ondas") {
      ctx.globalAlpha = .13; ctx.lineWidth = h * 0.04;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += 6) {
          const y = h * (0.22 + i * 0.2) + Math.sin((x / w) * Math.PI * 3 + i) * h * 0.085;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function stripEl(p) {
    if (p.strip_url) {
      const img = document.createElement("img");
      img.src = p.strip_url; img.alt = "";
      img.style.cssText = "width:100%;aspect-ratio:960/369;object-fit:cover;display:block";
      return img;
    }
    const c = document.createElement("canvas");
    c.width = 960; c.height = 369;
    c.style.cssText = "width:100%;aspect-ratio:960/369;display:block";
    try { dibujarStrip(c.getContext("2d"), p.strip_estilo || {}, 960, 369); } catch (_) {}
    return c;
  }

  // ── El QR ─────────────────────────────────────────────────────────────────
  // qrcodejs desde CDN, igual que la app. Si no carga —local sin wifi, CDN bloqueado— el
  // respaldo NO es un hueco: es el código en grande, que el mesón puede teclear a mano en el
  // escáner. La tarjeta sigue sirviendo aunque el dibujo falle.
  const QR_LIB = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
  let _qrLib = null;
  function cargarQR() {
    if (_qrLib) return _qrLib;
    _qrLib = new Promise((ok, err) => {
      const s = document.createElement("script");
      s.src = QR_LIB; s.async = true;
      s.onload = ok; s.onerror = () => err(new Error("QR"));
      document.head.appendChild(s);
    });
    return _qrLib;
  }

  function qrEl(texto, size) {
    const caja = document.createElement("div");
    caja.style.cssText = "display:inline-block;line-height:0;min-height:" + size + "px";
    cargarQR().then(() => {
      if (!window.QRCode) throw new Error("QR");
      caja.innerHTML = "";
      new window.QRCode(caja, {
        text: texto || "—", width: size, height: size,
        colorDark: "#05060B", colorLight: "#FFFFFF",
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    }).catch(() => {
      caja.style.lineHeight = "1.3";
      caja.innerHTML = '<div style="font:600 13px var(--mono);color:#555;padding:' +
        Math.round(size / 3) + 'px 0;letter-spacing:.18em">' + (texto || "—") + "</div>";
    });
    return caja;
  }

  // ── La tarjeta ────────────────────────────────────────────────────────────
  // Layout REAL de un storeCard de Apple, que es fijo: logo y marca arriba, strip, campos,
  // código. No se puede reordenar nada — por eso este dibujo vale: es lo que Wallet va a
  // mostrar cuando se firme el .pkpass, sin sorpresas.
  function tarjeta(p, opts) {
    const o = opts || {};
    const meta = Math.max(1, parseInt(p.meta, 10) || 10);
    const saldo = Math.max(0, parseInt(o.saldo, 10) || 0);
    const bg = color(p.color_fondo, "#05060B");
    const fg = color(p.color_texto, "#FFFFFF");
    const lb = color(p.color_etiqueta, "#8E93A6");
    const llenos = Math.min(saldo, meta);

    const el = document.createElement("div");
    el.style.cssText = "width:100%;max-width:320px;border-radius:18px;overflow:hidden;" +
      "background:" + bg + ";color:" + fg + ";box-shadow:0 22px 48px rgba(0,0,0,.62);" +
      "border:1px solid rgba(255,255,255,.09)";

    // Cabecera
    const cab = document.createElement("div");
    cab.style.cssText = "display:flex;align-items:center;gap:9px;padding:12px 14px 10px";
    if (p.logo_url) {
      const l = document.createElement("img");
      l.src = p.logo_url; l.alt = "";
      l.style.cssText = "height:26px;max-width:104px;object-fit:contain";
      cab.appendChild(l);
    } else {
      const l = document.createElement("div");
      l.textContent = "◎";
      l.style.cssText = "height:26px;width:26px;border-radius:8px;background:rgba(255,255,255,.13);" +
        "display:flex;align-items:center;justify-content:center;font-size:12px;color:" + lb;
      cab.appendChild(l);
    }
    const marca = document.createElement("div");
    marca.textContent = p.logo_text || p.nombre || "";
    marca.style.cssText = "flex:1;text-align:right;font-size:11px;font-weight:600;letter-spacing:.02em;" +
      "opacity:.93;overflow:hidden;white-space:nowrap;text-overflow:ellipsis";
    cab.appendChild(marca);
    el.appendChild(cab);

    el.appendChild(stripEl(p));

    // Campos: sellos a la izquierda, premio a la derecha
    const campos = document.createElement("div");
    campos.style.cssText = "display:flex;gap:12px;padding:12px 14px 10px;align-items:flex-start";

    const izq = document.createElement("div");
    izq.style.cssText = "flex:1;min-width:0";
    izq.appendChild(etiqueta(p.tipo === "puntos" ? "Puntos" : "Sellos", lb));
    if (p.tipo === "puntos") {
      const n = document.createElement("div");
      n.textContent = saldo + " / " + meta;
      n.style.cssText = "font:600 17px var(--mono);letter-spacing:.02em";
      izq.appendChild(n);
    } else {
      const fila = document.createElement("div");
      fila.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
      for (let i = 0; i < meta; i++) {
        const s = document.createElement("span");
        const lleno = i < llenos;
        s.style.cssText = "width:9px;height:9px;border-radius:50%;display:inline-block;" +
          "background:" + (lleno ? fg : "transparent") + ";border:1px solid " + (lleno ? fg : lb) +
          ";opacity:" + (lleno ? 1 : .65);
        fila.appendChild(s);
      }
      izq.appendChild(fila);
    }
    campos.appendChild(izq);

    const der = document.createElement("div");
    der.style.cssText = "text-align:right;max-width:124px";
    der.appendChild(etiqueta("Premio", lb));
    const premio = document.createElement("div");
    premio.textContent = p.premio || "—";
    premio.style.cssText = "font-size:12.5px;font-weight:600;line-height:1.25";
    der.appendChild(premio);
    campos.appendChild(der);
    el.appendChild(campos);

    // El código. En la página de alta todavía no hay socio: ahí se muestra el hueco en blanco
    // igual, porque es la parte que la persona va a reconocer después como "su" tarjeta.
    const zona = document.createElement("div");
    zona.style.cssText = "background:#fff;margin:3px 14px 14px;border-radius:10px;" +
      "padding:10px 10px 6px;text-align:center;min-height:96px";
    if (o.codigo) {
      zona.appendChild(qrEl(o.codigo, 96));
      const txt = document.createElement("div");
      txt.textContent = o.codigo;
      txt.style.cssText = "font:500 9px var(--mono);color:#555;letter-spacing:.14em;margin-top:4px";
      zona.appendChild(txt);
    } else {
      const ph = document.createElement("div");
      ph.textContent = o.placeholder || "Tu código aparece aquí";
      ph.style.cssText = "font-size:10.5px;color:#9AA0AC;padding:38px 8px 34px;letter-spacing:.04em";
      zona.appendChild(ph);
    }
    el.appendChild(zona);

    return el;
  }

  function etiqueta(txt, lb) {
    const e = document.createElement("div");
    e.textContent = txt;
    e.style.cssText = "font-size:8.5px;letter-spacing:.11em;text-transform:uppercase;color:" + lb + ";margin-bottom:6px";
    return e;
  }

  // ── El fondo de la página ─────────────────────────────────────────────────
  // La página se tiñe con los colores del programa, no con los de INMERSIA: quien la abre es
  // cliente de la marca del cliente y no tiene por qué saber quién hizo el sistema.
  function fondo(p) {
    const bg = color(p && p.color_fondo, "#05060B");
    const ac = color(p && p.strip_estilo && p.strip_estilo.c2, "#6FE7F2");
    document.body.style.background =
      "radial-gradient(120% 70% at 50% 0%, " + ac + "1F 0%, transparent 62%), " + bg;
  }

  const escapar = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  return { color, dibujarStrip, stripEl, qrEl, tarjeta, fondo, escapar };
})();
