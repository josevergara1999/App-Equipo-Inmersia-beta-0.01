// ============================================================================
// FIDELIZACIÓN v2: tarjeta del cliente, escáner del mesón y administración.
// Multiempresa: todo se resuelve por `slug` del programa, nada está fijo en el código.
// Esquema: db/fp_loyalty.sql (correr DESPUÉS de db/loyalty.sql).
//
// TRES CARAS, TRES MODOS DE ACCESO (a propósito distintos):
//  · Cliente final: público. Se identifica con `codigo` + `clave` (secreto del programa de su
//    cel). Con la clave firma un QR que cambia solo.
//  · Cajero: PIN de 6 dígitos → cookie PROPIA `_fpcaja`. No es la sesión de Inmersia (`_iauth`):
//    no puede leer ni escribir nada de la app, solo sellar, canjear y usar cupones de SU programa.
//  · Administración: la sesión normal de Inmersia. Un usuario de portal queda limitado a SU
//    empresa (empresaDeLaSesion); el equipo puede elegir cualquiera.
// ============================================================================
const crypto = require("crypto");

module.exports = function montarFidelizacionFP({ app, lyRest, lyUno, rateLimit, requireAuth, authInfo, clienteDe, empresaDeLaSesion, parseCookies, JWT_SECRET }) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
  const enc = encodeURIComponent;
  const idem = (s) => (typeof s === "string" && /^[\w.:-]{8,80}$/.test(s)) ? s : null;

  // Campos del programa que ve cualquiera (nada de company_id ni conteos).
  const PUB = "id,slug,nombre,tipo,meta,premio,activo,color_fondo,color_texto,color_etiqueta,logo_url,logo_text," +
              "min_horas,qr_segundos,bienvenida_activa,bienvenida_texto,sorteo_activo,sorteo_texto,tarjetas";

  const progPorSlug = async (slug) => {
    if (!SLUG.test(String(slug || ""))) return null;
    return lyUno(await lyRest(`loyalty_programs?slug=eq.${enc(slug)}&select=${PUB}&limit=1`));
  };

  const iguales = (a, b) => {
    const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  // ── QR rotativo ───────────────────────────────────────────────────────────
  // FP1.<codigo>.<t>.<firma>, con t = ventana de `qr_segundos` y firma = HMAC(clave del socio).
  // Una foto del QR sirve unos minutos y después no. La clave nunca viaja en el QR.
  const firmaQR = (clave, codigo, t) =>
    crypto.createHmac("sha256", clave).update(codigo + "." + t).digest("hex").slice(0, 16);

  function leerQR(texto, prog, socio) {
    const p = String(texto || "").trim().split(".");
    if (p.length !== 4 || p[0] !== "FP1") return false;
    const ahora = Math.floor(Date.now() / 1000 / (prog.qr_segundos || 120));
    const t = parseInt(p[2], 10);
    if (!Number.isFinite(t) || t > ahora + 1 || t < ahora - 1) return "vencido";
    return iguales(firmaQR(socio.qr_clave, socio.codigo, t), p[3]) ? true : false;
  }

  // Del cuerpo de una petición del cajero saca al socio: por QR o por código de 6 dígitos.
  async function resolverSocio(prog, body) {
    const sel = "id,codigo,codigo6,nombre,saldo,canjes,qr_clave,ultimo_sello,created_at,tarjeta,program_id";
    if (body.qr) {
      const cod = String(body.qr).split(".")[1] || "";
      const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${prog.id}&codigo=eq.${enc(cod)}&select=${sel}&limit=1`));
      if (!m) return { error: "Tarjeta no encontrada", status: 404 };
      const ok = leerQR(body.qr, prog, m);
      if (ok === "vencido") return { error: "El QR venció. Pídele al cliente que lo actualice", status: 400 };
      if (!ok) return { error: "QR no válido", status: 400 };
      return { m };
    }
    const c6 = String(body.codigo6 || "").replace(/\D/g, "");
    if (c6.length !== 6) return { error: "Escribe los 6 dígitos", status: 400 };
    const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${prog.id}&codigo6=eq.${c6}&select=${sel}&limit=1`));
    if (!m) return { error: "No hay ninguna tarjeta con ese código", status: 404 };
    return { m };
  }

  async function estadoSocio(prog, m) {
    const cupon = lyUno(await lyRest(`loyalty_coupons?member_id=eq.${m.id}&tipo=eq.bienvenida&select=id,estado,descripcion&limit=1`));
    let faltanMin = 0;
    if (m.ultimo_sello) {
      faltanMin = Math.max(0, Math.ceil((new Date(m.ultimo_sello).getTime() + prog.min_horas * 3600000 - Date.now()) / 60000));
    }
    return {
      socio: { nombre: m.nombre, saldo: m.saldo, canjes: m.canjes, codigo6: m.codigo6 },
      meta: prog.meta, premio: prog.premio,
      puedeSellar: faltanMin === 0, faltanMin,
      puedeCanjear: m.saldo >= prog.meta,
      cupon: cupon ? { id: cupon.id, estado: cupon.estado, descripcion: cupon.descripcion } : null,
    };
  }

  // ===========================================================================
  // CLIENTE (público)
  // ===========================================================================
  app.get("/api/fp/:slug/programa", rateLimit(60, "fp-prog"), async (req, res) => {
    try {
      const p = await progPorSlug(req.params.slug);
      if (!p || !p.activo) return res.status(404).json({ error: "Programa no disponible" });
      res.json(p);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Alta. Devuelve `clave` UNA vez: es lo que firma el QR y vive solo en el cel del cliente.
  // Si el teléfono o el correo ya existen NO se devuelve la clave (cualquiera que conociera un
  // correo se quedaría con la tarjeta de otro): se responde 409.
  app.post("/api/fp/:slug/alta", rateLimit(15, "fp-alta"), async (req, res) => {
    try {
      const p = await progPorSlug(req.params.slug);
      if (!p || !p.activo) return res.status(404).json({ error: "Programa no disponible" });
      const b = req.body || {};
      const nombre = String(b.nombre || "").trim().slice(0, 80);
      const telefono = String(b.telefono || "").replace(/[^\d+]/g, "").slice(0, 16);
      // Solo caracteres normales de un correo: el valor entra en un filtro de PostgREST.
      const emailRaw = String(b.email || "").trim().toLowerCase().slice(0, 120);
      const email = /^[\w.+-]+@[\w.-]+\.\w{2,}$/.test(emailRaw) ? emailRaw : "";
      if (!nombre) return res.status(400).json({ error: "Escribe tu nombre" });
      if (telefono.length < 8 && !email.includes("@")) return res.status(400).json({ error: "Escribe un teléfono o un correo" });

      const filtros = [];
      if (telefono.length >= 8) filtros.push(`telefono.eq.${enc(telefono)}`);
      if (email.includes("@")) filtros.push(`email.eq.${enc(email)}`);
      const ya = lyUno(await lyRest(`loyalty_members?program_id=eq.${p.id}&or=(${filtros.join(",")})&select=id&limit=1`));
      if (ya) return res.status(409).json({ error: "Ya tienes una tarjeta con ese dato. Ábrela desde el teléfono donde la instalaste" });

      const tarjeta = (p.tarjetas || []).some(t => t.id === b.tarjeta) ? b.tarjeta : null;
      let socio = null;
      for (let i = 0; i < 6 && !socio; i++) {
        try {
          socio = lyUno(await lyRest("loyalty_members", {
            method: "POST", headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              program_id: p.id, codigo: "FP" + crypto.randomBytes(6).toString("hex").toUpperCase(),
              codigo6: String(crypto.randomInt(0, 1000000)).padStart(6, "0"),
              qr_clave: crypto.randomBytes(24).toString("hex"),
              nombre, telefono: telefono || null, email: email || null, tarjeta,
            }),
          }));
        } catch (e) { if (!/duplicate|23505/i.test(e.message)) throw e; }   // choque de código: reintenta
      }
      if (!socio) return res.status(500).json({ error: "No se pudo crear la tarjeta, intenta de nuevo" });

      await lyRest("loyalty_events", { method: "POST", body: JSON.stringify({ member_id: socio.id, tipo: "alta", cantidad: 0, saldo_despues: 0 }) });
      if (p.bienvenida_activa) {
        await lyRest("loyalty_coupons", { method: "POST", body: JSON.stringify({ member_id: socio.id, tipo: "bienvenida", descripcion: p.bienvenida_texto || "Descuento de bienvenida" }) });
      }
      res.json({ codigo: socio.codigo, clave: socio.qr_clave, codigo6: socio.codigo6 });
    } catch (e) { console.error("fp alta:", e.message); res.status(500).json({ error: "No se pudo crear la tarjeta" }); }
  });

  // Estado de la tarjeta, autenticado con codigo + clave.
  app.post("/api/fp/:slug/tarjeta", rateLimit(60, "fp-tarjeta"), async (req, res) => {
    try {
      const p = await progPorSlug(req.params.slug);
      if (!p) return res.status(404).json({ error: "Programa no disponible" });
      const { codigo, clave } = req.body || {};
      const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${p.id}&codigo=eq.${enc(String(codigo || ""))}&select=id,codigo,codigo6,nombre,saldo,canjes,qr_clave,ultimo_sello,tarjeta,sorteo_ok,program_id&limit=1`));
      if (!m || !iguales(m.qr_clave, clave)) return res.status(401).json({ error: "Tarjeta no válida en este teléfono" });
      const est = await estadoSocio(p, m);
      res.json({ ...est, tarjeta: m.tarjeta, sorteo: !!p.sorteo_activo && m.sorteo_ok });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/fp/:slug/elegir", rateLimit(30, "fp-elegir"), async (req, res) => {
    try {
      const p = await progPorSlug(req.params.slug);
      if (!p) return res.status(404).json({ error: "Programa no disponible" });
      const { codigo, clave, tarjeta } = req.body || {};
      const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${p.id}&codigo=eq.${enc(String(codigo || ""))}&select=id,qr_clave&limit=1`));
      if (!m || !iguales(m.qr_clave, clave)) return res.status(401).json({ error: "Tarjeta no válida en este teléfono" });
      if (!(p.tarjetas || []).some(t => t.id === tarjeta)) return res.status(400).json({ error: "Diseño desconocido" });
      await lyRest(`loyalty_members?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ tarjeta }) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===========================================================================
  // CAJERO
  // ===========================================================================
  const CAJA_COOKIE = "_fpcaja";
  const firmaCaja = (payload) => crypto.createHmac("sha256", JWT_SECRET + "|fp-caja").update(payload).digest("base64url");
  const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString("hex");

  function emitirCaja(req, res, cajero) {
    const payload = Buffer.from(JSON.stringify({ c: cajero.id, p: cajero.program_id, exp: Date.now() + 14 * 24 * 3600000 })).toString("base64url");
    const https = req.headers["x-forwarded-proto"] === "https" || req.secure;
    res.cookie(CAJA_COOKIE, payload + "." + firmaCaja(payload), { httpOnly: true, secure: https, sameSite: "lax", maxAge: 14 * 24 * 3600000 });
  }

  // Cada petición vuelve a mirar en la base que el cajero siga activo: dar de baja a alguien corta
  // su sesión al instante, sin esperar a que venza la cookie.
  async function cajaAuth(req, res, next) {
    try {
      const raw = parseCookies(req)[CAJA_COOKIE] || "";
      const i = raw.lastIndexOf(".");
      const payload = raw.slice(0, i), sig = raw.slice(i + 1);
      if (i < 1 || !iguales(sig, firmaCaja(payload))) return res.status(401).json({ error: "Entra con tu PIN" });
      const d = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (!d.exp || d.exp < Date.now() || !UUID.test(d.c || "")) return res.status(401).json({ error: "Entra con tu PIN" });
      const c = lyUno(await lyRest(`loyalty_cashiers?id=eq.${d.c}&activo=eq.true&select=id,nombre,program_id&limit=1`));
      if (!c || c.program_id !== d.p) return res.status(401).json({ error: "Entra con tu PIN" });
      const prog = lyUno(await lyRest(`loyalty_programs?id=eq.${c.program_id}&select=${PUB}&limit=1`));
      if (!prog || !prog.activo) return res.status(403).json({ error: "El programa está pausado" });
      req.cajero = c; req.prog = prog;
      next();
    } catch (e) { res.status(401).json({ error: "Entra con tu PIN" }); }
  }

  app.post("/api/fp/:slug/caja/login", rateLimit(10, "fp-pin"), async (req, res) => {
    try {
      const p = await progPorSlug(req.params.slug);
      const pin = String(req.body?.pin || "").replace(/\D/g, "");
      if (!p || !p.activo || pin.length !== 6) return res.status(401).json({ error: "PIN incorrecto" });
      const lista = await lyRest(`loyalty_cashiers?program_id=eq.${p.id}&activo=eq.true&select=id,nombre,program_id,pin_salt,pin_hash`);
      const c = lista.find(x => iguales(x.pin_hash, hashPin(pin, x.pin_salt)));
      if (!c) return res.status(401).json({ error: "PIN incorrecto" });
      emitirCaja(req, res, c);
      lyRest(`loyalty_cashiers?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify({ ultimo_login: new Date().toISOString() }) }).catch(() => {});
      res.json({ ok: true, cajero: c.nombre, programa: p.nombre });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/fp/caja/salir", (req, res) => { res.clearCookie(CAJA_COOKIE); res.json({ ok: true }); });
  app.get("/api/fp/caja/yo", cajaAuth, (req, res) => res.json({ cajero: req.cajero.nombre, programa: req.prog.nombre, meta: req.prog.meta, premio: req.prog.premio }));

  // Mira a quién tiene delante (QR o código de 6 dígitos): saldo, cupón y si puede sellar.
  app.post("/api/fp/caja/buscar", rateLimit(80, "fp-caja"), cajaAuth, async (req, res) => {
    try {
      const r = await resolverSocio(req.prog, req.body || {});
      if (r.error) return res.status(r.status).json({ error: r.error });
      res.json(await estadoSocio(req.prog, r.m));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const rpcSocio = (fn, armar) => async (req, res) => {
    try {
      const b = req.body || {};
      const r = await resolverSocio(req.prog, b);
      if (r.error) return res.status(r.status).json({ error: r.error });
      const out = await lyRest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(armar(r.m, req, idem(b.idem), b)) });
      const est = await estadoSocio(req.prog, lyUno(await lyRest(`loyalty_members?id=eq.${r.m.id}&select=id,codigo,codigo6,nombre,saldo,canjes,qr_clave,ultimo_sello,tarjeta,program_id&limit=1`)));
      res.json({ ...out, estado: est });
    } catch (e) { console.error(fn + ":", e.message); res.status(500).json({ error: "No se pudo completar, intenta de nuevo" }); }
  };
  app.post("/api/fp/caja/sellar",  rateLimit(80, "fp-caja"), cajaAuth, rpcSocio("fp_sellar",         (m, req, k) => ({ p_member: m.id, p_cashier: req.cajero.id, p_idem: k })));
  app.post("/api/fp/caja/canjear", rateLimit(80, "fp-caja"), cajaAuth, rpcSocio("fp_canjear_premio", (m, req, k) => ({ p_member: m.id, p_cashier: req.cajero.id, p_idem: k })));

  // Usar el cupón de bienvenida: se busca el cupón del socio ya identificado, no se acepta un id suelto.
  app.post("/api/fp/caja/cupon", rateLimit(80, "fp-caja"), cajaAuth, async (req, res) => {
    try {
      const r = await resolverSocio(req.prog, req.body || {});
      if (r.error) return res.status(r.status).json({ error: r.error });
      const cu = lyUno(await lyRest(`loyalty_coupons?member_id=eq.${r.m.id}&tipo=eq.bienvenida&select=id&limit=1`));
      if (!cu) return res.status(404).json({ error: "Este cliente no tiene cupón" });
      const out = await lyRest("rpc/fp_usar_cupon", { method: "POST", body: JSON.stringify({ p_cupon: cu.id, p_cashier: req.cajero.id }) });
      res.json({ ...out, estado: await estadoSocio(req.prog, r.m) });
    } catch (e) { res.status(500).json({ error: "No se pudo completar, intenta de nuevo" }); }
  });

  // ===========================================================================
  // ADMINISTRACIÓN (sesión de Inmersia; un usuario de portal queda en SU empresa)
  // ===========================================================================
  const esEquipo = (req) => !clienteDe(authInfo(req));

  // Programa de la empresa de la sesión. Devuelve null (ya respondió) si no corresponde.
  async function progAdmin(req, res) {
    const cid = await empresaDeLaSesion(req, res, req.query.companyId || req.body?.companyId);
    if (cid === null) return null;
    if (!cid) { res.status(400).json({ error: "Falta la empresa" }); return null; }
    const p = lyUno(await lyRest(`loyalty_programs?company_id=eq.${enc(cid)}&slug=not.is.null&select=*&limit=1`));
    return { cid, p };
  }

  app.get("/api/fp/admin/programa", requireAuth, async (req, res) => {
    try {
      const r = await progAdmin(req, res); if (!r) return;
      res.json({ programa: r.p, companyId: r.cid, puedeCrear: esEquipo(req) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Crear (solo equipo) o editar (equipo o la empresa dueña). Lista blanca de campos.
  app.post("/api/fp/admin/programa", requireAuth, async (req, res) => {
    try {
      const r = await progAdmin(req, res); if (!r) return;
      const b = req.body || {};
      const num = (v, min, max, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
      const campos = {
        nombre: b.nombre, premio: b.premio,
        meta: b.meta !== undefined ? num(b.meta, 1, 50, 8) : undefined,
        min_horas: b.min_horas !== undefined ? num(b.min_horas, 0, 168, 12) : undefined,
        qr_segundos: b.qr_segundos !== undefined ? num(b.qr_segundos, 30, 900, 120) : undefined,
        bienvenida_activa: typeof b.bienvenida_activa === "boolean" ? b.bienvenida_activa : undefined,
        bienvenida_texto: b.bienvenida_texto, sorteo_activo: typeof b.sorteo_activo === "boolean" ? b.sorteo_activo : undefined,
        sorteo_texto: b.sorteo_texto, activo: typeof b.activo === "boolean" ? b.activo : undefined,
        color_fondo: b.color_fondo, color_texto: b.color_texto, logo_url: b.logo_url, logo_text: b.logo_text,
        tarjetas: Array.isArray(b.tarjetas) ? b.tarjetas.slice(0, 12).map(t => ({ id: String(t.id || "").slice(0, 30), nombre: String(t.nombre || "").slice(0, 40), img: String(t.img || "").slice(0, 400), claro: !!t.claro })).filter(t => t.id && t.img) : undefined,
      };
      Object.keys(campos).forEach(k => campos[k] === undefined && delete campos[k]);
      campos.updated_at = new Date().toISOString();
      if (r.p) {
        const d = await lyRest(`loyalty_programs?id=eq.${r.p.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(campos) });
        return res.json({ programa: lyUno(d) });
      }
      if (!esEquipo(req)) return res.status(403).json({ error: "Tu empresa todavía no tiene el programa activado" });
      const slug = String(b.slug || "").trim().toLowerCase();
      if (!SLUG.test(slug)) return res.status(400).json({ error: "El nombre de la dirección solo lleva letras minúsculas, números y guiones" });
      if (!campos.nombre || !campos.premio) return res.status(400).json({ error: "Faltan nombre y premio" });
      const d = await lyRest("loyalty_programs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...campos, slug, company_id: r.cid }) });
      res.json({ programa: lyUno(d) });
    } catch (e) { res.status(/duplicate|23505/i.test(e.message) ? 409 : 500).json({ error: /duplicate|23505/i.test(e.message) ? "Esa dirección ya está en uso" : e.message }); }
  });

  app.get("/api/fp/admin/resumen", requireAuth, async (req, res) => {
    try {
      const r = await progAdmin(req, res); if (!r || !r.p) return r && res.status(404).json({ error: "Sin programa" });
      const socios = await lyRest(`loyalty_members?program_id=eq.${r.p.id}&select=id,codigo6,nombre,telefono,email,saldo,canjes,tarjeta,created_at,ultima_visita,sorteo_ok&order=created_at.desc&limit=2000`);
      const ids = socios.map(s => s.id);
      let cupones = [], evs = [];
      if (ids.length) {
        cupones = await lyRest(`loyalty_coupons?member_id=in.(${ids.join(",")})&select=member_id,estado,usado_at`);
        evs = await lyRest(`loyalty_events?member_id=in.(${ids.join(",")})&select=member_id,tipo,cantidad,created_at,cashier_id&order=created_at.desc&limit=300`);
      }
      const nom = Object.fromEntries(socios.map(s => [s.id, s.nombre || s.codigo6]));
      const cajeros = await lyRest(`loyalty_cashiers?program_id=eq.${r.p.id}&select=id,nombre,activo,created_at,ultimo_login&order=created_at`);
      const cn = Object.fromEntries(cajeros.map(c => [c.id, c.nombre]));
      const sorteos = await lyRest(`loyalty_draws?program_id=eq.${r.p.id}&select=id,mes,member_id,premio,participantes,entregado,created_at&order=mes.desc`);
      res.json({
        programa: r.p,
        totales: {
          socios: socios.length,
          sellos: evs.filter(e => e.tipo === "sello").length,
          canjes: socios.reduce((a, s) => a + (s.canjes || 0), 0),
          cuponesUsados: cupones.filter(c => c.estado === "usado").length,
          cuponesActivos: cupones.filter(c => c.estado === "activo").length,
        },
        socios,
        eventos: evs.slice(0, 150).map(e => ({ ...e, socio: nom[e.member_id], cajero: cn[e.cashier_id] || null })),
        cajeros,
        sorteos: sorteos.map(s => ({ ...s, ganador: nom[s.member_id] || "-", telefono: socios.find(x => x.id === s.member_id)?.telefono || null })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/fp/admin/cajeros", requireAuth, async (req, res) => {
    try {
      const r = await progAdmin(req, res); if (!r || !r.p) return r && res.status(404).json({ error: "Sin programa" });
      const { id, nombre, pin, activo } = req.body || {};
      const patch = {};
      if (typeof activo === "boolean") patch.activo = activo;
      if (pin !== undefined && pin !== "") {
        const pn = String(pin).replace(/\D/g, "");
        if (pn.length !== 6) return res.status(400).json({ error: "El PIN lleva 6 dígitos" });
        // El PIN identifica al cajero, así que no puede repetirse dentro del programa.
        const otros = await lyRest(`loyalty_cashiers?program_id=eq.${r.p.id}&activo=eq.true&select=id,pin_salt,pin_hash`);
        if (otros.some(o => o.id !== id && iguales(o.pin_hash, hashPin(pn, o.pin_salt)))) return res.status(409).json({ error: "Ese PIN ya lo usa otro cajero" });
        patch.pin_salt = crypto.randomBytes(16).toString("hex");
        patch.pin_hash = hashPin(pn, patch.pin_salt);
      }
      if (id) {
        if (!UUID.test(id)) return res.status(400).json({ error: "Id no válido" });
        if (nombre) patch.nombre = String(nombre).slice(0, 60);
        await lyRest(`loyalty_cashiers?id=eq.${id}&program_id=eq.${r.p.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        return res.json({ ok: true });
      }
      if (!nombre || !patch.pin_hash) return res.status(400).json({ error: "Faltan nombre y PIN" });
      await lyRest("loyalty_cashiers", { method: "POST", body: JSON.stringify({ program_id: r.p.id, nombre: String(nombre).slice(0, 60), pin_salt: patch.pin_salt, pin_hash: patch.pin_hash }) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Sorteo del mes: entre los socios inscritos hasta ese mes que aceptan participar. Un sorteo por
  // mes (índice único): repetir el botón no cambia al ganador.
  app.post("/api/fp/admin/sorteo", requireAuth, async (req, res) => {
    try {
      const r = await progAdmin(req, res); if (!r || !r.p) return r && res.status(404).json({ error: "Sin programa" });
      const mes = String(req.body?.mes || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return res.status(400).json({ error: "Mes no válido" });
      const ya = lyUno(await lyRest(`loyalty_draws?program_id=eq.${r.p.id}&mes=eq.${mes}&select=id&limit=1`));
      if (ya) return res.status(409).json({ error: "Ese mes ya se sorteó" });
      const [y, m] = mes.split("-").map(Number);
      const fin = new Date(Date.UTC(y, m, 1)).toISOString();   // primer instante del mes siguiente
      const lista = await lyRest(`loyalty_members?program_id=eq.${r.p.id}&sorteo_ok=eq.true&created_at=lt.${enc(fin)}&select=id,nombre,telefono&limit=5000`);
      if (!lista.length) return res.status(400).json({ error: "No hay participantes ese mes" });
      const g = lista[crypto.randomInt(0, lista.length)];
      await lyRest("loyalty_draws", { method: "POST", body: JSON.stringify({ program_id: r.p.id, mes, member_id: g.id, premio: r.p.sorteo_texto || null, participantes: lista.length }) });
      res.json({ ganador: g.nombre, telefono: g.telefono, participantes: lista.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/fp/admin/sorteo/entregado", requireAuth, async (req, res) => {
    try {
      const r = await progAdmin(req, res); if (!r || !r.p) return r && res.status(404).json({ error: "Sin programa" });
      const id = String(req.body?.id || ""); if (!UUID.test(id)) return res.status(400).json({ error: "Id no válido" });
      await lyRest(`loyalty_draws?id=eq.${id}&program_id=eq.${r.p.id}`, { method: "PATCH", body: JSON.stringify({ entregado: !!req.body?.entregado }) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Exportado para pruebas.
  return { firmaQR, leerQR, hashPin };
};
