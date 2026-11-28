// @ts-nocheck
// ============================================================================
// FIDELIZACIÓN v2 como Edge Function de Supabase (reemplaza a fp-loyalty.js de Render).
// La lógica es la misma que la del módulo Express; lo que cambia:
//  · Sin cookies: las páginas viven en GitHub Pages (otro origen), así que las sesiones del cajero y
//    del administrador son un token firmado en la cabecera `Authorization: Bearer`.
//  · Administración con login propio (tabla fp_admins), ya no la sesión de Inmersia.
//  · Límite de intentos y tope de PIN en la base (fp_rl), no en la memoria de un proceso.
//  · Rutas: /functions/v1/fp/api/fp/...   (el prefijo /functions/v1/fp lo quita el router)
// Secretos: FP_SECRET (≥32 caracteres, propio de esta función). SUPABASE_URL y
// SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase.
// ============================================================================
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SECRET = Deno.env.get("FP_SECRET") || "";
const ORIGENES = (Deno.env.get("FP_ORIGINS") || "https://josevergara1999.github.io").split(",").map((s) => s.trim()).filter(Boolean);

// ── Acceso a la base (PostgREST con service_role) ───────────────────────────
async function lyRest(path: string, opts: any = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let d: any = null; try { d = txt ? JSON.parse(txt) : null; } catch { d = txt; }
  if (!r.ok) throw new Error(d?.message || d?.hint || `Supabase ${r.status}`);
  return d;
}
const lyUno = (d: any) => (Array.isArray(d) ? d[0] : d) || null;

// ── Mini router con la forma de Express (req.params/body/query, res.status().json(), next) ──
const rutas: any[] = [];
function ruta(metodo: string, patron: string, ...handlers: any[]) {
  const claves: string[] = [];
  const re = new RegExp("^" + patron.replace(/:([a-z]+)/gi, (_m, k) => { claves.push(k); return "([^/]+)"; }) + "/?$");
  rutas.push({ metodo, re, claves, handlers });
}
const app = { get: (p: string, ...h: any[]) => ruta("GET", p, ...h), post: (p: string, ...h: any[]) => ruta("POST", p, ...h) };

const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const idem = (s: any) => (typeof s === "string" && /^[\w.:-]{8,80}$/.test(s)) ? s : null;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const urlOk = (u: any) => /^(https:\/\/[\w.-]+\/[^\s"'<>()\\]*|\/[\w./-]+)$/.test(String(u || "")) && String(u).length <= 400;
const fallo = (res: any, e: any, tag = "") => { console.error("fp " + tag + ":", e && e.message); res.status(500).json({ error: "Error interno, intenta de nuevo" }); };

const iguales = (a: any, b: any) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

// IP del cliente. Supabase va detrás de Cloudflare: `cf-connecting-ip` lo pone el borde, no el cliente.
// Si no viniera, se usa la ÚLTIMA de X-Forwarded-For (la que añade el proxy, no la que escribe el cliente).
function ipDe(req: any) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || "sin-ip";
}

// Límite por IP, persistente. `max` por minuto.
function rateLimit(max: number, tag: string) {
  return async (req: any, res: any, next: any) => {
    try {
      const ok = await lyRest("rpc/fp_rl_hit", { method: "POST", body: JSON.stringify({ p_clave: `ip:${tag}:${ipDe(req)}`, p_max: max, p_ventana_seg: 60 }) });
      if (!ok) return res.status(429).json({ error: "Demasiados intentos. Espera un momento" });
      next();
    } catch (e) { fallo(res, e, "rl"); }
  };
}

// ── Tokens firmados (cajero y administrador) ────────────────────────────────
const firma = (ctx: string, payload: string) => crypto.createHmac("sha256", SECRET + "|" + ctx).update(payload).digest("base64url");
function emitir(ctx: string, datos: any, ttlMs: number) {
  const p = Buffer.from(JSON.stringify({ ...datos, exp: Date.now() + ttlMs })).toString("base64url");
  return p + "." + firma(ctx, p);
}
function leerToken(req: any, ctx: string) {
  if (SECRET.length < 32) return null;
  const h = String(req.headers["authorization"] || "");
  const raw = h.startsWith("Bearer ") ? h.slice(7) : "";
  const i = raw.lastIndexOf(".");
  if (i < 1) return null;
  const payload = raw.slice(0, i), sig = raw.slice(i + 1);
  if (!iguales(sig, firma(ctx, payload))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    return d && d.exp > Date.now() ? d : null;
  } catch { return null; }
}

// ── Hash de PIN y contraseñas (scrypt con sal; mismo formato que ya tienen los cajeros) ──
const hashPin = (pin: string, salt: string): Promise<string> =>
  new Promise((ok, mal) => crypto.scrypt(String(pin), salt, 32, (e: any, k: any) => e ? mal(e) : ok(k.toString("hex"))));
const versionHash = (h: any) => String(h || "").slice(0, 12);

// ── Datos públicos del programa ─────────────────────────────────────────────
const PUB = "id,slug,nombre,tipo,meta,premio,activo,color_fondo,color_texto,color_etiqueta,logo_url,logo_text," +
            "min_horas,qr_segundos,bienvenida_activa,bienvenida_texto,sorteo_activo,sorteo_texto,tarjetas,cumple_activo,cumple_texto";
const progPorSlug = async (slug: any) => {
  if (!SLUG.test(String(slug || ""))) return null;
  return lyUno(await lyRest(`loyalty_programs?slug=eq.${enc(slug)}&select=${PUB}&limit=1`));
};

// ── QR rotativo: FP1.<codigo>.<t>.<firma>, firma = HMAC(clave del socio) ────
const firmaQR = (clave: string, codigo: string, t: any) =>
  crypto.createHmac("sha256", clave).update(codigo + "." + t).digest("hex").slice(0, 16);

function leerQR(texto: any, prog: any, socio: any) {
  if (!socio.qr_clave) return false;
  const p = String(texto || "").trim().split(".");
  if (p.length !== 4 || p[0] !== "FP1") return false;
  const ahora = Math.floor(Date.now() / 1000 / (prog.qr_segundos || 120));
  const t = parseInt(p[2], 10);
  if (!Number.isFinite(t) || t > ahora + 1 || t < ahora - 1) return "vencido";
  return iguales(firmaQR(socio.qr_clave, socio.codigo, t), p[3]) ? true : false;
}

async function resolverSocio(prog: any, body: any) {
  const sel = "id,codigo,codigo6,nombre,saldo,canjes,qr_clave,ultimo_sello,created_at,tarjeta,program_id,nacimiento";
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

async function estadoSocio(prog: any, m: any) {
  const cupon = lyUno(await lyRest(`loyalty_coupons?member_id=eq.${m.id}&tipo=eq.bienvenida&select=id,estado,descripcion&limit=1`));
  let faltanMin = 0;
  if (m.ultimo_sello) faltanMin = Math.max(0, Math.ceil((new Date(m.ultimo_sello).getTime() + prog.min_horas * 3600000 - Date.now()) / 60000));
  return {
    socio: { nombre: m.nombre, saldo: m.saldo, canjes: m.canjes, codigo6: m.codigo6 },
    meta: prog.meta, premio: prog.premio, qrSeg: prog.qr_segundos, sorteoTexto: prog.sorteo_activo ? (prog.sorteo_texto || "") : "",
    puedeSellar: faltanMin === 0, faltanMin,
    puedeCanjear: m.saldo >= prog.meta,
    cumple: prog.cumple_activo !== false && m.nacimiento && String(m.nacimiento).slice(5, 10) === new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" }).slice(5, 10) ? { texto: prog.cumple_texto || "Beneficio de cumpleaños" } : null,
    cupon: cupon ? { id: cupon.id, estado: cupon.estado, descripcion: cupon.descripcion } : null,
  };
}

// ===========================================================================
// CLIENTE (público)
// ===========================================================================
const RESERVADOS = new Set(["admin", "caja"]);
app.get("/api/fp/:slug/programa", rateLimit(60, "fp-prog"), async (req: any, res: any, next: any) => {
  if (RESERVADOS.has(req.params.slug)) return next();
  try {
    const p = await progPorSlug(req.params.slug);
    if (!p || !p.activo) return res.status(404).json({ error: "Programa no disponible" });
    res.json(p);
  } catch (e) { fallo(res, e); }
});

app.post("/api/fp/:slug/alta", rateLimit(15, "fp-alta"), async (req: any, res: any) => {
  try {
    const p = await progPorSlug(req.params.slug);
    if (!p || !p.activo) return res.status(404).json({ error: "Programa no disponible" });
    const b = req.body || {};
    if (b.acepta !== true) return res.status(400).json({ error: "Debes aceptar la política de privacidad" });
    const nombre = String(b.nombre || "").trim().slice(0, 80);
    const telefono = String(b.telefono || "").replace(/[^\d+]/g, "").slice(0, 16);
    const emailRaw = String(b.email || "").trim().toLowerCase().slice(0, 120);
    const email = /^[\w.+-]+@[\w.-]+\.\w{2,}$/.test(emailRaw) ? emailRaw : "";
    if (!nombre) return res.status(400).json({ error: "Escribe tu nombre" });
    if (telefono.length < 8 && !email.includes("@")) return res.status(400).json({ error: "Escribe un teléfono o un correo" });

    // Pruebas: se permite registrar el mismo correo/teléfono más de una vez (sin aviso de "ya tienes una tarjeta").

    const nacRaw = String(b.nacimiento || "");
    const nacOk = /^\d{4}-\d{2}-\d{2}$/.test(nacRaw) && +nacRaw.slice(0, 4) >= 1900 && !isNaN(Date.parse(nacRaw)) && Date.parse(nacRaw) < Date.now();
    const tarjeta = (p.tarjetas || []).length ? ((p.tarjetas.some((t: any) => t.id === b.tarjeta)) ? b.tarjeta : null)
                  : (/^[a-z0-9-]{1,20}$/.test(String(b.tarjeta || "")) ? b.tarjeta : null);
    let socio: any = null;
    for (let i = 0; i < 6 && !socio; i++) {
      try {
        socio = lyUno(await lyRest("loyalty_members", {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            program_id: p.id, codigo: "FP" + crypto.randomBytes(6).toString("hex").toUpperCase(),
            codigo6: String(crypto.randomInt(0, 1000000)).padStart(6, "0"),
            qr_clave: crypto.randomBytes(24).toString("hex"),
            nombre, telefono: telefono || null, email: email || null, tarjeta, nacimiento: nacOk ? nacRaw : null,
            sorteo_ok: b.sorteo === true, consent_at: new Date().toISOString(),
          }),
        }));
      } catch (e: any) { if (!/duplicate|23505/i.test(e.message)) throw e; }
    }
    if (!socio) return res.status(500).json({ error: "No se pudo crear la tarjeta, intenta de nuevo" });

    await lyRest("loyalty_events", { method: "POST", body: JSON.stringify({ member_id: socio.id, tipo: "alta", cantidad: 0, saldo_despues: 0 }) });
    if (p.bienvenida_activa) {
      await lyRest("loyalty_coupons", { method: "POST", body: JSON.stringify({ member_id: socio.id, tipo: "bienvenida", descripcion: p.bienvenida_texto || "Descuento de bienvenida" }) });
    }
    res.json({ codigo: socio.codigo, clave: socio.qr_clave, codigo6: socio.codigo6, qrSeg: p.qr_segundos, meta: p.meta });
  } catch (e: any) { console.error("fp alta:", e.message); res.status(500).json({ error: "No se pudo crear la tarjeta" }); }
});

app.post("/api/fp/:slug/tarjeta", rateLimit(60, "fp-tarjeta"), async (req: any, res: any) => {
  try {
    const p = await progPorSlug(req.params.slug);
    if (!p) return res.status(404).json({ error: "Programa no disponible" });
    const { codigo, clave } = req.body || {};
    const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${p.id}&codigo=eq.${enc(String(codigo || ""))}&select=id,codigo,codigo6,nombre,saldo,canjes,qr_clave,ultimo_sello,tarjeta,sorteo_ok,program_id&limit=1`));
    if (!m || !iguales(m.qr_clave, clave)) return res.status(401).json({ error: "Tarjeta no válida en este teléfono" });
    const est = await estadoSocio(p, m);
    res.json({ ...est, tarjeta: m.tarjeta, sorteo: !!p.sorteo_activo && m.sorteo_ok });
  } catch (e) { fallo(res, e, "tarjeta"); }
});

async function anonimizar(socioId: string) {
  await lyRest(`loyalty_members?id=eq.${socioId}`, { method: "PATCH", body: JSON.stringify({
    nombre: "Socio eliminado", telefono: null, email: null, sorteo_ok: false,
    qr_clave: crypto.randomBytes(24).toString("hex"), eliminado_at: new Date().toISOString(),
  }) });
}
app.post("/api/fp/:slug/borrar", rateLimit(10, "fp-borrar"), async (req: any, res: any) => {
  try {
    const p = await progPorSlug(req.params.slug);
    if (!p) return res.status(404).json({ error: "Programa no disponible" });
    const { codigo, clave } = req.body || {};
    const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${p.id}&codigo=eq.${enc(String(codigo || ""))}&select=id,qr_clave&limit=1`));
    if (!m || !iguales(m.qr_clave, clave)) return res.status(401).json({ error: "Tarjeta no válida en este teléfono" });
    await anonimizar(m.id);
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "borrar"); }
});

app.post("/api/fp/:slug/elegir", rateLimit(30, "fp-elegir"), async (req: any, res: any) => {
  try {
    const p = await progPorSlug(req.params.slug);
    if (!p) return res.status(404).json({ error: "Programa no disponible" });
    const { codigo, clave, tarjeta } = req.body || {};
    const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${p.id}&codigo=eq.${enc(String(codigo || ""))}&select=id,qr_clave&limit=1`));
    if (!m || !iguales(m.qr_clave, clave)) return res.status(401).json({ error: "Tarjeta no válida en este teléfono" });
    if (!(p.tarjetas || []).some((t: any) => t.id === tarjeta)) return res.status(400).json({ error: "Diseño desconocido" });
    await lyRest(`loyalty_members?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ tarjeta }) });
    res.json({ ok: true });
  } catch (e) { fallo(res, e); }
});

// ===========================================================================
// CAJERO
// ===========================================================================
const CAJA_TTL = 7 * 24 * 3600000;
// Cada petición vuelve a mirar en la base que el cajero siga activo y que el PIN no haya cambiado.
async function cajaAuth(req: any, res: any, next: any) {
  try {
    const d = leerToken(req, "caja");
    if (!d || !UUID.test(d.c || "")) return res.status(401).json({ error: "Entra con tu PIN" });
    const c = lyUno(await lyRest(`loyalty_cashiers?id=eq.${d.c}&activo=eq.true&select=id,nombre,program_id,pin_hash&limit=1`));
    if (!c || c.program_id !== d.p || !d.v || versionHash(c.pin_hash) !== d.v) return res.status(401).json({ error: "Entra con tu PIN" });
    const prog = lyUno(await lyRest(`loyalty_programs?id=eq.${c.program_id}&select=${PUB}&limit=1`));
    if (!prog || !prog.activo) return res.status(403).json({ error: "El programa está pausado" });
    req.cajero = c; req.prog = prog;
    next();
  } catch { res.status(401).json({ error: "Entra con tu PIN" }); }
}

const limpio = (v: any, n: number) => String(v ?? "").replace(/[ -]/g, " ").trim().slice(0, n);
// Anota en el último movimiento del cajero con ese socio qué celular lo hizo y el detalle de la compra.
async function anotarMov(memberId: string, cashierId: string, tipo: string, disp: string, nota: string) {
  if (!disp && !nota) return;
  try {
    const ev = lyUno(await lyRest(`loyalty_events?member_id=eq.${memberId}&cashier_id=eq.${cashierId}&tipo=eq.${tipo}&select=id&order=created_at.desc&limit=1`));
    if (ev) await lyRest(`loyalty_events?id=eq.${ev.id}`, { method: "PATCH", body: JSON.stringify({ dispositivo: disp || null, nota: nota || null }) });
  } catch (e: any) { console.warn("fp anotarMov:", e.message); }
}

// Tope de PINs por programa sin importar la IP: 10 intentos en 10 minutos. El intento se anota
// ANTES de verificar (atómico en la base), así que intentos en paralelo no se lo saltan.
app.post("/api/fp/:slug/caja/login", rateLimit(10, "fp-pin"), async (req: any, res: any) => {
  try {
    if (SECRET.length < 32) return res.status(500).json({ error: "Servicio sin configurar" });
    const p = await progPorSlug(req.params.slug);
    const pin = String(req.body?.pin || "").replace(/\D/g, "");
    if (!p || !p.activo || pin.length !== 6) return res.status(401).json({ error: "PIN incorrecto" });
    const clave = "pin:" + p.id;
    const dentro = await lyRest("rpc/fp_rl_hit", { method: "POST", body: JSON.stringify({ p_clave: clave, p_max: 10, p_ventana_seg: 600 }) });
    if (!dentro) {
      console.warn("fp PIN bloqueado (demasiados fallos) programa=" + p.slug);
      return res.status(429).json({ error: "Demasiados intentos fallidos. Espera unos minutos" });
    }
    const lista = await lyRest(`loyalty_cashiers?program_id=eq.${p.id}&activo=eq.true&select=id,nombre,program_id,pin_salt,pin_hash`);
    let c: any = null;
    for (const x of lista) { if (iguales(x.pin_hash, await hashPin(pin, x.pin_salt))) { c = x; break; } }
    if (!c) { console.warn("fp PIN fallido programa=" + p.slug); return res.status(401).json({ error: "PIN incorrecto" }); }
    await lyRest("rpc/fp_rl_clear", { method: "POST", body: JSON.stringify({ p_clave: clave }) });
    lyRest(`loyalty_cashiers?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify({ ultimo_login: new Date().toISOString(), ultimo_dispositivo: limpio(req.body?.disp, 60) || null }) }).catch(() => {});
    const token = emitir("caja", { c: c.id, p: c.program_id, v: versionHash(c.pin_hash) }, CAJA_TTL);
    res.json({ ok: true, token, cajero: c.nombre, programa: p.nombre });
  } catch (e) { fallo(res, e, "login"); }
});

// El token vive en el teléfono del cajero: "salir" lo borra allá. Aquí no hay nada que cerrar.
app.post("/api/fp/caja/salir", (_req: any, res: any) => res.json({ ok: true }));
app.get("/api/fp/caja/yo", cajaAuth, (req: any, res: any) => res.json({ cajero: req.cajero.nombre, programa: req.prog.nombre, meta: req.prog.meta, premio: req.prog.premio }));

app.post("/api/fp/caja/buscar", rateLimit(80, "fp-caja"), cajaAuth, async (req: any, res: any) => {
  try {
    const r: any = await resolverSocio(req.prog, req.body || {});
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(await estadoSocio(req.prog, r.m));
  } catch (e) { fallo(res, e); }
});

const rpcSocio = (fn: string, armar: any) => async (req: any, res: any) => {
  try {
    const b = req.body || {};
    const r: any = await resolverSocio(req.prog, b);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const out = await lyRest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(armar(r.m, req, idem(b.idem), b)) });
    if (out?.ok && !out.repetido) await anotarMov(r.m.id, req.cajero.id, fn === "fp_sellar" ? "sello" : "canje", limpio(b.disp, 60), limpio(b.nota, 300));
    const est = await estadoSocio(req.prog, lyUno(await lyRest(`loyalty_members?id=eq.${r.m.id}&select=id,codigo,codigo6,nombre,saldo,canjes,qr_clave,ultimo_sello,tarjeta,program_id,nacimiento&limit=1`)));
    res.json({ ...out, estado: est });
  } catch (e: any) { console.error(fn + ":", e.message); res.status(500).json({ error: "No se pudo completar, intenta de nuevo" }); }
};
app.post("/api/fp/caja/sellar",  rateLimit(80, "fp-caja"), cajaAuth, rpcSocio("fp_sellar",         (m: any, req: any, k: any) => ({ p_member: m.id, p_cashier: req.cajero.id, p_idem: k })));
app.post("/api/fp/caja/canjear", rateLimit(80, "fp-caja"), cajaAuth, rpcSocio("fp_canjear_premio", (m: any, req: any, k: any) => ({ p_member: m.id, p_cashier: req.cajero.id, p_idem: k })));

app.post("/api/fp/caja/cupon", rateLimit(80, "fp-caja"), cajaAuth, async (req: any, res: any) => {
  try {
    const r: any = await resolverSocio(req.prog, req.body || {});
    if (r.error) return res.status(r.status).json({ error: r.error });
    const cu = lyUno(await lyRest(`loyalty_coupons?member_id=eq.${r.m.id}&tipo=eq.bienvenida&select=id&limit=1`));
    if (!cu) return res.status(404).json({ error: "Este cliente no tiene cupón" });
    const out = await lyRest("rpc/fp_usar_cupon", { method: "POST", body: JSON.stringify({ p_cupon: cu.id, p_cashier: req.cajero.id }) });
    if (out?.ok) await anotarMov(r.m.id, req.cajero.id, "cupon", limpio(req.body?.disp, 60), limpio(req.body?.nota, 300));
    res.json({ ...out, estado: await estadoSocio(req.prog, r.m) });
  } catch { res.status(500).json({ error: "No se pudo completar, intenta de nuevo" }); }
});

// ===========================================================================
// ADMINISTRACIÓN (login propio: tabla fp_admins, un administrador queda en SU programa)
// ===========================================================================
const ADMIN_TTL = 12 * 3600000;

app.post("/api/fp/admin/login", rateLimit(10, "fp-adm"), async (req: any, res: any) => {
  try {
    if (SECRET.length < 32) return res.status(500).json({ error: "Servicio sin configurar" });
    const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 120);
    const pass = String(req.body?.password || "");
    if (!/^[\w.+-]+@[\w.-]+\.\w{2,}$/.test(email) || !pass || pass.length > 200) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    // Tope por correo, sin importar la IP.
    const dentro = await lyRest("rpc/fp_rl_hit", { method: "POST", body: JSON.stringify({ p_clave: "adm:" + email, p_max: 10, p_ventana_seg: 600 }) });
    if (!dentro) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos" });
    const a = lyUno(await lyRest(`fp_admins?email=eq.${enc(email)}&activo=eq.true&select=id,program_id,nombre,pass_salt,pass_hash&limit=1`));
    // Con o sin usuario se hace el mismo trabajo de hash: no se distingue por el tiempo de respuesta.
    const h = await hashPin(pass, a ? a.pass_salt : "0".repeat(32));
    if (!a || !iguales(a.pass_hash, h)) { console.warn("fp admin login fallido"); return res.status(401).json({ error: "Usuario o contraseña incorrectos" }); }
    await lyRest("rpc/fp_rl_clear", { method: "POST", body: JSON.stringify({ p_clave: "adm:" + email }) });
    lyRest(`fp_admins?id=eq.${a.id}`, { method: "PATCH", body: JSON.stringify({ ultimo_login: new Date().toISOString() }) }).catch(() => {});
    res.json({ ok: true, token: emitir("admin", { a: a.id, p: a.program_id, v: versionHash(a.pass_hash) }, ADMIN_TTL), nombre: a.nombre || email });
  } catch (e) { fallo(res, e, "admin login"); }
});

async function adminAuth(req: any, res: any, next: any) {
  try {
    const d = leerToken(req, "admin");
    if (!d || !UUID.test(d.a || "")) return res.status(401).json({ error: "Entra con tu usuario" });
    const a = lyUno(await lyRest(`fp_admins?id=eq.${d.a}&activo=eq.true&select=id,program_id,pass_hash&limit=1`));
    if (!a || a.program_id !== d.p || versionHash(a.pass_hash) !== d.v) return res.status(401).json({ error: "Entra con tu usuario" });
    const p = lyUno(await lyRest(`loyalty_programs?id=eq.${a.program_id}&select=*&limit=1`));
    if (!p) return res.status(404).json({ error: "Sin programa" });
    req.admin = a; req.p = p;
    next();
  } catch { res.status(401).json({ error: "Entra con tu usuario" }); }
}

app.post("/api/fp/admin/password", rateLimit(10, "fp-adm"), adminAuth, async (req: any, res: any) => {
  try {
    const actual = String(req.body?.actual || ""), nueva = String(req.body?.nueva || "");
    if (nueva.length < 10 || nueva.length > 200) return res.status(400).json({ error: "La contraseña nueva lleva al menos 10 caracteres" });
    const a = lyUno(await lyRest(`fp_admins?id=eq.${req.admin.id}&select=pass_salt,pass_hash&limit=1`));
    if (!a || !iguales(a.pass_hash, await hashPin(actual, a.pass_salt))) return res.status(401).json({ error: "La contraseña actual no coincide" });
    const salt = crypto.randomBytes(16).toString("hex"), hash = await hashPin(nueva, salt);
    await lyRest(`fp_admins?id=eq.${req.admin.id}`, { method: "PATCH", body: JSON.stringify({ pass_salt: salt, pass_hash: hash }) });
    // El hash nuevo invalida las sesiones anteriores; se devuelve un token válido para esta.
    res.json({ ok: true, token: emitir("admin", { a: req.admin.id, p: req.admin.program_id, v: versionHash(hash) }, ADMIN_TTL) });
  } catch (e) { fallo(res, e, "admin password"); }
});

app.get("/api/fp/admin/programa", adminAuth, (req: any, res: any) => res.json({ programa: req.p, puedeCrear: false }));

app.post("/api/fp/admin/programa", adminAuth, async (req: any, res: any) => {
  try {
    const b = req.body || {};
    const num = (v: any, min: number, max: number, def: number) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
    const campos: any = {
      nombre: b.nombre, premio: b.premio,
      meta: b.meta !== undefined ? num(b.meta, 3, 8, 8) : undefined,
      min_horas: b.min_horas !== undefined ? num(b.min_horas, 0, 168, 12) : undefined,
      qr_segundos: b.qr_segundos !== undefined ? num(b.qr_segundos, 30, 900, 120) : undefined,
      bienvenida_activa: typeof b.bienvenida_activa === "boolean" ? b.bienvenida_activa : undefined,
      bienvenida_texto: b.bienvenida_texto, cumple_texto: b.cumple_texto, cumple_activo: typeof b.cumple_activo === "boolean" ? b.cumple_activo : undefined, sorteo_activo: typeof b.sorteo_activo === "boolean" ? b.sorteo_activo : undefined,
      sorteo_texto: b.sorteo_texto, activo: typeof b.activo === "boolean" ? b.activo : undefined,
      color_fondo: COLOR.test(String(b.color_fondo || "")) ? b.color_fondo : undefined,
      color_texto: COLOR.test(String(b.color_texto || "")) ? b.color_texto : undefined,
      logo_url: urlOk(b.logo_url) ? b.logo_url : undefined,
      logo_text: b.logo_text !== undefined ? String(b.logo_text).slice(0, 60) : undefined,
      tarjetas: Array.isArray(b.tarjetas) ? b.tarjetas.slice(0, 12).map((t: any) => ({ id: String(t.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 30), nombre: String(t.nombre || "").slice(0, 40), img: urlOk(t.img) ? String(t.img) : "", claro: !!t.claro })).filter((t: any) => t.id && t.img) : undefined,
    };
    for (const k of ["nombre", "premio", "bienvenida_texto", "sorteo_texto", "cumple_texto"]) if (campos[k] !== undefined) campos[k] = String(campos[k]).slice(0, 200);
    Object.keys(campos).forEach((k) => campos[k] === undefined && delete campos[k]);
    campos.updated_at = new Date().toISOString();
    const d = await lyRest(`loyalty_programs?id=eq.${req.p.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(campos) });
    res.json({ programa: lyUno(d) });
  } catch (e) { fallo(res, e, "admin programa"); }
});

app.get("/api/fp/admin/resumen", adminAuth, async (req: any, res: any) => {
  try {
    const p = req.p;
    const socios = await lyRest(`loyalty_members?program_id=eq.${p.id}&select=id,codigo6,nombre,telefono,email,saldo,canjes,tarjeta,created_at,ultima_visita,sorteo_ok,nacimiento&order=created_at.desc&limit=2000`);
    // Cupones y eventos se filtran por el programa del socio (join en PostgREST), no con una lista
    // de ids en la URL: esa lista se rompía con unos cientos de socios.
    const cupones = await lyRest(`loyalty_coupons?select=member_id,estado,usado_at,loyalty_members!inner(program_id)&loyalty_members.program_id=eq.${p.id}&limit=5000`);
    const evs = await lyRest(`loyalty_events?select=member_id,tipo,cantidad,created_at,cashier_id,dispositivo,nota,loyalty_members!inner(program_id)&loyalty_members.program_id=eq.${p.id}&order=created_at.desc&limit=300`);
    const nom = Object.fromEntries(socios.map((s: any) => [s.id, s.nombre || s.codigo6]));
    const cajeros = await lyRest(`loyalty_cashiers?program_id=eq.${p.id}&select=id,nombre,activo,created_at,ultimo_login,ultimo_dispositivo&order=created_at`);
    const cn = Object.fromEntries(cajeros.map((c: any) => [c.id, c.nombre]));
    const evd = await lyRest(`loyalty_events?dispositivo=not.is.null&select=tipo,dispositivo,created_at,cashier_id,loyalty_members!inner(program_id)&loyalty_members.program_id=eq.${p.id}&order=created_at.desc&limit=20000`);
    const porDisp: any = {};
    for (const e of evd) {
      const d = porDisp[e.dispositivo] || (porDisp[e.dispositivo] = { dispositivo: e.dispositivo, total: 0, tipos: {}, ultimo: e.created_at, cajeros: new Set() });
      d.total++; d.tipos[e.tipo] = (d.tipos[e.tipo] || 0) + 1; if (cn[e.cashier_id]) d.cajeros.add(cn[e.cashier_id]);
    }
    const dispositivos = Object.values(porDisp).map((d: any) => ({ ...d, cajeros: [...d.cajeros] })).sort((a: any, b: any) => b.total - a.total);
    const sorteos = await lyRest(`loyalty_draws?program_id=eq.${p.id}&select=id,mes,member_id,premio,participantes,entregado,created_at&order=mes.desc`);
    res.json({
      programa: p,
      totales: {
        socios: socios.length,
        sellos: evs.filter((e: any) => e.tipo === "sello").length,
        canjes: socios.reduce((a: number, s: any) => a + (s.canjes || 0), 0),
        cuponesUsados: cupones.filter((c: any) => c.estado === "usado").length,
        cuponesActivos: cupones.filter((c: any) => c.estado === "activo").length,
      },
      socios,
      eventos: evs.slice(0, 150).map((e: any) => { const { loyalty_members: _x, ...r } = e; return { ...r, socio: nom[e.member_id], cajero: cn[e.cashier_id] || null }; }),
      cajeros, dispositivos,
      sorteos: sorteos.map((s: any) => ({ ...s, ganador: nom[s.member_id] || "-", telefono: socios.find((x: any) => x.id === s.member_id)?.telefono || null })),
    });
  } catch (e) { fallo(res, e, "resumen"); }
});

app.post("/api/fp/admin/socios/borrar", adminAuth, async (req: any, res: any) => {
  try {
    const p = req.p;
    const { id, todos } = req.body || {};
    if (todos === true) {
      await lyRest(`loyalty_draws?program_id=eq.${p.id}`, { method: "DELETE" });
      await lyRest(`loyalty_members?program_id=eq.${p.id}`, { method: "DELETE" });
      return res.json({ ok: true });
    }
    if (!id || !UUID.test(id)) return res.status(400).json({ error: "Id no válido" });
    try {
      await lyRest(`loyalty_members?id=eq.${id}&program_id=eq.${p.id}`, { method: "DELETE" });
    } catch (_e) {
      return res.status(409).json({ error: "No se pudo borrar: este cliente ganó un sorteo y queda en el historial" });
    }
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "socios_borrar"); }
});
app.post("/api/fp/admin/cajeros", adminAuth, async (req: any, res: any) => {
  try {
    const p = req.p;
    const { id, nombre, pin, activo } = req.body || {};
    const patch: any = {};
    if (typeof activo === "boolean") patch.activo = activo;
    if (pin !== undefined && pin !== "") {
      const pn = String(pin).replace(/\D/g, "");
      if (pn.length !== 6) return res.status(400).json({ error: "El PIN lleva 6 dígitos" });
      const otros = await lyRest(`loyalty_cashiers?program_id=eq.${p.id}&activo=eq.true&select=id,pin_salt,pin_hash`);
      for (const o of otros) { if (o.id !== id && iguales(o.pin_hash, await hashPin(pn, o.pin_salt))) return res.status(409).json({ error: "Ese PIN ya lo usa otro cajero" }); }
      patch.pin_salt = crypto.randomBytes(16).toString("hex");
      patch.pin_hash = await hashPin(pn, patch.pin_salt);
    }
    if (id) {
      if (!UUID.test(id)) return res.status(400).json({ error: "Id no válido" });
      if (nombre) patch.nombre = String(nombre).slice(0, 60);
      await lyRest(`loyalty_cashiers?id=eq.${id}&program_id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      return res.json({ ok: true });
    }
    if (!nombre || !patch.pin_hash) return res.status(400).json({ error: "Faltan nombre y PIN" });
    await lyRest("loyalty_cashiers", { method: "POST", body: JSON.stringify({ program_id: p.id, nombre: String(nombre).slice(0, 60), pin_salt: patch.pin_salt, pin_hash: patch.pin_hash }) });
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "cajeros"); }
});

app.post("/api/fp/admin/sorteo", adminAuth, async (req: any, res: any) => {
  try {
    const p = req.p;
    const mes = String(req.body?.mes || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return res.status(400).json({ error: "Mes no válido" });
    const ya = lyUno(await lyRest(`loyalty_draws?program_id=eq.${p.id}&mes=eq.${mes}&select=id&limit=1`));
    if (ya) return res.status(409).json({ error: "Ese mes ya se sorteó" });
    const [y, m] = mes.split("-").map(Number);
    const fin = new Date(Date.UTC(y, m, 1)).toISOString();
    const lista = await lyRest(`loyalty_members?program_id=eq.${p.id}&sorteo_ok=eq.true&created_at=lt.${enc(fin)}&select=id,nombre,telefono&limit=5000`);
    if (!lista.length) return res.status(400).json({ error: "No hay participantes ese mes" });
    const g = lista[crypto.randomInt(0, lista.length)];
    await lyRest("loyalty_draws", { method: "POST", body: JSON.stringify({ program_id: p.id, mes, member_id: g.id, premio: p.sorteo_texto || null, participantes: lista.length }) });
    res.json({ ganador: g.nombre, telefono: g.telefono, participantes: lista.length });
  } catch (e) { fallo(res, e, "sorteo"); }
});

app.post("/api/fp/admin/socio/borrar", adminAuth, async (req: any, res: any) => {
  try {
    const id = String(req.body?.id || ""); if (!UUID.test(id)) return res.status(400).json({ error: "Id no válido" });
    const m = lyUno(await lyRest(`loyalty_members?id=eq.${id}&program_id=eq.${req.p.id}&select=id&limit=1`));
    if (!m) return res.status(404).json({ error: "Socio no encontrado" });
    await anonimizar(m.id);
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "admin borrar"); }
});

app.post("/api/fp/admin/sorteo/entregado", adminAuth, async (req: any, res: any) => {
  try {
    const id = String(req.body?.id || ""); if (!UUID.test(id)) return res.status(400).json({ error: "Id no válido" });
    await lyRest(`loyalty_draws?id=eq.${id}&program_id=eq.${req.p.id}`, { method: "PATCH", body: JSON.stringify({ entregado: !!req.body?.entregado }) });
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "entregado"); }
});

// ===========================================================================
// AVISOS (notificaciones push)
// ===========================================================================
const VAPID_PUB = Deno.env.get("VAPID_PUBLIC") || "";
const VAPID_PRV = Deno.env.get("VAPID_PRIVATE") || "";
const CRON_KEY = Deno.env.get("FP_CRON") || "";
if (VAPID_PUB && VAPID_PRV) webpush.setVapidDetails("mailto:avisos@familypets.cl", VAPID_PUB, VAPID_PRV);

const AUTO_DEF: any = {
  cumple:    { activo: true,  hora: "09:00", titulo: "¡Feliz cumpleaños, {nombre}!", cuerpo: "Hoy tienes un regalo: {beneficio}" },
  falta1:    { activo: true,  titulo: "Te falta 1 sello", cuerpo: "{nombre}, con tu próxima visita completas tu tarjeta y ganas {premio}." },
  premio:    { activo: true,  titulo: "Tu premio está listo", cuerpo: "{nombre}, ya puedes canjear {premio} en tu próxima visita." },
  bienvenida:{ activo: false, hora: "18:30", dias: 7, titulo: "Tu descuento de bienvenida te espera", cuerpo: "{nombre}, aún no usas tu descuento. Pasa a buscarlo." },
  inactivo:  { activo: false, hora: "18:30", dias: 30, titulo: "Te echamos de menos", cuerpo: "{nombre}, te esperamos con tu regalón." },
  gracias:   { activo: false, titulo: "¡Gracias por tu visita!", cuerpo: "{nombre}, gracias por elegirnos." },
};
const autoDe = (p: any) => {
  const g = p.avisos_auto || {}; const o: any = {};
  for (const k of Object.keys(AUTO_DEF)) o[k] = { ...AUTO_DEF[k], ...(g[k] || {}) };
  return o;
};
const hoyChile = () => {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santiago" }));
  const pad = (n: number) => String(n).padStart(2, "0");
  return { fecha: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, anio: d.getFullYear(), mmdd: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, dow: d.getDay() };
};
const rellenar = (t: string, m: any, p: any) =>
  String(t || "").replace(/\{nombre\}/g, (m?.nombre || "").split(" ")[0] || "amigo/a").replace(/\{premio\}/g, p?.premio || "tu premio").replace(/\{beneficio\}/g, p?.cumple_texto || "tu beneficio de cumpleaños");

// Envía a una lista de suscripciones; devuelve {ok, mal}. Borra las que el navegador ya dio de baja.
async function enviarPush(subs: any[], armar: (s: any) => any) {
  let ok = 0, mal = 0;
  if (!VAPID_PUB || !VAPID_PRV) return { ok, mal: subs.length };
  for (let i = 0; i < subs.length; i += 15) {
    await Promise.all(subs.slice(i, i + 15).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(armar(s)), { TTL: 6 * 3600 });
        ok++;
      } catch (e: any) {
        mal++;
        if (e?.statusCode === 404 || e?.statusCode === 410) lyRest(`fp_push_subs?id=eq.${s.id}`, { method: "DELETE" }).catch(() => {});
      }
    }));
  }
  return { ok, mal };
}
const subsDe = (progId: string) => lyRest(`fp_push_subs?program_id=eq.${progId}&select=id,member_id,endpoint,p256dh,auth,loyalty_members(nombre,saldo,canjes,nacimiento)&limit=5000`);

// ── Cliente ─────────────────────────────────────────────────────────────────
app.get("/api/fp/:slug/push/clave", rateLimit(60, "fp-pushk"), (_req: any, res: any) => res.json({ clave: VAPID_PUB }));
app.post("/api/fp/:slug/push/suscribir", rateLimit(20, "fp-push"), async (req: any, res: any) => {
  try {
    const p = await progPorSlug(req.params.slug);
    if (!p) return res.status(404).json({ error: "Programa no disponible" });
    const { codigo, clave, sub } = req.body || {};
    const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${p.id}&codigo=eq.${enc(String(codigo || ""))}&select=id,qr_clave&limit=1`));
    if (!m || !iguales(m.qr_clave, clave)) return res.status(401).json({ error: "Tarjeta no válida en este teléfono" });
    const ep = String(sub?.endpoint || ""), k = sub?.keys || {};
    if (!/^https:\/\/[^\s]{10,500}$/.test(ep) || !k.p256dh || !k.auth || String(k.p256dh).length > 200 || String(k.auth).length > 100) return res.status(400).json({ error: "Suscripción no válida" });
    await lyRest("fp_push_subs?on_conflict=endpoint", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ program_id: p.id, member_id: m.id, endpoint: ep, p256dh: String(k.p256dh), auth: String(k.auth), ua: String(req.headers["user-agent"] || "").slice(0, 160) }) });
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "push suscribir"); }
});
app.post("/api/fp/:slug/push/baja", rateLimit(20, "fp-push"), async (req: any, res: any) => {
  try {
    const p = await progPorSlug(req.params.slug);
    if (!p) return res.status(404).json({ error: "Programa no disponible" });
    const { codigo, clave, endpoint } = req.body || {};
    const m = lyUno(await lyRest(`loyalty_members?program_id=eq.${p.id}&codigo=eq.${enc(String(codigo || ""))}&select=id,qr_clave&limit=1`));
    if (!m || !iguales(m.qr_clave, clave)) return res.status(401).json({ error: "Tarjeta no válida" });
    await lyRest(`fp_push_subs?member_id=eq.${m.id}&endpoint=eq.${enc(String(endpoint || ""))}`, { method: "DELETE" });
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "push baja"); }
});

// ── Admin ───────────────────────────────────────────────────────────────────
app.get("/api/fp/admin/avisos", adminAuth, async (req: any, res: any) => {
  try {
    const p = req.p;
    const avisos = await lyRest(`fp_avisos?program_id=eq.${p.id}&select=*&order=created_at.desc&limit=100`);
    const envios = await lyRest(`fp_envios?program_id=eq.${p.id}&select=*&order=created_at.desc&limit=40`);
    const subs = await lyRest(`fp_push_subs?program_id=eq.${p.id}&select=member_id&limit=5000`);
    res.json({ avisos, envios, auto: autoDe(p), tope: p.aviso_tope_sem ?? 3, suscritos: new Set(subs.map((s: any) => s.member_id)).size, configurado: !!(VAPID_PUB && VAPID_PRV) });
  } catch (e) { fallo(res, e, "avisos"); }
});
const textoAviso = (b: any) => ({ titulo: limpio(b?.titulo, 60), cuerpo: limpio(b?.cuerpo, 180) });
app.post("/api/fp/admin/avisos/enviar", rateLimit(10, "fp-avisoenv"), adminAuth, async (req: any, res: any) => {
  try {
    const { titulo, cuerpo } = textoAviso(req.body);
    if (!titulo || !cuerpo) return res.status(400).json({ error: "Escribe el título y el mensaje" });
    const subs = await subsDe(req.p.id);
    const r = await enviarPush(subs, (s: any) => ({ title: rellenar(titulo, s.loyalty_members, req.p), body: rellenar(cuerpo, s.loyalty_members, req.p), url: "./", tag: "fp-manual" }));
    await lyRest("fp_envios", { method: "POST", body: JSON.stringify({ program_id: req.p.id, origen: "Manual", titulo, cuerpo, enviados: r.ok, fallidos: r.mal }) });
    res.json({ ok: true, enviados: r.ok, fallidos: r.mal });
  } catch (e) { fallo(res, e, "avisos enviar"); }
});
app.post("/api/fp/admin/avisos/guardar", adminAuth, async (req: any, res: any) => {
  try {
    const b = req.body || {}; const { titulo, cuerpo } = textoAviso(b);
    if (!titulo || !cuerpo) return res.status(400).json({ error: "Escribe el título y el mensaje" });
    const hora = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.hora)) ? b.hora : "18:30";
    const tipo = b.tipo === "repetido" ? "repetido" : "unico";
    const dias = Array.isArray(b.dias) ? [...new Set(b.dias.map((d: any) => parseInt(d, 10)).filter((d: number) => d >= 0 && d <= 6))] : [];
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || "")) ? b.fecha : null;
    if (tipo === "repetido" && !dias.length) return res.status(400).json({ error: "Elige al menos un día" });
    if (tipo === "unico" && !fecha) return res.status(400).json({ error: "Elige la fecha" });
    const fila = { titulo, cuerpo, tipo, hora, dias: tipo === "repetido" ? dias : [], fecha: tipo === "unico" ? fecha : null, activo: b.activo !== false };
    if (b.id) {
      if (!UUID.test(String(b.id))) return res.status(400).json({ error: "Aviso no válido" });
      await lyRest(`fp_avisos?id=eq.${b.id}&program_id=eq.${req.p.id}`, { method: "PATCH", body: JSON.stringify({ ...fila, ultimo_envio: null }) });
    } else {
      await lyRest("fp_avisos", { method: "POST", body: JSON.stringify({ ...fila, program_id: req.p.id }) });
    }
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "avisos guardar"); }
});
app.post("/api/fp/admin/avisos/borrar", adminAuth, async (req: any, res: any) => {
  try {
    if (!UUID.test(String(req.body?.id || ""))) return res.status(400).json({ error: "Aviso no válido" });
    await lyRest(`fp_avisos?id=eq.${req.body.id}&program_id=eq.${req.p.id}`, { method: "DELETE" });
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "avisos borrar"); }
});
app.post("/api/fp/admin/avisos/auto", adminAuth, async (req: any, res: any) => {
  try {
    const b = req.body?.auto || {}; const sal: any = {};
    for (const k of Object.keys(AUTO_DEF)) {
      const x = b[k] || {};
      sal[k] = { activo: !!x.activo, titulo: limpio(x.titulo, 60) || AUTO_DEF[k].titulo, cuerpo: limpio(x.cuerpo, 180) || AUTO_DEF[k].cuerpo };
      if (AUTO_DEF[k].hora) sal[k].hora = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x.hora)) ? x.hora : AUTO_DEF[k].hora;
      if (AUTO_DEF[k].dias) sal[k].dias = Math.min(180, Math.max(1, parseInt(x.dias, 10) || AUTO_DEF[k].dias));
    }
    const tope = Math.min(14, Math.max(1, parseInt(req.body?.tope, 10) || 3));
    await lyRest(`loyalty_programs?id=eq.${req.p.id}`, { method: "PATCH", body: JSON.stringify({ avisos_auto: sal, aviso_tope_sem: tope }) });
    res.json({ ok: true });
  } catch (e) { fallo(res, e, "avisos auto"); }
});

// ── Disparador (lo llama pg_cron cada minuto) ───────────────────────────────
// Cada aviso automático se anota en fp_aviso_log con una clave única por socio y periodo:
// así nunca se repite, aunque el disparador corra dos veces. El tope semanal no aplica a cumpleaños.
async function mandarAuto(p: any, clave: string, cfg: any, m: any, subs: any[], topeDesde: string, sinTope = false) {
  try { await lyRest("fp_aviso_log", { method: "POST", body: JSON.stringify({ member_id: m.id, clave }) }); } catch { return 0; }
  if (!sinTope) {
    const usados = await lyRest(`fp_aviso_log?member_id=eq.${m.id}&created_at=gte.${topeDesde}&select=id&limit=50`);
    if (usados.length > (p.aviso_tope_sem ?? 3)) return 0;
  }
  const r = await enviarPush(subs, () => ({ title: rellenar(cfg.titulo, m, p), body: rellenar(cfg.cuerpo, m, p), url: "./", tag: "fp-" + clave.split(":")[0] }));
  return r.ok;
}
app.post("/api/fp/cron", async (req: any, res: any) => {
  try {
    if (!CRON_KEY || !iguales(String(req.headers["x-cron"] || ""), CRON_KEY)) return res.status(401).json({ error: "No autorizado" });
    const t = hoyChile();
    const resumen: any = {};
    const progs = await lyRest("loyalty_programs?activo=eq.true&select=*");
    for (const p of progs) {
      const subsAll = await subsDe(p.id);
      if (!subsAll.length) continue;
      const porMiembro = new Map<string, any[]>();
      for (const s of subsAll) { if (!porMiembro.has(s.member_id)) porMiembro.set(s.member_id, []); porMiembro.get(s.member_id)!.push(s); }
      const topeDesde = new Date(Date.now() - 7 * 86400000).toISOString();
      const auto = autoDe(p);
      const conSubs = async (filtro: string) =>
        (await lyRest(`loyalty_members?program_id=eq.${p.id}&${filtro}&select=id,nombre,saldo,canjes,nacimiento,ultima_visita,ultimo_sello,created_at&limit=3000`)).filter((m: any) => porMiembro.has(m.id));

      // 1) Avisos programados
      const progr = await lyRest(`fp_avisos?program_id=eq.${p.id}&activo=eq.true&select=*`);
      for (const a of progr) {
        if (a.hora > t.hhmm || a.ultimo_envio === t.fecha) continue;
        if (a.tipo === "unico" ? a.fecha !== t.fecha : !(a.dias || []).includes(t.dow)) continue;
        // Se marca antes de enviar: si el disparador corre dos veces, no se duplica.
        const marcado = await lyRest(`fp_avisos?id=eq.${a.id}&or=(ultimo_envio.is.null,ultimo_envio.neq.${t.fecha})`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ultimo_envio: t.fecha, ...(a.tipo === "unico" ? { activo: false } : {}) }) });
        if (!marcado.length) continue;
        const r = await enviarPush(subsAll, (s: any) => ({ title: rellenar(a.titulo, s.loyalty_members, p), body: rellenar(a.cuerpo, s.loyalty_members, p), url: "./", tag: "fp-prog-" + a.id }));
        await lyRest("fp_envios", { method: "POST", body: JSON.stringify({ program_id: p.id, origen: "Programado", titulo: a.titulo, cuerpo: a.cuerpo, enviados: r.ok, fallidos: r.mal }) });
        resumen["prog:" + a.id] = r.ok;
      }

      // 2) Cumpleaños, a la hora elegida
      if (auto.cumple.activo && p.cumple_activo !== false && auto.cumple.hora <= t.hhmm) {
        let n = 0;
        for (const m of (await conSubs("nacimiento=not.is.null")).filter((m: any) => String(m.nacimiento).slice(5, 10) === t.mmdd))
          n += await mandarAuto(p, "cumple:" + t.anio, auto.cumple, m, porMiembro.get(m.id)!, topeDesde, true);
        if (n) { resumen.cumple = n; await lyRest("fp_envios", { method: "POST", body: JSON.stringify({ program_id: p.id, origen: "Cumpleaños", titulo: auto.cumple.titulo, cuerpo: auto.cumple.cuerpo, enviados: n, fallidos: 0 }) }); }
      }

      // 3) Tras un sello (últimos 15 minutos): gracias, falta 1 sello, premio listo
      const recientes = await conSubs(`ultimo_sello=gte.${new Date(Date.now() - 15 * 60000).toISOString()}`);
      for (const m of recientes) {
        const subs = porMiembro.get(m.id)!; let n = 0;
        if (m.saldo >= p.meta && auto.premio.activo) n += await mandarAuto(p, "premio:" + m.canjes, auto.premio, m, subs, topeDesde);
        else if (m.saldo === p.meta - 1 && auto.falta1.activo) n += await mandarAuto(p, "falta1:" + m.canjes, auto.falta1, m, subs, topeDesde);
        else if (auto.gracias.activo) n += await mandarAuto(p, "gracias:" + String(m.ultimo_sello).slice(0, 16), auto.gracias, m, subs, topeDesde);
        if (n) resumen.sello = (resumen.sello || 0) + n;
      }

      // 4) Descuento de bienvenida sin usar tras N días (a su hora)
      if (auto.bienvenida.activo && auto.bienvenida.hora <= t.hhmm) {
        const hasta = new Date(Date.now() - auto.bienvenida.dias * 86400000).toISOString();
        const cup = await lyRest(`loyalty_coupons?tipo=eq.bienvenida&estado=eq.activo&created_at=lte.${hasta}&select=member_id,loyalty_members!inner(program_id)&loyalty_members.program_id=eq.${p.id}&limit=3000`);
        let n = 0;
        for (const c of cup) {
          const subs = porMiembro.get(c.member_id); if (!subs) continue;
          const m = subsAll.find((s: any) => s.member_id === c.member_id)?.loyalty_members; if (!m) continue;
          n += await mandarAuto(p, "bienvenida", auto.bienvenida, { id: c.member_id, ...m }, subs, topeDesde);
        }
        if (n) resumen.bienvenida = n;
      }

      // 5) Clientes que no vienen hace N días (a su hora; una vez por tramo de N días)
      if (auto.inactivo.activo && auto.inactivo.hora <= t.hhmm) {
        const dias = auto.inactivo.dias, corte = new Date(Date.now() - dias * 86400000).toISOString();
        const tramo = Math.floor(Date.now() / 86400000 / dias);
        let n = 0;
        for (const m of await conSubs(`or=(ultima_visita.lte.${corte},and(ultima_visita.is.null,created_at.lte.${corte}))`))
          n += await mandarAuto(p, "inactivo:" + tramo, auto.inactivo, m, porMiembro.get(m.id)!, topeDesde);
        if (n) resumen.inactivo = n;
      }
    }
    res.json({ ok: true, resumen });
  } catch (e) { fallo(res, e, "cron"); }
});

// ===========================================================================
// Servidor HTTP: CORS, parseo y despacho
// ===========================================================================
const SEGURIDAD = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

Deno.serve(async (request: Request) => {
  const origen = request.headers.get("origin") || "";
  const cors: Record<string, string> = { ...SEGURIDAD, Vary: "Origin" };
  if (origen && ORIGENES.includes(origen)) {
    cors["Access-Control-Allow-Origin"] = origen;
    cors["Access-Control-Allow-Headers"] = "authorization, content-type";
    cors["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    cors["Access-Control-Max-Age"] = "86400";
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const out = (status: number, data: any) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/(functions\/v1\/)?fp(?=\/|$)/, "") || "/";
  if (path === "/api/health") return out(200, { ok: true, configurado: SB_URL !== "" && SB_KEY !== "" && SECRET.length >= 32 });

  let body: any = {};
  if (request.method === "POST") {
    const txt = await request.text();
    if (txt.length > 200_000) return out(413, { error: "Pedido demasiado grande" });
    try { body = txt ? JSON.parse(txt) : {}; } catch { return out(400, { error: "JSON no válido" }); }
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const query = Object.fromEntries(url.searchParams.entries());

  for (const r of rutas) {
    if (r.metodo !== request.method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.claves.forEach((k: string, i: number) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
    const req: any = { params, body, query, headers };
    let resuelto: Response | null = null;
    const res: any = {
      _s: 200,
      status(n: number) { this._s = n; return this; },
      json(d: any) { resuelto = out(this._s, d); return this; },
    };
    let siguiente = false;
    for (const h of r.handlers) {
      siguiente = false;
      try { await h(req, res, () => { siguiente = true; }); }
      catch (e: any) { console.error("fp excepción:", e?.message); return out(500, { error: "Error interno, intenta de nuevo" }); }
      if (resuelto) return resuelto;
      if (!siguiente) break;
    }
    if (resuelto) return resuelto;
    // `next()` del último handler: sigue con la ruta que venga después (p. ej. /api/fp/admin/programa).
  }
  return out(404, { error: "No existe" });
});
