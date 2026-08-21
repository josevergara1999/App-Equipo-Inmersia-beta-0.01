// Carga .env en desarrollo local. En Render las variables vienen del entorno y no hay
// archivo, por eso el require va envuelto: sin esto, dotenv figuraba en package.json
// pero no se usaba y no había forma de configurar nada fuera de Render.
try { require("dotenv").config(); } catch (e) { /* dotenv es opcional */ }

const express = require("express");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// El webhook de Instagram firma el cuerpo CRUDO en `X-Hub-Signature-256`. Validar sobre el
// JSON re-serializado no funciona nunca: basta una coma o un orden de claves distinto para que
// el HMAC no calce. Por eso se guarda el buffer original al vuelo.
// Límite generoso: los arrays de tareas/planners/prospectos pasan de los 100 KB por defecto de
// Express, y ahora se guardan a través del servidor (antes iban directos a Supabase sin tope).
// Los binarios NO van por aquí: se suben a Storage por /api/upload. Todo detrás de requireAuth.
app.use(express.json({ limit: "15mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ===============================
// 🔐 AUTH TOKENS
// ===============================
const JWT_SECRET = process.env.JWT_SECRET || (process.env.GOOGLE_CLIENT_SECRET || "inm") + "_inm_jwt_2026";

function signToken(email) {
  const exp = Date.now() + 30 * 24 * 3600000;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifyToken(token) {
  try {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function parseCookies(req) {
  const list = {};
  (req.headers.cookie || "").split(";").forEach(c => {
    const [k, ...v] = c.split("=");
    if (k?.trim()) list[k.trim()] = decodeURIComponent(v.join("=").trim());
  });
  return list;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const cookieToken = cookies._iauth || "";
  const headerToken = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!verifyToken(cookieToken || headerToken)) return res.status(401).json({ error: "No autorizado" });
  next();
}

// ===============================
// 🚦 RATE LIMITER
// ===============================
const _hits = new Map();
setInterval(() => _hits.clear(), 60000);

// Un balde POR RUTA y por IP, no uno solo compartido.
//
// Antes la cuenta era solo por IP: todas las rutas sumaban al mismo contador y cada una lo
// comparaba contra SU tope, así que el más estricto mandaba sobre todos. Con el tope general de
// `/api` en 120, cualquier ruta con un tope menor quedaba inalcanzable en cuanto la app hacía sus
// primeras llamadas. Lo rompía de verdad en fidelización: el cliente final se inscribe desde el
// wifi del local, el MISMO que usa el tablet con la app abierta; el tablet pasaba de 20 llamadas
// en un minuto sin despeinarse y a la persona del mesón le salía "demasiadas solicitudes" al
// tocar Inscribirme, sin haber pedido nada dos veces.
function rateLimit(max, tag) {
  const balde = tag || "r" + max;
  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const clave = balde + "|" + ip;
    const n = (_hits.get(clave) || 0) + 1;
    _hits.set(clave, n);
    if (n > max) return res.status(429).json({ error: "Demasiadas solicitudes, espera un momento" });
    next();
  };
}

// ===============================
// 🛡️ SECURITY HEADERS + CORS
// ===============================
const ALLOWED_ORIGINS = new Set([
  "https://app-equipo-inmersia-beta-0-01.onrender.com",
  process.env.APP_URL,
  "http://localhost:10000"
].filter(Boolean));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use("/api", rateLimit(120, "api"));

// ===============================
// ✅ igId WHITELIST
// ===============================
let _igCache = null, _igCacheAt = 0;
async function isValidIgId(igId) {
  const now = Date.now();
  if (_igCache && now - _igCacheAt < 300000) return _igCache.has(igId);
  try {
    const sbUrl = process.env.SUPABASE_URL || "https://cvytwyvaxccbcpfqezlr.supabase.co";
    const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
    const r = await fetch(`${sbUrl}/rest/v1/app_data?key=eq.companies&select=value`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
    });
    const d = await r.json();
    const cos = d?.[0]?.value || [];
    _igCache = new Set(cos.filter(c => c.igId).map(c => String(c.igId)));
    _igCacheAt = now;
    return _igCache.has(igId);
  } catch { return true; } // si Supabase falla, no bloqueamos
}

// ===============================
// 📧 RESEND EMAIL
// ===============================
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log("RESEND_API_KEY no configurada, skip:", subject); return null; }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "INMERSIA <notificaciones@inmersiaperformance.cl>",
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      })
    });
    const data = await r.json();
    if (data.error) console.error("Resend error:", JSON.stringify(data.error));
    else console.log("Email enviado:", subject, "->", to);
    return data;
  } catch (err) {
    console.error("Error email:", err.message);
    return { error: err.message };
  }
}

// ===============================
// 📧 TEST EMAIL
// ===============================
app.get("/api/test-email", requireAuth, async (req, res) => {
  try {
    const testTo = process.env.EMAIL_USER || "inmersiatours@gmail.com";
    const result = await sendEmail(
      testTo,
      "🧪 Test INMERSIA - Email funcionando",
      `<div style="font-family:Arial;padding:20px;background:#12121f;color:#e8e6f0;border-radius:12px"><h2 style="color:#c9a0ff">INMERSIA</h2><p>Las notificaciones por email están funcionando correctamente ✅</p></div>`
    );
    res.json({ ok: true, msg: "Email enviado a " + testTo, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 📧 NOTIFICACIÓN POR EMAIL
// ===============================
app.post("/api/notify", requireAuth, async (req, res) => {
  try {
    const { type, to, taskTitle, company, assignee, date, state, details } = req.body;

    if (!to || !to.length) return res.json({ ok: false, msg: "Sin destinatarios" });

    const appUrl = process.env.APP_URL || "https://app-equipo-inmersia-beta-0-01.onrender.com";

    const templates = {
      task_assigned: {
        subject: `📋 Nueva tarea asignada: ${taskTitle}`,
        html: `
          <div style="font-family:'Outfit',Arial,sans-serif;max-width:520px;margin:0 auto;background:#12121f;color:#e8e6f0;border-radius:16px;overflow:hidden;border:1px solid #2a2a4a">
            <div style="background:linear-gradient(135deg,#7c3aed,#9d6bff);padding:18px 24px">
              <h2 style="margin:0;font-size:16px;color:#fff">📋 Tarea Asignada</h2>
            </div>
            <div style="padding:24px">
              <h3 style="margin:0 0 12px;color:#c9a0ff">${taskTitle}</h3>
              <table style="width:100%;font-size:13px;color:#8886a0">
                <tr><td style="padding:4px 0">🏢 Empresa</td><td style="color:#e8e6f0">${company || '-'}</td></tr>
                <tr><td style="padding:4px 0">👤 Asignado a</td><td style="color:#e8e6f0">${assignee || '-'}</td></tr>
                <tr><td style="padding:4px 0">📅 Fecha</td><td style="color:#e8e6f0">${date || 'Sin fecha'}</td></tr>
              </table>
              <a href="${appUrl}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:linear-gradient(135deg,#7c3aed,#9d6bff);color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px">Ver en INMERSIA →</a>
            </div>
          </div>`
      },
      task_status: {
        subject: `🔄 Tarea actualizada: ${taskTitle} → ${state}`,
        html: `
          <div style="font-family:'Outfit',Arial,sans-serif;max-width:520px;margin:0 auto;background:#12121f;color:#e8e6f0;border-radius:16px;overflow:hidden;border:1px solid #2a2a4a">
            <div style="background:linear-gradient(135deg,#4ecdc4,#6bcbff);padding:18px 24px">
              <h2 style="margin:0;font-size:16px;color:#fff">🔄 Estado Actualizado</h2>
            </div>
            <div style="padding:24px">
              <h3 style="margin:0 0 12px;color:#c9a0ff">${taskTitle}</h3>
              <div style="display:inline-block;padding:5px 14px;background:#252542;border-radius:20px;font-size:12px;font-weight:600;color:#4ecdc4;margin-bottom:12px">${state}</div>
              <table style="width:100%;font-size:13px;color:#8886a0">
                <tr><td style="padding:4px 0">🏢 Empresa</td><td style="color:#e8e6f0">${company || '-'}</td></tr>
                <tr><td style="padding:4px 0">📅 Fecha</td><td style="color:#e8e6f0">${date || 'Sin fecha'}</td></tr>
              </table>
              <a href="${appUrl}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:linear-gradient(135deg,#7c3aed,#9d6bff);color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px">Ver en INMERSIA →</a>
            </div>
          </div>`
      },
      task_approval: {
        subject: `✅ Tarea lista para aprobar: ${taskTitle}`,
        html: `
          <div style="font-family:'Outfit',Arial,sans-serif;max-width:520px;margin:0 auto;background:#12121f;color:#e8e6f0;border-radius:16px;overflow:hidden;border:1px solid #2a2a4a">
            <div style="background:linear-gradient(135deg,#f0c040,#d4a020);padding:18px 24px">
              <h2 style="margin:0;font-size:16px;color:#000">✅ Aprobación Pendiente</h2>
            </div>
            <div style="padding:24px">
              <h3 style="margin:0 0 12px;color:#c9a0ff">${taskTitle}</h3>
              <p style="font-size:13px;color:#8886a0">Esta tarea necesita tu aprobación.</p>
              <table style="width:100%;font-size:13px;color:#8886a0">
                <tr><td style="padding:4px 0">🏢 Empresa</td><td style="color:#e8e6f0">${company || '-'}</td></tr>
                <tr><td style="padding:4px 0">📅 Fecha</td><td style="color:#e8e6f0">${date || 'Sin fecha'}</td></tr>
              </table>
              <a href="${appUrl}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:linear-gradient(135deg,#f0c040,#d4a020);color:#000;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px">Aprobar en INMERSIA →</a>
            </div>
          </div>`
      },
      task_deadline: {
        subject: `⚠️ Tarea próxima a vencer: ${taskTitle}`,
        html: `
          <div style="font-family:'Outfit',Arial,sans-serif;max-width:520px;margin:0 auto;background:#12121f;color:#e8e6f0;border-radius:16px;overflow:hidden;border:1px solid #2a2a4a">
            <div style="background:linear-gradient(135deg,#ff4444,#ff6b6b);padding:18px 24px">
              <h2 style="margin:0;font-size:16px;color:#fff">⚠️ Deadline Próximo</h2>
            </div>
            <div style="padding:24px">
              <h3 style="margin:0 0 12px;color:#c9a0ff">${taskTitle}</h3>
              <p style="font-size:13px;color:#ff6b6b;font-weight:600">Esta tarea vence el ${date}</p>
              <table style="width:100%;font-size:13px;color:#8886a0">
                <tr><td style="padding:4px 0">🏢 Empresa</td><td style="color:#e8e6f0">${company || '-'}</td></tr>
                <tr><td style="padding:4px 0">👤 Responsable</td><td style="color:#e8e6f0">${assignee || '-'}</td></tr>
              </table>
              <a href="${appUrl}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:linear-gradient(135deg,#ff4444,#ff6b6b);color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px">Ver en INMERSIA →</a>
            </div>
          </div>`
      },
      meeting_acta: {
        subject: `🎙️ Acta de reunión: ${company}`,
        html: `
          <div style="font-family:'Outfit',Arial,sans-serif;max-width:520px;margin:0 auto;background:#12121f;color:#e8e6f0;border-radius:16px;overflow:hidden;border:1px solid #2a2a4a">
            <div style="background:linear-gradient(135deg,#9d6bff,#c9a0ff);padding:18px 24px">
              <h2 style="margin:0;font-size:16px;color:#fff">🎙️ Acta de Reunión</h2>
            </div>
            <div style="padding:24px">
              <h3 style="margin:0 0 12px;color:#c9a0ff">Reunión ${company}</h3>
              <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;padding:14px;font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:400px;overflow:auto">${details || ''}</div>
              <a href="${appUrl}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:linear-gradient(135deg,#7c3aed,#9d6bff);color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px">Ver en INMERSIA →</a>
            </div>
          </div>`
      }
    };

    const tpl = templates[type];
    if (!tpl) return res.json({ ok: false, msg: "Tipo no válido" });

    const recipients = Array.isArray(to) ? to : [to];
    for (const email of recipients) {
      await sendEmail(email, tpl.subject, tpl.html);
    }

    // Además del correo, notificación push a los mismos destinatarios. El correo se
    // mantiene como respaldo: el push en iOS es "best effort" y una suscripción puede
    // morir sin aviso.
    let push = { sent: 0 };
    try {
      push = await sendPush({
        title: company ? `INMERSIA · ${company}` : "INMERSIA",
        body: (state || tpl.subject || "").replace(/<[^>]*>/g, "").slice(0, 160) + (taskTitle ? ` — ${taskTitle}` : ""),
        url: "/",
        tag: type,
        important: type === "task_status",
      }, recipients);
    } catch (e) { console.error("push desde notify:", e.message); }

    res.json({ ok: true, sent: recipients.length, push });

  } catch (err) {
    console.error("Error notify:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🔑 LOGIN Y CONTRASEÑAS
// ===============================
// Antes el login era 100% de navegador: las contraseñas venían en INIT_USERS dentro del
// HTML y nunca se emitía cookie de sesión. Por eso solo quien entraba con Google podía
// usar los endpoints protegidos (push, notificaciones, IA). Aquí se verifica en el
// servidor y se emite la misma cookie `_iauth` que el OAuth de Google.
//
// LÍMITE CONOCIDO: mientras INIT_USERS siga en el HTML con la contraseña por defecto,
// cualquiera puede leerla viendo el código fuente. Esto arregla la persistencia y la
// sesión, no convierte el login en algo robusto hasta sacar esa lista del cliente.
const DEFAULT_PASS = "1234";

async function loadCreds() {
  const { url, key } = SB();
  const r = await fetch(`${url}/rest/v1/app_data?key=eq.user_creds&select=value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const d = await r.json();
  return (d?.[0]?.value && typeof d[0].value === "object") ? d[0].value : {};
}
async function saveCreds(obj) {
  const { url, key } = SB();
  await fetch(`${url}/rest/v1/app_data`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: "user_creds", value: obj, updated_at: new Date().toISOString() }),
  });
}
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 64).toString("hex");
const normUser = e => String(e || "").trim().toLowerCase();

function setAuthCookie(req, res, email) {
  // `secure` según el protocolo real: en Render llega por https detrás del proxy, en
  // local por http. Fijarlo en true haría que el navegador descartara la cookie en local.
  const https = req.headers["x-forwarded-proto"] === "https" || req.secure;
  res.cookie("_iauth", signToken(email), {
    httpOnly: true,
    secure: https,
    sameSite: "lax",
    maxAge: 30 * 24 * 3600000,
  });
}

app.post("/api/auth/login", rateLimit(30, "login"), async (req, res) => {
  try {
    const email = normUser(req.body?.email);
    const pass = String(req.body?.password || "");
    if (!email || !pass) return res.status(400).json({ error: "Faltan datos" });

    const creds = await loadCreds();
    const c = creds[email];
    // Sin contraseña guardada todavía → vale la de fábrica, para no dejar a nadie fuera
    const ok = c ? hashPass(pass, c.salt) === c.hash : pass === DEFAULT_PASS;
    if (!ok) return res.status(401).json({ error: "Credenciales incorrectas" });

    setAuthCookie(req, res, email);
    res.json({ ok: true, email, usandoClavePorDefecto: !c });
  } catch (err) { console.error("login:", err); res.status(500).json({ error: err.message }); }
});

app.post("/api/auth/password", requireAuth, rateLimit(20, "password"), async (req, res) => {
  try {
    const email = normUser(req.body?.email);
    const actual = String(req.body?.actual || "");
    const nueva = String(req.body?.nueva || "");
    if (!email) return res.status(400).json({ error: "Falta el usuario" });
    if (nueva.length < 6) return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });
    if (nueva === DEFAULT_PASS) return res.status(400).json({ error: "Elige una contraseña distinta a la de fábrica" });

    const creds = await loadCreds();
    const c = creds[email];
    const ok = c ? hashPass(actual, c.salt) === c.hash : actual === DEFAULT_PASS;
    if (!ok) return res.status(401).json({ error: "La contraseña actual no coincide" });

    const salt = crypto.randomBytes(16).toString("hex");
    creds[email] = { salt, hash: hashPass(nueva, salt), updatedAt: new Date().toISOString() };
    await saveCreds(creds);
    setAuthCookie(req, res, email);   // renueva la sesión con la clave nueva
    res.json({ ok: true });
  } catch (err) { console.error("password:", err); res.status(500).json({ error: err.message }); }
});

// ===============================
// 🔔 WEB PUSH (PWA — iOS 16.4+, Android, escritorio)
// ===============================
// Usa el estándar VAPID, el mismo en Safari/Chrome/Firefox. NO requiere cuenta de Apple
// Developer ni App Store: en iOS basta con que el usuario haga "Añadir a pantalla de
// inicio" (la Push API no existe en una pestaña normal de Safari).
const webpush = require("web-push");
const VAPID_PUB = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIV = process.env.VAPID_PRIVATE_KEY || "";
const pushReady = !!(VAPID_PUB && VAPID_PRIV);
if (pushReady) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:inmersiatours@gmail.com", VAPID_PUB, VAPID_PRIV);
} else {
  console.log("Web Push desactivado: faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY");
}

const SB = () => ({
  url: process.env.SUPABASE_URL || "https://cvytwyvaxccbcpfqezlr.supabase.co",
  key: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT",
});
async function loadSubs() {
  const { url, key } = SB();
  const r = await fetch(`${url}/rest/v1/app_data?key=eq.push_subs&select=value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const d = await r.json();
  return Array.isArray(d?.[0]?.value) ? d[0].value : [];
}
async function saveSubs(list) {
  const { url, key } = SB();
  await fetch(`${url}/rest/v1/app_data`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: "push_subs", value: list, updated_at: new Date().toISOString() }),
  });
}

// Envía a todas las suscripciones (o a las de ciertos emails) y limpia las muertas.
async function sendPush(payload, onlyEmails) {
  if (!pushReady) return { sent: 0, skipped: "sin llaves VAPID" };
  const subs = await loadSubs();
  // Una persona puede estar identificada por su correo de INMERSIA o por su Gmail (con el
  // que entra por Google). Se guardan los dos en la suscripción y basta que calce uno.
  const wanted = new Set((onlyEmails || []).map(e => String(e).toLowerCase().trim()).filter(Boolean));
  const target = wanted.size
    ? subs.filter(s => [s.email, s.gmail].some(e => e && wanted.has(String(e).toLowerCase())))
    : subs;
  if (!target.length) return { sent: 0 };

  const body = JSON.stringify(payload).slice(0, 3800); // tope del estándar: 4096 bytes
  const dead = [];
  let sent = 0;
  await Promise.all(target.map(async s => {
    try {
      await webpush.sendNotification(s.subscription, body, { TTL: 60 * 60 * 24, urgency: payload.important ? "high" : "normal" });
      sent++;
    } catch (err) {
      // 404/410 = suscripción muerta: se borra y la persona vuelve a activarla al entrar
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(s.subscription.endpoint);
      else console.error("Push error:", err.statusCode, err.body || err.message);
    }
  }));
  if (dead.length) await saveSubs(subs.filter(s => !dead.includes(s.subscription.endpoint)));
  return { sent, removed: dead.length };
}

app.get("/api/push/key", (req, res) => res.json({ publicKey: VAPID_PUB, ready: pushReady }));

app.post("/api/push/subscribe", requireAuth, async (req, res) => {
  try {
    const { subscription, email, gmail, name, renewedFrom } = req.body || {};
    if (!subscription?.endpoint) return res.status(400).json({ error: "subscription inválida" });
    const subs = await loadSubs();
    // Cuando iOS rota el endpoint, quien vuelve a suscribirse es el service worker, y ahí no
    // hay sesión ni perfil: lo único que sabe es cuál era el endpoint anterior. Si no se
    // hereda el correo, la suscripción queda anónima y deja de calzar con los avisos
    // dirigidos a esa persona — que son casi todos. El resultado era una suscripción viva a
    // la que no llegaba nada, y había que volver a activar el botón a mano.
    const previa = renewedFrom ? subs.find(s => s.subscription.endpoint === renewedFrom) : null;
    const rest = subs.filter(s =>
      s.subscription.endpoint !== subscription.endpoint &&
      s.subscription.endpoint !== renewedFrom);          // el endpoint viejo ya no sirve
    rest.push({
      subscription,
      email: email || previa?.email || "",
      gmail: gmail || previa?.gmail || "",
      name: name || previa?.name || "",
      createdAt: new Date().toISOString(),
    });
    await saveSubs(rest);
    res.json({ ok: true, total: rest.length, heredada: !!previa });
  } catch (err) { console.error("push subscribe:", err); res.status(500).json({ error: err.message }); }
});

app.post("/api/push/unsubscribe", requireAuth, async (req, res) => {
  try {
    const ep = req.body?.endpoint;
    const subs = await loadSubs();
    await saveSubs(subs.filter(s => s.subscription.endpoint !== ep));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/push/test", requireAuth, async (req, res) => {
  const r = await sendPush({
    title: "INMERSIA",
    body: req.body?.body || "Notificaciones activadas correctamente ✅",
    url: "/",
  }, req.body?.email ? [req.body.email] : null);
  res.json(r);
});

// ── Reuniones con Google Meet ────────────────────────────────────────────────
// La invitación la manda Google Calendar a nombre de la cuenta organizadora, así que esa
// cuenta (inmersiatours) tiene que haber conectado su calendario una vez desde la app.
// `conferenceDataVersion=1` es lo que hace que Google genere el enlace de Meet, y
// `sendUpdates=all` es lo que hace que le llegue el correo a cada invitado.
const MEET_ORGANIZER = process.env.MEET_ORGANIZER || "inmersiatours@gmail.com";
const MEET_TZ = "America/Santiago";

app.get("/api/gcal/status", requireAuth, async (req, res) => {
  try {
    const email = req.query.email || MEET_ORGANIZER;
    const tokens = (await sbGet("gcal_tokens", {})) || {};
    res.json({ organizador: MEET_ORGANIZER, conectado: !!tokens[email]?.refresh_token, email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/gcal/meeting", requireAuth, async (req, res) => {
  try {
    const { title, description, date, time, minutos, invitados } = req.body || {};
    if (!title || !date || !time) return res.json({ ok: false, msg: "Faltan título, fecha u hora" });

    // El organizador SIEMPRE es la cuenta de INMERSIA, lo cree quien lo cree. No se acepta
    // por parámetro a propósito: si se pudiera mandar desde el navegador, cualquiera con
    // sesión podría crear eventos en el calendario personal de otro del equipo, y además la
    // invitación llegaría a nombre de una persona en vez de la empresa.
    const quien = MEET_ORGANIZER;

    // Se separan los dos fallos: no haber conectado nunca, o que Google rechace el refresh
    // (permiso revocado, cliente OAuth mal configurado). El mensaje no es el mismo.
    const tokens = (await sbGet("gcal_tokens", {})) || {};
    if (!tokens[quien]?.refresh_token) {
      return res.json({ ok: false, needsConnect: true, organizador: quien, msg: `Falta conectar el Google Calendar de ${quien}` });
    }
    const token = await getGCalAccessToken(quien);
    if (!token) return res.json({ ok: false, organizador: quien, msg: `Google rechazó el acceso al calendario de ${quien}. Hay que volver a conectarlo.` });

    const [h, m] = String(time).split(":").map(Number);
    const dur = Math.max(15, +minutos || 60);
    // El fin se calcula sobre la fecha real del evento, no sobre un día fijo: una reunión que
    // cruza medianoche (23:30 + 60 min) tiene que terminar el día siguiente. Con el día fijo,
    // `hhmm` descartaba el desbordamiento y el fin quedaba "00:30" en la MISMA fecha, antes que el
    // inicio, y Google rechazaba el evento o lo creaba al revés.
    const [Y, Mo, Da] = String(date).split("-").map(Number);
    const ini = new Date(Y, (Mo || 1) - 1, Da || 1, h, m);
    const fin = new Date(ini.getTime() + dur * 60000);
    const pad = n => String(n).padStart(2, "0");
    const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const correos = [...new Set((invitados || []).map(e => String(e).trim().toLowerCase()).filter(e => e.includes("@")))];
    const evento = {
      summary: title,
      description: description || "",
      start: { dateTime: `${date}T${time}:00`, timeZone: MEET_TZ },
      end: { dateTime: `${ymd(fin)}T${hhmm(fin)}:00`, timeZone: MEET_TZ },
      attendees: correos.map(email => ({ email })),
      conferenceData: { createRequest: { requestId: "inm-" + Date.now(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      guestsCanModify: false,
      reminders: { useDefault: true },
    };

    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(evento),
    });
    const d = await r.json();
    if (d.error) { console.error("GCal meeting:", d.error); return res.json({ ok: false, msg: d.error.message }); }

    res.json({
      ok: true,
      eventId: d.id,
      meetLink: d.hangoutLink || d.conferenceData?.entryPoints?.find(p => p.entryPointType === "video")?.uri || "",
      htmlLink: d.htmlLink || "",
      invitados: correos,
      organizador: quien,
    });
  } catch (err) { console.error("meeting:", err); res.status(500).json({ error: err.message }); }
});

// ===============================
// 🔔 CENTRO DE NOTIFICACIONES
// ===============================
// El push es el aviso del momento; esto es el historial. Se guarda SIEMPRE, aunque el push
// falle o la persona no tenga la app instalada, así nada se pierde. Vive en app_data.notifs.
const NOTIF_MAX = 300;
const norm = e => String(e || "").toLowerCase().trim();

async function sbGet(key, fallback) {
  const { url, key: k } = SB();
  const r = await fetch(`${url}/rest/v1/app_data?key=eq.${encodeURIComponent(key)}&select=value`, { headers: { apikey: k, Authorization: `Bearer ${k}` } });
  const d = await r.json();
  return d?.[0]?.value ?? fallback;
}
async function sbPut(key, value) {
  const { url, key: k } = SB();
  const r = await fetch(`${url}/rest/v1/app_data`, {
    method: "POST",
    headers: { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}
// Claves que NUNCA salen del servidor: son tokens y secretos que solo maneja el backend (OAuth,
// webhooks, push). El frontend no los lee ni los escribe. Excluirlos del proxy hace que, aunque
// alguien con sesión válida —incluido un cliente— llame a /api/data, jamás reciba un token.
const CLAVES_PRIVADAS = new Set(["gcal_tokens", "meta_token", "user_creds", "ig", "push_subs", "social"]);

// ── Aislamiento por empresa (multi-cliente) ──────────────────────────────────
// `app_data` guarda una fila ÚNICA por clave: `tasks` es un solo array con las tareas de TODAS
// las empresas. Sin esto, cualquier cliente logueado (todos entran con la de fábrica 1234) podía
// pedir /api/data y recibir tareas, contratos, precios, pagos internos y prospectos de las demás
// empresas —y sobrescribirlos—. Las claves-token ya estaban tapadas por CLAVES_PRIVADAS; esto
// cierra la fuga de datos ENTRE clientes.
//
// Espejo backend de las cuentas role:"cliente" de INIT_USERS (frontend): email de acceso → nombre
// de empresa (debe calzar con companies[].name ignorando espacios/mayúsculas). Si agregas un
// cliente en el frontend, agrégalo aquí también. Aun si se te olvida, todo email SIN "@" se trata
// como cliente y, si no se resuelve su empresa, NO ve nada (fail-closed), nunca todo.
const CLIENTES = { huemul: "Huemul", fauna: "Fauna", antue: "Antue", valleaventura: "valle aventura" };

// Decodifica la sesión del request (cookie o Bearer).
function authInfo(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies._iauth || (req.headers.authorization || "").replace("Bearer ", "").trim());
}
// Si el que pide es un cliente devuelve el nombre de su empresa; si es equipo, null. Se calcula
// desde el email en cada request (no se confía en el token), así una sesión abierta antes de este
// cambio también queda scopeada.
function clienteDe(tok) {
  const email = tok && tok.email;
  if (!email) return null;
  const esCliente = (email in CLIENTES) || !String(email).includes("@");
  return esCliente ? (CLIENTES[email] || email) : null;
}
const _slug = s => String(s || "").toLowerCase().replace(/\s+/g, "");
// companyId (string) de la empresa del cliente, o null si no se resuelve (→ no ve nada).
async function idEmpresaCliente(coName, companiesArr) {
  const arr = Array.isArray(companiesArr) ? companiesArr : ((await sbGet("companies", [])) || []);
  const objetivo = _slug(coName);
  const found = arr.find(c => _slug(c.name) === objetivo);
  return found ? String(found.id) : null;
}
// Claves que un cliente puede LEER (ya scopeadas por scopeCliente). Todo lo demás ni lo ve.
const CLAVES_CLIENTE = ["companies", "tasks", "galerias"];
// Recorta el mapa completo a lo único que un cliente puede ver: SU empresa, SUS tareas y SUS
// sesiones de fotos.
async function scopeCliente(mapa, coName) {
  const companies = Array.isArray(mapa.companies) ? mapa.companies : [];
  const cid = await idEmpresaCliente(coName, companies);
  if (!cid) return { companies: [], tasks: [], galerias: [] }; // fail-closed
  const miCo = companies.find(c => String(c.id) === cid);
  const tasks = (Array.isArray(mapa.tasks) ? mapa.tasks : []).filter(t => String(t.companyId) === cid);
  // Sesiones de fotos: además de ser de SU empresa, tienen que estar publicadas. El equipo sube
  // el material a lo largo de la sesión y lo suelta cuando está revisado; una galería a medio
  // subir no puede aparecerle al cliente solo porque exista la fila.
  const galerias = (Array.isArray(mapa.galerias) ? mapa.galerias : [])
    .filter(g => g && String(g.companyId) === cid && g.visible !== false);
  return { companies: miCo ? [miCo] : [], tasks, galerias };
}

// Lee TODA la tabla de una vez (menos las privadas), con la forma { clave: valor } que espera el
// frontend.
async function sbGetAll() {
  const { url, key } = SB();
  const r = await fetch(`${url}/rest/v1/app_data?select=key,value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error("Supabase respondió " + r.status);
  const d = await r.json();
  const m = {}; (Array.isArray(d) ? d : []).forEach(x => { if (!CLAVES_PRIVADAS.has(x.key)) m[x.key] = x.value; }); return m;
}

// ── Proxy de datos (app_data) ────────────────────────────────────────────────
// El navegador YA NO habla con Supabase directamente. Antes la clave publishable vivía en el HTML
// y la tabla no tenía RLS, así que cualquiera con ver-código-fuente leía los tokens de los
// clientes y podía borrar la base entera. Ahora todo pasa por aquí, con sesión (requireAuth) y la
// service_role del servidor. Cuando se active RLS en Supabase, este es el único camino que sigue
// funcionando; el acceso anónimo directo queda cerrado.
app.get("/api/data", requireAuth, async (req, res) => {
  try {
    const todo = await sbGetAll();
    const co = clienteDe(authInfo(req));
    // Un cliente solo se lleva SU empresa y SUS tareas; el resto ni lo ve.
    res.json(co ? await scopeCliente(todo, co) : todo);
  } catch (e) { console.error("data all:", e.message); res.status(502).json({ error: e.message }); }
});
app.get("/api/data/:key", requireAuth, async (req, res) => {
  // Los tokens no se sirven por aquí ni aunque se pidan por su nombre exacto.
  if (CLAVES_PRIVADAS.has(req.params.key)) return res.status(403).json({ error: "clave no accesible" });
  try {
    const co = clienteDe(authInfo(req));
    if (co) {
      // A un cliente, por clave suelta, solo se le entregan las de CLAVES_CLIENTE y ya scopeadas.
      if (!CLAVES_CLIENTE.includes(req.params.key)) return res.status(403).json({ error: "clave no accesible" });
      const scoped = await scopeCliente({
        tasks: await sbGet("tasks", []),
        companies: await sbGet("companies", []),
        galerias: await sbGet("galerias", []),
      }, co);
      return res.json({ value: scoped[req.params.key] || [] });
    }
    res.json({ value: await sbGet(req.params.key, null) });
  } catch (e) { console.error("data get:", e.message); res.status(502).json({ error: e.message }); }
});
app.post("/api/data/:key", requireAuth, async (req, res) => {
  // Y tampoco se pueden sobrescribir: los maneja solo el backend (callbacks de OAuth, etc.).
  if (CLAVES_PRIVADAS.has(req.params.key)) return res.status(403).json({ error: "clave no escribible" });
  try {
    if (!req.body || !("value" in req.body)) return res.status(400).json({ error: "falta value" });
    const co = clienteDe(authInfo(req));
    if (co) {
      // Un cliente SOLO puede escribir `tasks`, y por merge: se conservan intactas las tareas de
      // las demás empresas y solo se aceptan MODIFICACIONES a las suyas ya existentes. No puede
      // crear, borrar ni reasignar de empresa una tarea, ni tocar ninguna otra clave.
      if (req.params.key !== "tasks") return res.status(403).json({ error: "clave no escribible" });
      const cid = await idEmpresaCliente(co);
      if (!cid) return res.status(403).json({ error: "empresa no resuelta" });
      const actuales = (await sbGet("tasks", [])) || [];
      const propuestas = new Map((Array.isArray(req.body.value) ? req.body.value : []).map(t => [t.id, t]));
      // Un cliente no puede dar de baja una pieza, y hasta ahora eso se aplicaba CALLÁNDOSELO: el
      // map de abajo conserva lo que la propuesta no trae, así que la baja se ignoraba y el
      // servidor respondía 200. Quien la pedía veía la pieza desaparecer de su pantalla, recargaba
      // y volvía a estar. Peor cuando el que pedía era el equipo con la cookie de un cliente
      // (ver /api/auth/me): la app entera parecía funcionar y no guardaba nada de lo que borraba.
      // Rechazar en voz alta es la diferencia entre un permiso y un agujero negro.
      const suyas = actuales.filter(t => String(t.companyId) === cid);
      const bajas = suyas.filter(t => !propuestas.has(t.id)).map(t => t.id);
      if (bajas.length) return res.status(409).json({
        error: "un cliente no puede eliminar piezas",
        detalle: "La sesión activa es de cliente y pidió dar de baja " + bajas.length + " pieza(s). No se guardó nada.",
        codigo: "baja_no_permitida",
      });
      const nuevas = actuales.map(t =>
        (String(t.companyId) === cid && propuestas.has(t.id))
          ? { ...propuestas.get(t.id), companyId: t.companyId }  // fija la empresa: no se reasigna
          : t
      );
      const ok = await sbPut("tasks", nuevas);
      if (!ok) return res.status(502).json({ error: "Supabase rechazó la escritura" });
      return res.json({ ok: true });
    }
    const ok = await sbPut(req.params.key, req.body.value);
    if (!ok) return res.status(502).json({ error: "Supabase rechazó la escritura" });
    res.json({ ok: true });
  } catch (e) { console.error("data save:", e.message); res.status(502).json({ error: e.message }); }
});

// ── Favoritas del cliente en una sesión de fotos ─────────────────────────────
// Ruta propia y no `POST /api/data/galerias`: al cliente no se le puede dar esa clave para
// escribir —podría reescribir títulos, ocultar sesiones o borrarle las fotos a otro— y aquí lo
// único que se acepta es marcar/desmarcar UNA foto de UNA sesión suya. El servidor busca la
// sesión por id y comprueba que sea de su empresa y esté publicada: nada de eso viaja en el
// cuerpo, así que no hay nada que falsear desde el navegador.
//
// Va por `enCola`: `galerias` es una fila única y marcar favoritas es justo lo que se hace a
// ráfagas —cinco corazones seguidos—, que es el caso exacto del lost update.
app.post("/api/galerias/favorito", requireAuth, async (req, res) => {
  try {
    const { galeriaId, fotoId, fav } = req.body || {};
    if (!galeriaId || !fotoId) return res.status(400).json({ error: "faltan galeriaId y fotoId" });
    const co = clienteDe(authInfo(req));
    const cid = co ? await idEmpresaCliente(co) : null;
    if (co && !cid) return res.status(403).json({ error: "empresa no resuelta" });

    const guardado = await enCola(async () => {
      const galerias = (await sbGet("galerias", [])) || [];
      const g = galerias.find(x => x && String(x.id) === String(galeriaId));
      if (!g) return { estado: 404, error: "sesión no encontrada" };
      // Un cliente solo toca las suyas, y solo las que de verdad puede ver.
      if (co && (String(g.companyId) !== cid || g.visible === false))
        return { estado: 403, error: "sesión no accesible" };
      if (!(g.fotos || []).some(f => String(f.id) === String(fotoId)))
        return { estado: 404, error: "foto no encontrada" };
      const nuevas = galerias.map(x => x !== g ? x : {
        ...x,
        fotos: (x.fotos || []).map(f => String(f.id) === String(fotoId)
          ? { ...f, fav: !!fav, favAt: fav ? new Date().toISOString() : null }
          : f),
      });
      if (!(await sbPut("galerias", nuevas))) return { estado: 502, error: "Supabase rechazó la escritura" };
      return { estado: 200 };
    });

    if (guardado.estado !== 200) return res.status(guardado.estado).json({ error: guardado.error });
    res.json({ ok: true, fav: !!fav });
  } catch (e) { console.error("favorito:", e.message); res.status(502).json({ error: e.message }); }
});

// ── Limpieza de contenido de prueba (SOLO ADMINS) ────────────────────────────
// Para arrancar la app en producción con la casa limpia: borra las piezas y la planificación de
// prueba y deja que el contenido lo mande el cupo de cada empresa. RESPALDA primero todo lo que va
// a borrar en `backup_limpieza_<fecha>` (reversible) y solo si el respaldo se guardó, vacía. NO
// toca `companies` (planes = el cupo), `prospects`, ni las claves de sistema (sesiones, tokens, IG,
// push). Gate estricto: solo admins de TEAM (un cliente o un editor no puede dispararlo).
const CLAVES_LIMPIABLES = ["tasks", "planners", "planner_drafts", "extras", "guiones", "grabs", "reuniones", "eventos"];
function esAdminReq(req) {
  const email = norm(authInfo(req)?.email);
  return !!email && TEAM.some(u => u.role === "admin" && (norm(u.email) === email || norm(u.gmail) === email));
}
app.post("/api/admin/limpiar-contenido", requireAuth, async (req, res) => {
  if (!esAdminReq(req)) return res.status(403).json({ error: "solo un admin puede limpiar el contenido" });
  try {
    const respaldo = {}, borrado = {};
    for (const k of CLAVES_LIMPIABLES) {
      const v = (await sbGet(k, [])) || [];
      respaldo[k] = v;
      borrado[k] = Array.isArray(v) ? v.length : 0;
    }
    const claveBackup = "backup_limpieza_" + new Date().toISOString().replace(/[:.]/g, "-");
    // Respaldo PRIMERO. Si no se pudo guardar la copia, no se borra nada.
    if (!(await sbPut(claveBackup, respaldo))) return res.status(502).json({ error: "no se pudo respaldar; no se borró nada" });
    for (const k of CLAVES_LIMPIABLES) await sbPut(k, []);
    console.log("Limpieza de contenido por admin. Respaldo:", claveBackup, "borrado:", JSON.stringify(borrado));
    res.json({ ok: true, respaldo: claveBackup, borrado });
  } catch (e) { console.error("limpiar-contenido:", e.message); res.status(502).json({ error: e.message }); }
});

// Toda escritura pasa por esta cola. Sin ella dos avisos simultáneos leen la misma lista y
// el segundo pisa al primero — el clásico lost update sobre una fila única.
let notifChain = Promise.resolve();
function enCola(fn) {
  const p = notifChain.then(() => fn());
  notifChain = p.catch(() => {});
  return p;
}

// Crea el aviso y lo manda por push. `to` vacío = para todo el equipo.
async function crearNotif({ type, title, body, url, to, important, meta, dedupKey }) {
  return enCola(async () => {
    const lista = (await sbGet("notifs", [])) || [];
    const dest = [...new Set((to || []).map(norm).filter(Boolean))];
    // Un mismo hecho no avisa dos veces en 12 h: los efectos del frontend pueden dispararse
    // más de una vez por re-render, y nadie quiere el mismo push repetido.
    if (dedupKey) {
      const corte = Date.now() - 12 * 3600000;
      if (lista.some(n => n.dedupKey === dedupKey && new Date(n.ts).getTime() > corte)) {
        return { ok: true, duplicado: true };
      }
    }
    const n = {
      id: Date.now() + "" + Math.floor(Math.random() * 1000),
      ts: new Date().toISOString(),
      type: type || "info",
      title: title || "INMERSIA",
      body: body || "",
      url: url || "/",
      to: dest,
      meta: meta || {},
      dedupKey: dedupKey || null,
      read: [],
    };
    await sbPut("notifs", [n, ...lista].slice(0, NOTIF_MAX));
    let push = { sent: 0 };
    // El `tag` agrupa/reemplaza notificaciones en la pantalla de bloqueo. Con `n.type`, dos
    // piezas distintas compartían tag ("asignacion") y la segunda TAPABA a la primera: llegaban
    // dos asignaciones y solo se veía una. Se usa el dedupKey (que suele ser por pieza) o, si no
    // hay, el id único, para que avisos de cosas distintas convivan y solo se reemplace un
    // reenvío del MISMO aviso.
    try { push = await sendPush({ title: n.title, body: n.body, url: n.url, tag: n.dedupKey || n.id, important: !!important }, dest); }
    catch (e) { console.error("push desde notif:", e.message); }
    return { ok: true, id: n.id, push };
  });
}

app.post("/api/notifs", requireAuth, async (req, res) => {
  try { res.json(await crearNotif(req.body || {})); }
  catch (e) { console.error("crear notif:", e); res.status(500).json({ error: e.message }); }
});

// Devuelve solo lo que le toca a quien pregunta (destinatario explícito o aviso general).
app.get("/api/notifs", requireAuth, async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const tok = verifyToken(cookies._iauth || (req.headers.authorization || "").replace("Bearer ", "").trim());
    const yo = norm(tok?.email);
    const extra = norm(req.query.alt); // el Gmail, cuando entró por Google
    const mias = ((await sbGet("notifs", [])) || []).filter(n => !n.to?.length || n.to.includes(yo) || (extra && n.to.includes(extra)));
    res.json({
      notifs: mias.slice(0, 60),
      unread: mias.filter(n => !(n.read || []).includes(yo)).length,
      me: yo,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/notifs/read", requireAuth, async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const tok = verifyToken(cookies._iauth || (req.headers.authorization || "").replace("Bearer ", "").trim());
    const yo = norm(tok?.email);
    if (!yo) return res.status(400).json({ error: "sin identidad" });
    const ids = req.body?.ids;
    await enCola(async () => {
      const lista = (await sbGet("notifs", [])) || [];
      await sbPut("notifs", lista.map(n => {
        if (ids && !ids.includes(n.id)) return n;
        const read = n.read || [];
        return read.includes(yo) ? n : { ...n, read: [...read, yo] };
      }));
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Espejo de INIT_USERS (public/index.html): mismos ids. El servidor necesita traducir
// ids a correos para avisar por su cuenta, sin que haya nadie con la app abierta.
// Si agregas o sacas a alguien del equipo, hay que tocar los dos lados.
const TEAM = [
  { id: 2, name: "Cleme", email: "cleme@inmersia.cl", gmail: "clementeignacio19@gmail.com", role: "admin", vota: true },
  { id: 3, name: "Tiago", email: "tiago@inmersia.cl", role: "editor" },
  { id: 4, name: "Gali", email: "gali@inmersia.cl", gmail: "gcastilloaguirre@gmail.com", role: "Sales", vota: true },
  { id: 5, name: "Javi", email: "javi@inmersia.cl", gmail: "j.agutoledo@gmail.com", role: "admin", vota: true },
  { id: 6, name: "Jose", email: "jose@inmersia.cl", gmail: "jose.vergara.diaz.vr@gmail.com", role: "admin", vota: true },
  { id: 7, name: "INMERSIA", email: "inmersiatours@gmail.com", gmail: "inmersiatours@gmail.com", role: "admin" },
];
const correosDe = us => [...new Set((us || []).flatMap(u => [u.email, u.gmail]).filter(Boolean))];
const porIds = ids => TEAM.filter(u => (Array.isArray(ids) ? ids : [ids]).includes(u.id));
// Reuniones y eventos van siempre también a los admins. Se juntan en una sola lista
// deduplicada por id: el admin que además está apuntado recibe un aviso, no dos.
const masAdmins = us => [...new Map([...(us || []), ...TEAM.filter(u => u.role === "admin")].map(u => [u.id, u])).values()];

// ── Repasos por horario ───────────────────────────────────────────────────────
// Se corre al despertar el servidor y cada hora. `notif_daily` guarda el último día
// procesado, así que aunque Render duerma y arranque tarde, el aviso sale una sola vez.
const TZ = "America/Santiago";
const hoyCL = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
// Hora local de Chile en decimal (13.5 = 13:30) y día del mes.
const horaMinCL = () => {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [h, m] = s.split(":").map(Number);
  return h + m / 60;
};
const diaMesCL = () => +new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit" }).format(new Date());
const enMin = hhmm => { const [h, m] = String(hhmm || "00:00").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const responsablesDe = t => porIds(Array.isArray(t.responsable) ? t.responsable : (t.responsable != null ? [t.responsable] : []));

// ── Repaso diario ─────────────────────────────────────────────────────────────
// Corre al despertar el servidor y cada hora, pero el cuerpo se ejecuta una sola vez al
// día: `notif_daily` guarda la última fecha procesada. Así, aunque Render duerma y arranque
// a media mañana, el resumen sale igual y no sale dos veces.
async function repasoDiario(forzar) {
  try {
    if (!forzar) {
      // Ventana de 08:00 a 20:00. El límite de abajo es obvio; el de arriba evita que un
      // despliegue o un arranque nocturno mande "tu día" a las once de la noche. Si el
      // servidor estuvo dormido todo el día, el resumen se salta y sale al día siguiente.
      const h = horaMinCL();
      if (h < 8 || h >= 20) return { skip: "fuera de horario" };
      if ((await sbGet("notif_daily", "")) === hoyCL()) return { skip: "ya corrió hoy" };
    }
    const hoy = hoyCL();
    const manana = new Date(hoy + "T12:00:00");
    manana.setDate(manana.getDate() + 1);
    const ds = manana.toISOString().split("T")[0];
    const hecho = [];

    // 1 · Lo primero de la mañana: qué le toca a cada uno hoy. Se manda igual cuando no
    //     hay nada — saber que estás libre también es información.
    const tasks = (await sbGet("tasks", [])) || [];
    const abierta = t => !["aprobado", "publicado"].includes(t.state);
    for (const u of TEAM) {
      const mias = tasks.filter(t => abierta(t) && responsablesDe(t).some(r => r.id === u.id));
      const hoyMias = mias.filter(t => t.date === hoy);
      // El resumen diario solo avisa de lo de HOY. El conteo de "atrasadas" se quitó: mientras la
      // app no está en producción real, esas piezas son datos viejos de prueba con fecha pasada y
      // el aviso solo generaba ruido ("11 atrasadas") cada mañana. Si se quiere recuperar el
      // seguimiento de atrasadas cuando esté en marcha, se vuelve a sumar aquí.
      await crearNotif({
        type: "mi_dia",
        title: hoyMias.length ? "☀️ Tu día" : "☀️ Día despejado",
        body: hoyMias.length
          ? `${hoyMias.length} para hoy. ${hoyMias[0].title}`
          : "No tienes nada agendado para hoy.",
        to: correosDe([u]), url: "/", important: false,
        dedupKey: "dia_" + u.id + "_" + hoy,
      });
    }
    hecho.push("resumen personal x" + TEAM.length);

    // 2 · IVA: el 20 de cada mes, a los admins.
    if (diaMesCL() === 20) {
      await crearNotif({
        type: "iva", title: "🧾 Hoy vence el IVA",
        body: "Día 20: hay que declarar y pagar el IVA del mes anterior.",
        to: correosDe(TEAM.filter(u => u.role === "admin")), url: "/", important: true,
        dedupKey: "iva_" + hoy.slice(0, 7),
      });
      hecho.push("iva");
    }

    // 3 · Días de grabación de hoy y de mañana.
    const grabs = (await sbGet("grabs", {})) || {};
    const guiones = (await sbGet("guiones", [])) || [];
    for (const g of Object.values(grabs).flat()) {
      if (g.day !== hoy && g.day !== ds) continue;
      const gu = guiones.find(x => String(x.id) === String(g.guionId));
      await crearNotif({
        type: "grabacion",
        title: g.day === hoy ? "🎬 Hoy hay grabación" : "🎬 Mañana hay grabación",
        body: (gu?.title || "Día de grabación") + (g.time ? " · " + g.time : ""),
        url: "/", important: g.day === hoy,
        dedupKey: "grab_" + g.id + "_" + g.day + "_" + hoy,
      });
      hecho.push("grabacion");
    }

    // 4 · Reuniones y eventos de hoy, apenas empieza el día.
    for (const r of ((await sbGet("reuniones", [])) || []).filter(x => x.date === hoy)) {
      await crearNotif({
        type: "reunion", title: "🗓 Hoy tienes reunión",
        body: r.title + (r.time ? " · " + r.time : ""),
        to: correosDe(masAdmins(porIds(r.attendees))), url: r.meetLink || "/", important: true,
        dedupKey: "reu_dia_" + r.id + "_" + hoy,
      });
      hecho.push("reunion hoy");
    }
    for (const e of ((await sbGet("eventos", [])) || []).filter(x => x.date === hoy)) {
      await crearNotif({
        type: "evento", title: "📌 Hoy es el evento",
        body: e.title + ((e.hours || []).length ? " · " + e.hours.join(", ") : ""),
        to: correosDe(masAdmins(porIds(e.attendees))), url: "/", important: true,
        dedupKey: "ev_dia_" + e.id + "_" + hoy,
      });
      hecho.push("evento hoy");
    }

    // 5 · Renovar los permisos de Instagram que estén por vencer.
    //
    // `igToken` ya sabía renovar cuando quedan menos de 10 días, pero hasta ahora la única
    // llamada estaba en la pantalla de elegir publicación. O sea: la automatización se
    // mantenía viva solo si alguien del equipo entraba a esa pantalla cada dos meses. Si nadie
    // lo hacía, el permiso vencía y las cadenas dejaban de responder sin un solo aviso —justo
    // lo que el comentario de esa función decía querer evitar—. Aquí se repasan todas las
    // cuentas conectadas, una vez al día y sin que nadie tenga que abrir nada.
    try {
      const ig = await loadIG();
      for (const [cid, antes] of Object.entries(ig.cuentas || {})) {
        const c = await igToken(cid);
        if (!c) continue;
        const quedanMs = (c.expira || 0) - Date.now();
        const dias = Math.floor(quedanMs / 86400000);
        if (c.expira !== antes.expira) { console.log(`IG: permiso de @${c.username || cid} renovado, ahora vence en ${dias} días`); hecho.push("token ig"); continue; }
        // Se avisa solo si el token estaba DENTRO de la ventana de renovación (≤10 días, la misma
        // que usa igToken) y aun así no se movió: eso es que Meta lo rechazó. Por encima de 10
        // días igToken ni lo intenta, así que "no cambió" no es un fallo y avisar ahí era una
        // falsa alarma —que además, con Math.round, saltaba justo en el borde de 10 días—. Ya
        // vencido se dice "ya venció", no "vence en -37 días".
        if (quedanMs <= 10 * 24 * 3600000) {
          const cuando = quedanMs <= 0 ? "ya venció" : `vence en ${dias} día${dias === 1 ? "" : "s"}`;
          await crearNotif({
            type: "contenido", title: "⚠️ El permiso de Instagram está por vencer",
            body: `@${c.username || cid} ${cuando} y no se pudo renovar solo. Hay que reconectar la cuenta o las automatizaciones dejarán de responder.`,
            to: correosDe(TEAM.filter(u => u.role === "admin")), url: "/", important: true,
            dedupKey: "igvence_" + cid + "_" + hoy,
          });
          hecho.push("aviso token ig");
        }
      }
    } catch (e) { console.error("IG renovación diaria:", e.message); }

    await sbPut("notif_daily", hoy);
    return { ok: true, hoy, hecho };
  } catch (e) { console.error("repaso diario:", e.message); return { error: e.message }; }
}

// ── Repaso corto: "empieza en una hora" ───────────────────────────────────────
// Cada 10 minutos se busca lo que arranca dentro de 45–75 min. La ventana es ancha a
// propósito: si el servidor estuvo dormido un rato, el aviso sale igual. El dedupKey
// impide que se repita aunque la ventana se recorra varias veces.
async function repasoCorto() {
  try {
    const hoy = hoyCL();
    const ahora = horaMinCL() * 60;
    const enVentana = hhmm => { const d = enMin(hhmm) - ahora; return d >= 45 && d <= 75; };

    for (const r of ((await sbGet("reuniones", [])) || []).filter(x => x.date === hoy && enVentana(x.time))) {
      await crearNotif({
        type: "reunion", title: "⏰ Tu reunión empieza en una hora",
        body: r.title + " · " + r.time + (r.meetLink ? " · toca para entrar a Meet" : ""),
        to: correosDe(masAdmins(porIds(r.attendees))), url: r.meetLink || "/", important: true,
        dedupKey: "reu_1h_" + r.id + "_" + hoy,
      });
    }
    for (const e of ((await sbGet("eventos", [])) || []).filter(x => x.date === hoy && (x.hours || []).some(enVentana))) {
      await crearNotif({
        type: "evento", title: "⏰ Tu evento empieza en una hora",
        body: e.title + " · " + (e.hours || []).find(enVentana),
        to: correosDe(masAdmins(porIds(e.attendees))), url: "/", important: true,
        dedupKey: "ev_1h_" + e.id + "_" + hoy,
      });
    }
  } catch (e) { console.error("repaso corto:", e.message); }
  // Las esperas de las cadenas de Instagram se retoman aquí. Va aparte del try de arriba para
  // que un fallo en los recordatorios no impida enviar los mensajes pendientes.
  try { await igProcesarPendientes(); } catch (e) { console.error("IG pendientes:", e.message); }
  // Y aquí se arman las automatizaciones cuya pieza ya se publicó: se detecta la publicación y se
  // le pega el mediaId real a la cadena, para que empiece a responder comentarios sola.
  try { await igArmarPendientes(); } catch (e) { console.error("IG armar:", e.message); }
}

setTimeout(() => { repasoDiario(); repasoCorto(); }, 20000);
setInterval(() => repasoDiario(), 3600000);
setInterval(() => repasoCorto(), 600000);
app.post("/api/notifs/repaso", requireAuth, async (req, res) => { const d = await repasoDiario(true); await repasoCorto(); res.json(d); });

// ===============================
// 🧪 TEST & HEALTH
// ===============================
app.get("/api/test", (req, res) => {
  res.json({ ok: true, msg: "INMERSIA server running" });
});

// Quién dice el SERVIDOR que eres. Existe porque el navegador y el servidor pueden discrepar:
// la cookie `_iauth` es una sola por navegador, así que entrar al portal de un cliente para
// probarlo deja TODAS las pestañas —incluida la del equipo— hablando como ese cliente. La
// interfaz seguía mostrando el panel de admin mientras el servidor solo entregaba la empresa del
// cliente y solo aceptaba el merge restringido: se podía trabajar media hora sobre una sesión
// ajena sin un solo aviso, y los borrados se perdían (el 21-ago-2026 pasó exactamente eso).
// La app compara esto contra el usuario que tiene en pantalla y se planta si no coinciden.
app.get("/api/auth/me", (req, res) => {
  const tok = authInfo(req);
  if (!tok || !tok.email) return res.json({ sesion: false });
  const empresa = clienteDe(tok);
  res.json({ sesion: true, email: tok.email, esCliente: !!empresa, empresa: empresa || null });
});

app.get("/api/health", (req, res) => {
  // Solo booleanos: sirve para diagnosticar qué falta configurar sin exponer ningún valor.
  res.json({
    gemini: !!process.env.GEMINI_API_KEY,
    email: !!process.env.RESEND_API_KEY,
    push: pushReady,
    storage: !!storageKey(),
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  });
});

// ===============================
// 🤖 GEMINI HELPER
// ===============================
async function callGemini(contents) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY no configurada");

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents })
    }
  );

  const data = await r.json();
  if (data.error) throw new Error(data.error.message || "Error Gemini");
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ===============================
// 🎙️ GENERAR ACTA DE REUNIÓN
// ===============================
app.post("/api/generate-acta", requireAuth, upload.single("audio"), async (req, res) => {
  try {
    const company = req.body.company || "General";
    const participants = req.body.participants || "Equipo";

    const today = new Date();
    const dias = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
    const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
    const fechaStr = `${dias[today.getDay()]}, ${today.getDate()} de ${meses[today.getMonth()]} de ${today.getFullYear()}`;

    let contents;

    if (req.file) {
      const audioBase64 = req.file.buffer.toString("base64");
      const mimeType = req.file.mimetype || "audio/webm";

      contents = [{
        parts: [
          { inlineData: { mimeType, data: audioBase64 } },
          { text: `Eres un asistente profesional de reuniones. Escucha este audio y genera DOS cosas:\n\n1. TRANSCRIPCIÓN: La transcripción completa y fiel del audio.\n\n2. ACTA DE REUNIÓN con este formato:\n\n**ACTA DE REUNIÓN**   |   ${company}\n\n**Reunión ${company}**\n\n${fechaStr}\n\n| **Fecha** | ${fechaStr} |\n| --- | --- |\n| **Proyecto** | ${company} – [Tema principal] |\n| **Tipo de reunión** | [Tipo] |\n| **Participantes** | ${participants} |\n\nSecciones numeradas con bullets. Al final tabla de Próximos Pasos.\n\n*— Fin del acta —*\nDocumento confidencial  •  ${company}  •  ${fechaStr}\n\nResponde:\n===TRANSCRIPCION===\n[transcripción]\n===ACTA===\n[acta]` }
        ]
      }];
    } else {
      contents = [{
        parts: [{ text: `Genera un acta de reunión de ejemplo para ${company}, fecha ${fechaStr}, participantes: ${participants}. Formato profesional con tabla de fecha, secciones numeradas y tabla de Próximos Pasos.\n\n*— Fin del acta —*\nDocumento confidencial  •  ${company}  •  ${fechaStr}` }]
      }];
    }

    const result = await callGemini(contents);
    let transcript = "", acta = result;

    if (result.includes("===TRANSCRIPCION===") && result.includes("===ACTA===")) {
      const parts = result.split("===ACTA===");
      transcript = parts[0].replace("===TRANSCRIPCION===", "").trim();
      acta = parts[1].trim();
    }

    let tasks = [];
    try {
      const taskResult = await callGemini([{ parts: [{ text: `Extrae tareas del acta como JSON array con "title", "responsable" (string o null), "date" (YYYY-MM-DD o null). SOLO JSON, sin markdown.\n\n${acta}` }] }]);
      tasks = JSON.parse(taskResult.replace(/```json|```/g, "").trim());
    } catch (e) { console.log("No se extrajeron tareas:", e.message); }

    res.json({ transcript, acta, tasks });
  } catch (err) {
    console.error("Error generate-acta:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🤖 CUMBRE AI
// ===============================
app.post("/api/ai/generate", requireAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    const text = await callGemini([{ parts: [{ text: prompt }] }]);
    res.json({ text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===============================
// 💳 LOYALTY PUSH
// ===============================
app.post("/api/loyalty/generate-push", requireAuth, async (req, res) => {
  try {
    const { company, topic } = req.body;
    const text = await callGemini([{ parts: [{ text: `Genera una notificación push de fidelización para ${company} sobre: ${topic}. Máximo 2 líneas, tono cercano y profesional.` }] }]);
    res.json({ text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===============================
// 💳 FIDELIZACIÓN — programas, socios y sellos
// ===============================
// Estas rutas NO usan `app_data`: hablan con las tablas de `db/loyalty.sql`. Un programa tiene
// miles de socios y crece para siempre; meterlo en el almacén clave-valor haría que cada carga de
// la app se bajara la base de socios completa de todas las empresas (la misma trampa ya
// documentada con los videos en base64).
//
// Dos rutas son PÚBLICAS a propósito: `/join` y `/card/:codigo`. El cliente final del cliente no
// tiene cuenta en Inmersia — llega por un QR pegado en el mesón. Van con `rateLimit` y devuelven
// solo lo justo para pintar la tarjeta (nunca el id interno del socio). En cambio TODO lo que
// suma o descuenta sellos exige sesión: **el QR del socio identifica, no autoriza**. Si sumar un
// sello fuera público, cualquiera se regalaría el premio desde su casa.

async function lyRest(path, opts = {}) {
  const { url, key } = SB();
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { d = txt; }
  if (!r.ok) throw new Error(d?.message || d?.hint || `Supabase ${r.status}`);
  return d;
}

// Alfabeto sin caracteres que se confunden al leer un QR gastado o al dictarlo por teléfono:
// sin 0/O, sin 1/I/L. Aleatorio, nunca correlativo: un código adivinable son sellos regalados.
const LY_ABC = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function lyCodigo(n = 8) {
  const b = crypto.randomBytes(n);
  let s = ""; for (let i = 0; i < n; i++) s += LY_ABC[b[i] % LY_ABC.length];
  return s;
}
const lyUno = (d) => (Array.isArray(d) ? d[0] : d) || null;

// ── Programas (equipo) ──────────────────────────────────────────────────────
app.get("/api/loyalty/programs", requireAuth, async (req, res) => {
  try {
    const co = (req.query.companyId || "").trim();
    const filtro = co ? `company_id=eq.${encodeURIComponent(co)}&` : "";
    res.json(await lyRest(`loyalty_programs?${filtro}order=created_at.desc`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/loyalty/programs", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.company_id || !b.nombre || !b.premio) return res.status(400).json({ error: "Faltan empresa, nombre o premio" });
    const fila = {
      company_id: String(b.company_id),
      nombre: b.nombre,
      tipo: b.tipo || "sellos",
      meta: Math.max(1, parseInt(b.meta, 10) || 10),
      premio: b.premio,
      // Diseño. Los nombres siguen a los de Apple (backgroundColor / foregroundColor /
      // labelColor / logoText / strip) para que firmar el .pkpass sea un mapeo directo.
      color_fondo: b.color_fondo || "#05060B",
      color_texto: b.color_texto || "#FFFFFF",
      color_etiqueta: b.color_etiqueta || "#8E93A6",
      logo_url: b.logo_url || null,
      logo_text: b.logo_text || null,
      strip_url: b.strip_url || null,
      strip_estilo: b.strip_estilo || null,
      sello_icono: b.sello_icono || "circulo",
      vigencia_dias: b.vigencia_dias ? parseInt(b.vigencia_dias, 10) : null,
      updated_at: new Date().toISOString(),
    };
    if (b.id) fila.id = b.id;                                  // con id actualiza, sin id crea
    if (typeof b.activo === "boolean") fila.activo = b.activo;
    const d = await lyRest("loyalty_programs", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(fila),
    });
    res.json(lyUno(d));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Socios de un programa, los que volvieron hace menos primero.
app.get("/api/loyalty/programs/:id/socios", requireAuth, async (req, res) => {
  try {
    res.json(await lyRest(
      `loyalty_members?program_id=eq.${encodeURIComponent(req.params.id)}` +
      `&select=id,codigo,nombre,email,telefono,saldo,canjes,created_at,ultima_visita` +
      `&order=ultima_visita.desc.nullslast&limit=500`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Últimos movimientos del programa — es lo que responde un "me faltó un sello".
app.get("/api/loyalty/programs/:id/eventos", requireAuth, async (req, res) => {
  try {
    const socios = await lyRest(`loyalty_members?program_id=eq.${encodeURIComponent(req.params.id)}&select=id,nombre,codigo`);
    if (!socios.length) return res.json([]);
    const evs = await lyRest(`loyalty_events?member_id=in.(${socios.map(s => s.id).join(",")})&order=created_at.desc&limit=200`);
    const porId = Object.fromEntries(socios.map(s => [s.id, s]));
    res.json(evs.map(e => ({ ...e, socio: porId[e.member_id]?.nombre || porId[e.member_id]?.codigo || "—" })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Programa visto desde fuera (PÚBLICA) ────────────────────────────────────
// Lo que necesita la página de alta para pintar la tarjeta ANTES de que la persona se inscriba:
// sin esto el mesón muestra un formulario gris y nadie sabe a qué se está apuntando. Devuelve
// solo el diseño y la promesa; nunca `company_id` ni el conteo de socios, que son del negocio.
app.get("/api/loyalty/program/:id", rateLimit(60, "ly-programa"), async (req, res) => {
  try {
    const p = lyUno(await lyRest(
      `loyalty_programs?id=eq.${encodeURIComponent(req.params.id)}` +
      `&select=id,nombre,tipo,meta,premio,activo,color_fondo,color_texto,color_etiqueta,logo_url,logo_text,strip_url,strip_estilo` +
      `&limit=1`));
    if (!p || !p.activo) return res.status(404).json({ error: "Este programa no está disponible" });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Alta del socio (PÚBLICA) ────────────────────────────────────────────────
app.post("/api/loyalty/join", rateLimit(20, "ly-alta"), async (req, res) => {
  try {
    const { programId, nombre, email, telefono } = req.body || {};
    if (!programId) return res.status(400).json({ error: "Falta el programa" });
    const p = lyUno(await lyRest(`loyalty_programs?id=eq.${encodeURIComponent(programId)}&select=id,activo&limit=1`));
    if (!p || !p.activo) return res.status(404).json({ error: "Este programa no está disponible" });

    // Si ya se inscribió con el mismo correo, devolverle SU tarjeta en vez de crear otra: si no,
    // el que se inscribe dos veces pierde los sellos que ya tenía.
    if (email) {
      const ya = lyUno(await lyRest(
        `loyalty_members?program_id=eq.${encodeURIComponent(programId)}&email=eq.${encodeURIComponent(email)}&select=codigo&limit=1`));
      if (ya) return res.json({ codigo: ya.codigo, yaExistia: true });
    }

    const socio = lyUno(await lyRest("loyalty_members", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ program_id: programId, codigo: lyCodigo(), nombre: nombre || null, email: email || null, telefono: telefono || null }),
    }));
    await lyRest("loyalty_events", { method: "POST", body: JSON.stringify({ member_id: socio.id, tipo: "alta", cantidad: 0, saldo_despues: 0 }) });
    res.json({ codigo: socio.codigo, yaExistia: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tarjeta del socio (PÚBLICA) ─────────────────────────────────────────────
app.get("/api/loyalty/card/:codigo", rateLimit(60, "ly-tarjeta"), async (req, res) => {
  try {
    const m = lyUno(await lyRest(
      `loyalty_members?codigo=eq.${encodeURIComponent(req.params.codigo)}` +
      `&select=codigo,nombre,saldo,canjes,ultima_visita,program_id&limit=1`));
    if (!m) return res.status(404).json({ error: "Tarjeta no encontrada" });
    const p = lyUno(await lyRest(
      `loyalty_programs?id=eq.${m.program_id}` +
      `&select=id,nombre,tipo,meta,premio,activo,color_fondo,color_texto,color_etiqueta,logo_url,logo_text,strip_url,strip_estilo` +
      `&limit=1`));
    res.json({
      socio: { codigo: m.codigo, nombre: m.nombre, saldo: m.saldo, canjes: m.canjes, ultima_visita: m.ultima_visita },
      programa: p,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sumar un sello (equipo) ─────────────────────────────────────────────────
// `idemKey` es una clave única por lectura que manda el escáner. Sin ella, un doble toque o un
// reintento de red le regala dos sellos al cliente. Con cola en el mesón esto pasa, no es teórico.
app.post("/api/loyalty/scan", requireAuth, async (req, res) => {
  try {
    const { codigo, idemKey, localId, operador, cantidad } = req.body || {};
    if (!codigo) return res.status(400).json({ error: "Falta el código" });

    if (idemKey) {
      const ya = lyUno(await lyRest(`loyalty_events?idem_key=eq.${encodeURIComponent(idemKey)}&select=saldo_despues&limit=1`));
      if (ya) return res.json({ saldo: ya.saldo_despues, repetido: true });
    }

    const m = lyUno(await lyRest(`loyalty_members?codigo=eq.${encodeURIComponent(codigo)}&select=*&limit=1`));
    if (!m) return res.status(404).json({ error: "Tarjeta no encontrada" });
    const p = lyUno(await lyRest(`loyalty_programs?id=eq.${m.program_id}&select=meta,premio,nombre,activo&limit=1`));
    if (!p || !p.activo) return res.status(400).json({ error: "El programa está pausado" });

    const suma = Math.max(1, parseInt(cantidad, 10) || 1);
    const saldo = (m.saldo || 0) + suma;
    try {
      await lyRest("loyalty_events", {
        method: "POST",
        body: JSON.stringify({ member_id: m.id, tipo: "sello", cantidad: suma, saldo_despues: saldo, local_id: localId || null, operador: operador || null, idem_key: idemKey || null }),
      });
    } catch (e) {
      // Chocó contra el índice único de idem_key: otra lectura idéntica ganó la carrera.
      if (/duplicate|23505/i.test(e.message)) {
        const ya = lyUno(await lyRest(`loyalty_events?idem_key=eq.${encodeURIComponent(idemKey)}&select=saldo_despues&limit=1`));
        return res.json({ saldo: ya?.saldo_despues ?? m.saldo, repetido: true });
      }
      throw e;
    }
    await lyRest(`loyalty_members?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ saldo, ultima_visita: new Date().toISOString() }) });
    res.json({ saldo, meta: p.meta, premio: p.premio, socio: m.nombre, listo: saldo >= p.meta, repetido: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Banda generada con IA (equipo) ──────────────────────────────────────────
// Devuelve la imagen en base64 y NO la guarda: el navegador la recorta a 960×369 exactos y
// recién ahí la sube por /api/upload. Así lo que queda en Storage siempre tiene la medida que
// Apple espera, venga de la IA o de un archivo que trajo el cliente.
//
// Imagen de Google se apaga el 17-ago-2026, así que esto va contra los modelos nativos de
// Gemini. Se prueban en orden por si el primero cambia de nombre otra vez.
const LY_MODELOS_IMG = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"];

app.post("/api/loyalty/strip-ia", requireAuth, async (req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(400).json({ error: "Falta GEMINI_API_KEY en el servidor" });
    const { prompt, marca, c1, c2 } = req.body || {};
    if (!(prompt || "").trim()) return res.status(400).json({ error: "Escribe qué quieres que dibuje" });

    // La banda es larguísima y estrecha, y en el pase queda ARRIBA con los campos justo debajo.
    // Sin estas instrucciones el modelo devuelve una escena centrada que al recortar se pierde.
    // El texto se prohíbe a propósito: el nombre de la marca lo dibuja Wallet por su cuenta y si
    // además viene escrito en la imagen, sale duplicado y torcido.
    const instruccion = [
      "Banda horizontal muy ancha y baja para la cabecera de una tarjeta de fidelización digital.",
      marca ? `Marca: ${marca}.` : "",
      `Lo que se quiere ver: ${prompt}.`,
      (c1 || c2) ? `Paleta dominante: ${[c1, c2].filter(Boolean).join(" y ")}.` : "",
      "Composición apaisada y limpia, con aire.",
      "Sin texto, sin letras, sin números, sin logotipos, sin marcos ni bordes.",
      "Nada importante pegado a los bordes superior e inferior: la imagen se recorta por ahí.",
    ].filter(Boolean).join(" ");

    let ultimo = "";
    for (const modelo of LY_MODELOS_IMG) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: instruccion }] }],
            generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "21:9" } },
          }),
        });
        const d = await r.json();
        if (d.error) { ultimo = d.error.message || "Error de Gemini"; continue; }
        const parte = (d.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
        if (!parte) { ultimo = "El modelo no devolvió ninguna imagen"; continue; }
        return res.json({
          modelo,
          dataUrl: `data:${parte.inlineData.mimeType || "image/png"};base64,${parte.inlineData.data}`,
        });
      } catch (e) { ultimo = e.message; }
    }
    res.status(502).json({ error: ultimo || "No se pudo generar la imagen" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Canjear el premio (equipo) ──────────────────────────────────────────────
app.post("/api/loyalty/redeem", requireAuth, async (req, res) => {
  try {
    const { codigo, idemKey, localId, operador } = req.body || {};
    if (!codigo) return res.status(400).json({ error: "Falta el código" });

    if (idemKey) {
      const ya = lyUno(await lyRest(`loyalty_events?idem_key=eq.${encodeURIComponent(idemKey)}&select=saldo_despues&limit=1`));
      if (ya) return res.json({ saldo: ya.saldo_despues, repetido: true });
    }

    const m = lyUno(await lyRest(`loyalty_members?codigo=eq.${encodeURIComponent(codigo)}&select=*&limit=1`));
    if (!m) return res.status(404).json({ error: "Tarjeta no encontrada" });
    const p = lyUno(await lyRest(`loyalty_programs?id=eq.${m.program_id}&select=meta,premio&limit=1`));
    if ((m.saldo || 0) < p.meta) return res.status(400).json({ error: `Le faltan ${p.meta - (m.saldo || 0)} para el premio` });

    const saldo = m.saldo - p.meta;
    await lyRest("loyalty_events", {
      method: "POST",
      body: JSON.stringify({ member_id: m.id, tipo: "canje", cantidad: -p.meta, saldo_despues: saldo, local_id: localId || null, operador: operador || null, idem_key: idemKey || null }),
    });
    await lyRest(`loyalty_members?id=eq.${m.id}`, {
      method: "PATCH",
      body: JSON.stringify({ saldo, canjes: (m.canjes || 0) + 1, ultima_visita: new Date().toISOString() }),
    });
    res.json({ saldo, canjeado: p.premio, socio: m.nombre, repetido: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===============================
// 📣 META ADS ADVISOR
// ===============================
app.post("/api/meta/advisor", requireAuth, async (req, res) => {
  try {
    const { company, campaigns, totalBudget, question } = req.body;
    const text = await callGemini([{ parts: [{ text: `Eres un experto en Meta Ads. Empresa: ${company}. Presupuesto: $${totalBudget}. Campañas: ${JSON.stringify(campaigns)}. Pregunta: ${question}. Responde conciso y accionable.` }] }]);
    res.json({ text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===============================
// 🔐 AUTH GOOGLE
// ===============================
// El calendario se pide en el mismo inicio de sesión: quien entra con Google queda
// conectado de una, sin botón aparte. Se usa `calendar.events` (crear y editar eventos) en
// vez del scope completo de calendario: alcanza para lo que hace la app y en la pantalla de
// permisos de Google se lee mucho menos invasivo.
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// La app queda accesible por más de un dominio (el de Render y el propio de INMERSIA). La
// URL de retorno tiene que ser la del dominio por el que entró la persona: si se fija una
// sola, quien entre por el otro termina con la sesión abierta en un dominio distinto al
// que estaba usando. Se valida contra una lista blanca a propósito — confiar en la
// cabecera Host permitiría desviar el código de autorización a un dominio ajeno.
const HOSTS_OK = new Set([
  "app-equipo-inmersia-beta-0-01.onrender.com",
  "portal.inmersiaperformance.cl",
  "localhost:10000",
]);
function redirectURI(req) {
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").toLowerCase();
  if (!HOSTS_OK.has(host)) return process.env.GOOGLE_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] === "https" || req.secure ? "https" : "http";
  return `${proto}://${host}/api/auth/callback/google`;
}

const authURL = (state, consent, req) =>
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(redirectURI(req))}&response_type=code` +
  `&scope=${encodeURIComponent(GCAL_SCOPE + " openid email profile")}` +
  `&state=${state}&access_type=offline&include_granted_scopes=true` +
  (consent ? "&prompt=consent" : "");

app.get("/api/auth/google-login", (req, res) => res.redirect(authURL("login", false, req)));
// Reconectar a mano, para cuando alguien revocó el permiso o entró antes de este cambio.
app.get("/api/auth/google", (req, res) => res.redirect(authURL("gcal", true, req)));

app.get("/api/auth/callback/google", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send("No code recibido");

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectURI(req), grant_type: "authorization_code" })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) { console.log("TOKEN ERROR:", tokenData); return res.send("Error obteniendo token"); }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const userData = await userRes.json();
    console.log("LOGIN OK:", userData.email);

    // Google solo entrega refresh_token la PRIMERA vez que se concede el permiso. Si no
    // viene y tampoco hay uno guardado, se pide una segunda vuelta con prompt=consent —
    // una sola, marcada con el state, para no quedar en un ciclo.
    if (!userData.email) { console.error("Google no devolvió el correo:", userData); return res.send("Google no devolvió el correo de la cuenta"); }

    const guardados = (await sbGet("gcal_tokens", {})) || {};
    if (tokenData.refresh_token) {
      guardados[userData.email] = { refresh_token: tokenData.refresh_token, access_token: tokenData.access_token, email: userData.email };
      await sbPut("gcal_tokens", guardados);
      console.log("GCal refresh_token guardado para:", userData.email);
    } else if (state === "login" && !guardados[userData.email]?.refresh_token) {
      return res.redirect(authURL("login2", true, req));
    }

    if (state === "gcal") {
      return res.redirect(`/?gcal=success&gcal_token=${tokenData.access_token}&gcal_email=${userData.email}`);
    }

    setAuthCookie(req, res, userData.email);
    return res.redirect(`/?login=success&email=${encodeURIComponent(userData.email)}`);
  } catch (err) {
    console.error(err);
    res.send("Error en callback Google");
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("_iauth", { httpOnly: true, secure: true, sameSite: "lax" });
  res.json({ ok: true });
});

// ===============================
// 📅 GCAL SYNC - persistent
// ===============================
async function getGCalAccessToken(email) {
  const sbUrl = process.env.SUPABASE_URL || "https://cvytwyvaxccbcpfqezlr.supabase.co";
  const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";

  const loadRes = await fetch(`${sbUrl}/rest/v1/app_data?key=eq.gcal_tokens&select=value`, {
    headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` }
  });
  const loadData = await loadRes.json();
  const tokens = loadData?.[0]?.value || {};
  const userToken = tokens[email];
  if (!userToken?.refresh_token) return null;

  // Refresh the access token
  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: userToken.refresh_token,
      grant_type: "refresh_token"
    })
  });
  const refreshData = await refreshRes.json();
  if (!refreshData.access_token) {
    console.error("Refresh failed:", email, refreshData);
    // `invalid_grant` = el permiso murió: se revocó, o el proyecto sigue en modo Testing y
    // Google caduca los refresh tokens a los 7 días. Se borra el token muerto para que la
    // app muestre "Reconectar calendario" en vez de fallar en silencio cada vez.
    // Se exige que las credenciales del cliente OAuth estén configuradas: si faltaran, un
    // despliegue mal configurado podría interpretar el fallo como permiso revocado y dejar
    // a todo el equipo sin calendario de un viaje.
    if (refreshData.error === "invalid_grant" && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      delete tokens[email];
      try { await sbPut("gcal_tokens", tokens); } catch (e) {}
      console.log("Token de calendario caducado, borrado para:", email);
    }
    return null;
  }
  return refreshData.access_token;
}

app.post("/api/gcal/sync", requireAuth, async (req, res) => {
  try {
    const { email, title, company, date } = req.body;
    if (!email || !date) return res.json({ ok: false, msg: "Faltan datos" });

    const accessToken = await getGCalAccessToken(email);
    if (!accessToken) return res.json({ ok: false, msg: "GCal no conectado para " + email });

    const event = {
      summary: title,
      description: "INMERSIA: " + (company || ""),
      start: { date },
      end: { date }
    };

    const calRes = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify(event)
    });
    const calData = await calRes.json();

    if (calData.error) {
      console.error("GCal sync error:", calData.error);
      return res.json({ ok: false, msg: calData.error.message });
    }

    console.log("GCal event created:", title, "->", email);
    res.json({ ok: true, eventId: calData.id });
  } catch (err) {
    console.error("Error gcal sync:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 📊 META / INSTAGRAM MÉTRICAS
// ===============================
app.get("/api/auth/meta",(req,res)=>{
  const appId=process.env.META_APP_ID;
  const redirectUri=process.env.META_REDIRECT_URI;
  const scopes="instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement,ads_read";
  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code`);
});

app.get("/api/auth/callback/meta",async(req,res)=>{
  const{code}=req.query;
  if(!code)return res.send("No code recibido");
  try{
    const appId=process.env.META_APP_ID;
    const appSecret=process.env.META_APP_SECRET;
    const redirectUri=process.env.META_REDIRECT_URI;
    const shortRes=await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`);
    const shortData=await shortRes.json();
    if(!shortData.access_token)return res.send("Error token: "+JSON.stringify(shortData));
    const llRes=await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortData.access_token}`);
    const llData=await llRes.json();
    const token=llData.access_token||shortData.access_token;
    const sbUrl=process.env.SUPABASE_URL||"https://cvytwyvaxccbcpfqezlr.supabase.co";
    const sbKey=process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_KEY||"sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
    await fetch(`${sbUrl}/rest/v1/app_data`,{
      method:"POST",
      headers:{"apikey":sbKey,"Authorization":`Bearer ${sbKey}`,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates"},
      body:JSON.stringify({key:"meta_token",value:{token,expires_at:Date.now()+(llData.expires_in||5183944)*1000},updated_at:new Date().toISOString()})
    });
    res.redirect("/?meta=connected");
  }catch(err){
    console.error("Meta OAuth callback error:",err);
    res.send("Error: "+err.message);
  }
});

async function getMetaToken(){
  if(process.env.META_ACCESS_TOKEN)return process.env.META_ACCESS_TOKEN;
  try{
    const sbUrl=process.env.SUPABASE_URL;
    const sbKey=process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_KEY;
    if(!sbUrl||!sbKey)return null;
    const r=await fetch(`${sbUrl}/rest/v1/app_data?key=eq.meta_token&select=value`,{headers:{"apikey":sbKey,"Authorization":`Bearer ${sbKey}`}});
    const d=await r.json();
    return d?.[0]?.value?.token||null;
  }catch{return null;}
}

app.get("/api/meta/status",requireAuth,async(req,res)=>{
  try{
    const token=await getMetaToken();
    if(!token)return res.json({connected:false});
    const r=await fetch(`https://graph.facebook.com/v19.0/me?fields=name&access_token=${token}`);
    const d=await r.json();
    if(d.error)return res.json({connected:false});
    res.json({connected:true,user:d.name});
  }catch{res.json({connected:false});}
});

app.get("/api/meta/token-info",requireAuth,async(req,res)=>{
  try{
    const token=await getMetaToken();
    if(!token)return res.json({connected:false});
    const appId=process.env.META_APP_ID;
    const appSecret=process.env.META_APP_SECRET;
    const r=await fetch(`https://graph.facebook.com/debug_token?input_token=${token}&access_token=${appId}|${appSecret}`);
    const d=await r.json();
    if(d.error||d.data?.error)return res.json({connected:false});
    res.json({connected:true,expires_at:d.data?.expires_at||null,is_valid:d.data?.is_valid||false});
  }catch(err){res.json({connected:false,error:err.message});}
});

app.get("/api/meta/exchange",requireAuth,async(req,res)=>{
  const{token}=req.query;
  if(!token)return res.json({error:"token requerido"});
  try{
    const appId=process.env.META_APP_ID;
    const appSecret=process.env.META_APP_SECRET;
    const llRes=await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`);
    const llData=await llRes.json();
    if(!llData.access_token)return res.json({error:"Exchange falló",details:llData});
    const dias=Math.floor((llData.expires_in||5183944)/86400);
    res.json({ok:true,dias,token:llData.access_token,instruccion:`Agrega META_ACCESS_TOKEN en Render con el valor del campo "token"`});
  }catch(err){res.status(500).json({error:err.message});}
});

// Fetch metrics broken down by CALENDAR months (not 30-day blocks — those drift off
// month boundaries over long ranges, producing duplicate/skipped labels like two
// "Oct 24" chunks and no "Feb 25") → returns [{label,reach,total_interactions,...}, ...]
async function fetchMonthly(base,igId,tvMetrics,token,since,until){
  const months=[];
  let cur=new Date(Date.UTC(new Date(since*1000).getUTCFullYear(),new Date(since*1000).getUTCMonth(),1));
  while(cur.getTime()/1000<until){
    const next=new Date(Date.UTC(cur.getUTCFullYear(),cur.getUTCMonth()+1,1));
    const cs=Math.max(since,Math.floor(cur.getTime()/1000));
    const cu=Math.min(until,Math.floor(next.getTime()/1000));
    if(cu>cs)months.push([cs,cu]);
    cur=next;
  }
  const results=await Promise.all(months.map(async([cs,cu])=>{
    const date=new Date(cs*1000);
    const label=date.toLocaleDateString("es-CL",{month:"short",year:"2-digit"})
      .replace(".","").replace(/^(\w)/,c=>c.toUpperCase());
    const[tvR,rR]=await Promise.all([
      fetch(`${base}/${igId}/insights?metric=${tvMetrics}&metric_type=total_value&period=day&since=${cs}&until=${cu}&access_token=${token}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${base}/${igId}/insights?metric=reach&period=day&since=${cs}&until=${cu}&access_token=${token}`).then(r=>r.json()).catch(()=>({})),
    ]);
    if(tvR.error)console.error(`fetchMonthly TV metrics error (${label}):`,tvR.error.message||tvR.error);
    if(rR.error)console.error(`fetchMonthly reach error (${label}):`,rR.error.message||rR.error);
    const tv={};
    (tvR.data||[]).forEach(m=>{tv[m.name]=m.total_value?.value||0;});
    const reach=(rR.data||[]).find(m=>m.name==="reach")?.values?.reduce((s,v)=>s+(v.value||0),0)||0;
    return{label,reach,...tv};
  }));
  return results;// already oldest→newest (built from since→until)
}

app.get("/api/meta/insights-full",requireAuth,async(req,res)=>{
  try{
    const{igId}=req.query;
    if(!igId)return res.status(400).json({error:"igId requerido"});
    if(!await isValidIgId(igId))return res.status(403).json({error:"Cuenta no autorizada"});
    const token=await getMetaToken();
    if(!token)return res.json({error:"Meta no conectado",connected:false});
    const days=Math.min(parseInt(req.query.days)||30,180);
    const until=Math.floor(Date.now()/1000);
    const since=until-days*24*60*60;
    const prevSince=since-days*24*60*60;
    const B=`https://graph.facebook.com/v19.0`;
    const T=`access_token=${token}`;
    // profile_views/impressions dropped — both deprecated by Meta on this endpoint (see
    // /api/atlas/metrics above for the full explanation), were silently zeroing all 4
    // combined metrics when requested together.
    const TV_METRICS="accounts_engaged,total_interactions";
    const[profileR,reachR,prevReachR,followerR,prevFollowerR,demoAgeR,demoCityR,demoCountryR,mediaR,ctaR,onlineFR]=await Promise.all([
      fetch(`${B}/${igId}?fields=followers_count,media_count,name,username,profile_picture_url&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=reach&period=day&since=${since}&until=${until}&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=reach&period=day&since=${prevSince}&until=${since}&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=follower_count&period=day&since=${since}&until=${until}&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/insights?metric=follower_count&period=day&since=${prevSince}&until=${since}&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/insights?metric=follower_demographics&metric_type=total_value&period=lifetime&breakdown=age,gender&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=follower_demographics&metric_type=total_value&period=lifetime&breakdown=city&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=follower_demographics&metric_type=total_value&period=lifetime&breakdown=country&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/media?fields=id,caption,media_type,timestamp,like_count,comments_count,media_url,thumbnail_url&limit=24&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=website_clicks,email_contacts,phone_call_clicks,direction_clicks&metric_type=total_value&period=day&since=${since}&until=${until}&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/insights?metric=online_followers&period=lifetime&${T}`).then(r=>r.json()).catch(()=>({})),
    ]);
    if(profileR.error)return res.json({error:profileR.error.message,connected:false});
    // monthly breakdown for bar charts + aggregate totals
    const[monthly,prevMonthly]=await Promise.all([
      fetchMonthly(B,igId,TV_METRICS,token,since,until),
      fetchMonthly(B,igId,TV_METRICS,token,prevSince,since),
    ]);
    const TV_KEYS=["reach","accounts_engaged","total_interactions"];
    const totals={},prevTotals={};
    monthly.forEach(m=>{TV_KEYS.forEach(k=>{totals[k]=(totals[k]||0)+(m[k]||0);});});
    prevMonthly.forEach(m=>{TV_KEYS.forEach(k=>{prevTotals[k]=(prevTotals[k]||0)+(m[k]||0);});});
    const mediaPosts=mediaR.data||[];
    const postInsights=await Promise.all(mediaPosts.map(async post=>{
      try{
        const m=post.media_type==="VIDEO"?"reach,likes,comments,shares,saved,plays":"reach,likes,comments,shares,saved";
        const ins=await fetch(`${B}/${post.id}/insights?metric=${m}&${T}`).then(r=>r.json());
        const map={};
        (ins.data||[]).forEach(m=>{map[m.name]=m.values?.[0]?.value||0;});
        return{...post,ins:map};
      }catch{return{...post,ins:{}};}
    }));
    const followerVals=(followerR.data||[]).find(m=>m.name==="follower_count")?.values||[];
    const prevFollowerVals=(prevFollowerR.data||[]).find(m=>m.name==="follower_count")?.values||[];
    // follower_count with period=day is a daily-delta time series (net new followers
    // that day), same shape as reach — must be SUMMED across the period, not
    // last-minus-first (that was subtracting two unrelated single days' deltas, which
    // produced wrong/misleading growth numbers, e.g. showing -38 when Instagram's own
    // app showed real growth for the same period).
    const followerGrowth=followerVals.length>0?followerVals.reduce((s,v)=>s+(v.value||0),0):null;
    const prevFollowerGrowth=prevFollowerVals.length>0?prevFollowerVals.reduce((s,v)=>s+(v.value||0),0):null;
    const demoAge=demoAgeR.data?.[0]?.total_value?.breakdowns?.[0]?.results||[];
    const demoCity=demoCityR.data?.[0]?.total_value?.breakdowns?.[0]?.results||[];
    const demoCountry=(demoCountryR.data?.[0]?.total_value?.breakdowns?.[0]?.results||[]).sort((a,b)=>b.value-a.value).slice(0,10);
    const ctaMap={};(ctaR.data||[]).forEach(m=>{ctaMap[m.name]=m.total_value?.value||0;});
    const onlineDays=onlineFR.data?.[0]?.values||[];
    const hourTotals={};onlineDays.forEach(day=>{Object.entries(day.value||{}).forEach(([h,c])=>{hourTotals[h]=(hourTotals[h]||0)+(c||0);});});
    const dc=onlineDays.length||1;
    const onlineByHour=Object.fromEntries(Object.entries(hourTotals).map(([h,t])=>[h,Math.round(t/dc)]));
    res.json({connected:true,profile:profileR,insights:reachR.data||[],prevInsights:prevReachR.data||[],totals,prevTotals,monthly,followerGrowth,prevFollowerGrowth,followerTrend:followerVals,demoAge,demoCity,demoCountry,cta:ctaMap,onlineByHour,media:postInsights});
  }catch(err){
    console.error("Meta insights-full error:",err);
    res.status(500).json({error:err.message});
  }
});

// Temporary analysis endpoint: paginates through all media, fetches insights per post
app.get("/api/meta/posts-analysis",requireAuth,async(req,res)=>{
  try{
    const{igId,since,until}=req.query;
    if(!igId)return res.status(400).json({error:"igId requerido"});
    if(!await isValidIgId(igId))return res.status(403).json({error:"Cuenta no autorizada"});
    const token=await getMetaToken();
    if(!token)return res.json({error:"no token"});
    const sinceTs=since?parseInt(since):0;
    const untilTs=until?parseInt(until):Math.floor(Date.now()/1000);
    const B=`https://graph.facebook.com/v19.0`;
    const T=`access_token=${token}`;
    // Paginate through media until we have all posts in date range
    let url=`${B}/${igId}/media?fields=id,caption,media_type,timestamp,like_count,comments_count,media_url,thumbnail_url&limit=50&${T}`;
    let allPosts=[];let pages=0;
    while(url&&pages<10){
      const r=await fetch(url).then(r=>r.json());
      const batch=r.data||[];
      // Filter to range
      const inRange=batch.filter(p=>{const t=new Date(p.timestamp).getTime()/1000;return t>=sinceTs&&t<=untilTs;});
      const tooOld=batch.some(p=>new Date(p.timestamp).getTime()/1000<sinceTs);
      allPosts=[...allPosts,...inRange];
      if(tooOld||!r.paging?.next)break;
      url=r.paging.next;pages++;
    }
    // Fetch insights for each post in parallel
    const withInsights=await Promise.all(allPosts.map(async p=>{
      try{
        const m="reach,likes,comments,shares,saved"; // sin `plays` (deprecado por Meta; rompia los reels)
        const ins=await fetch(`${B}/${p.id}/insights?metric=${m}&${T}`).then(r=>r.json());
        const map={};(ins.data||[]).forEach(i=>{map[i.name]=i.values?.[0]?.value||0;});
        return{...p,ins:map,eng:(p.like_count||0)+(p.comments_count||0)+(map.saved||0)+(map.shares||0)};
      }catch{return{...p,ins:{},eng:(p.like_count||0)+(p.comments_count||0)};}
    }));
    withInsights.sort((a,b)=>b.eng-a.eng);
    res.json({posts:withInsights,count:withInsights.length});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── Métricas por publicación + chat de IA (portal del cliente) ────────────────
// Trae las publicaciones recientes con sus métricas. Cacheado 5 min por cuenta: el portal
// carga la tarjeta y cada mensaje del chat lo reusa sin volver a golpear la API de Meta.
const _postsCache = new Map(); // igId -> { at, posts }
async function postsConMetricas(igId, token, limite = 15) {
  const B = "https://graph.facebook.com/v19.0", T = `access_token=${token}`;
  const r = await fetch(`${B}/${igId}/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count&limit=${limite}&${T}`).then(r => r.json());
  const posts = (r.data || []).slice(0, limite);
  return Promise.all(posts.map(async p => {
    const base = { id: p.id, tipo: p.media_type, fecha: p.timestamp, permalink: p.permalink || "", caption: String(p.caption || ""), likes: p.like_count || 0, comentarios: p.comments_count || 0 };
    try {
      // Mismo set para reels y posts. NO se pide `plays`: Meta lo deprecó (2024) y, al ser un
      // métrico inválido, la llamada ENTERA fallaba para los reels y devolvía todo en 0 (alcance,
      // guardados…), dejando solo likes/comentarios. `reach` sí es válido para reels.
      const m = "reach,likes,comments,shares,saved";
      const ins = await fetch(`${B}/${p.id}/insights?metric=${m}&${T}`).then(r => r.json());
      const map = {}; (ins.data || []).forEach(i => { map[i.name] = i.values?.[0]?.value || 0; });
      const eng = base.likes + base.comentarios + (map.saved || 0) + (map.shares || 0);
      return { ...base, alcance: map.reach || 0, guardados: map.saved || 0, compartidos: map.shares || 0, plays: map.plays || 0, eng };
    } catch { return { ...base, alcance: 0, guardados: 0, compartidos: 0, plays: 0, eng: base.likes + base.comentarios }; }
  }));
}
async function postsCacheados(igId, token) {
  const c = _postsCache.get(igId);
  if (c && Date.now() - c.at < 5 * 60000) return c.posts;
  const posts = await postsConMetricas(igId, token, 15);
  _postsCache.set(igId, { at: Date.now(), posts });
  return posts;
}
const _mediana = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
// Elige la publicación objetivo (por mediaId, o por caption, o la más reciente) y la compara con
// la mediana de las últimas del MISMO tipo (reel vs feed), excluyéndola.
function analizarObjetivo(posts, { mediaId, caption } = {}) {
  if (!posts.length) return null;
  const porFecha = [...posts].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  let target = null;
  if (mediaId) target = porFecha.find(p => String(p.id) === String(mediaId));
  if (!target && caption) { const c = String(caption).trim().slice(0, 40).toLowerCase(); if (c) target = porFecha.find(p => p.caption.trim().slice(0, 40).toLowerCase() === c); }
  if (!target) target = porFecha[0];
  const mismoTipo = porFecha.filter(p => p.id !== target.id && (p.tipo === "VIDEO") === (target.tipo === "VIDEO"));
  const base = mismoTipo.slice(0, 10);
  const mAlc = _mediana(base.map(p => p.alcance)), mEng = _mediana(base.map(p => p.eng));
  const mult = (a, b) => b > 0 ? Math.round((a / b) * 10) / 10 : null;
  const mejorEnAlc = base.length ? base.filter(p => target.alcance >= p.alcance).length / base.length : null;
  return {
    target, esReel: target.tipo === "VIDEO",
    base: { n: base.length, alcanceMediano: mAlc, engMediano: mEng },
    alcanceMult: mult(target.alcance, mAlc), engMult: mult(target.eng, mEng),
    percentil: mejorEnAlc == null ? null : Math.round(mejorEnAlc * 100),
  };
}
// Verifica que el llamador puede consultar esta cuenta (un cliente, solo la suya).
async function puedeVerIg(req, igId) {
  const co = clienteDe(authInfo(req));
  if (!co) return true; // equipo
  const empresas = (await sbGet("companies", [])) || [];
  const cid = await idEmpresaCliente(co, empresas);
  const mi = empresas.find(c => String(c.id) === cid);
  return !!mi && String(mi.igId) === String(igId);
}

app.get("/api/meta/post-stats", requireAuth, async (req, res) => {
  try {
    const { igId, mediaId, caption } = req.query;
    if (!igId) return res.status(400).json({ error: "igId requerido" });
    if (!await isValidIgId(igId)) return res.status(403).json({ error: "cuenta no autorizada" });
    if (!await puedeVerIg(req, igId)) return res.status(403).json({ error: "no es tu cuenta" });
    const token = await getMetaToken();
    if (!token) return res.json({ ok: false, error: "sin token de Meta" });
    const posts = await postsCacheados(igId, token);
    const a = analizarObjetivo(posts, { mediaId, caption });
    if (!a) return res.json({ ok: true, sinDatos: true });
    res.json({ ok: true, ...a });
  } catch (e) { console.error("post-stats:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/ai/post-chat", requireAuth, rateLimit(25, "ai-chat"), async (req, res) => {
  try {
    const { igId, mediaId, caption, mensajes } = req.body || {};
    if (!igId) return res.status(400).json({ error: "igId requerido" });
    if (!await isValidIgId(igId)) return res.status(403).json({ error: "cuenta no autorizada" });
    if (!await puedeVerIg(req, igId)) return res.status(403).json({ error: "no es tu cuenta" });
    const token = await getMetaToken();
    if (!token) return res.status(502).json({ error: "sin token de Meta" });
    const posts = await postsCacheados(igId, token);
    if (!posts.length) return res.json({ respuesta: "Todavía no hay publicaciones con métricas en esta cuenta para analizar." });
    const a = analizarObjetivo(posts, { mediaId, caption });
    const t = a?.target;
    // Contexto con datos REALES para que Gemini no invente.
    const listaPosts = posts.slice(0, 12).map(p => `- [${p.tipo === "VIDEO" ? "reel" : "post"}] ${String(p.fecha).slice(0, 10)} "${p.caption.replace(/\s+/g, " ").slice(0, 55)}" → alcance ${p.alcance}, likes ${p.likes}, comentarios ${p.comentarios}, guardados ${p.guardados}, compartidos ${p.compartidos}${p.plays ? `, reproducciones ${p.plays}` : ""}, interacción total ${p.eng}`).join("\n");
    const foco = t ? `\nLA PUBLICACIÓN SOBRE LA QUE PREGUNTAN es la del ${String(t.fecha).slice(0, 10)} ("${t.caption.replace(/\s+/g, " ").slice(0, 55)}"): alcance ${t.alcance}, likes ${t.likes}, comentarios ${t.comentarios}, guardados ${t.guardados}, compartidos ${t.compartidos}. Comparada con la mediana de sus últimos ${a.base.n} ${a.esReel ? "reels" : "posts"}: alcance ${a.alcanceMult ? a.alcanceMult + "×" : "s/d"}, interacción ${a.engMult ? a.engMult + "×" : "s/d"}.` : "";
    const sistema = `Eres el analista de redes sociales de la agencia INMERSIA, conversando con el cliente dentro de su portal. Respondes SOLO con los datos reales de abajo. Si te preguntan algo que los datos no cubren (por ejemplo, edad de la audiencia o datos de anuncios pagados), dilo con honestidad y NO inventes cifras. Español de Chile, cercano, claro y sin jerga innecesaria. Respuestas breves (2-5 frases), concretas y accionables; usa los números y múltiplos reales.

DATOS REALES (últimas ${posts.length} publicaciones de la cuenta):
${listaPosts}
${foco}`;
    const historia = (Array.isArray(mensajes) ? mensajes : []).slice(-8).map(m => `${m.rol === "user" ? "Cliente" : "Analista"}: ${String(m.texto || "").slice(0, 600)}`).join("\n");
    const prompt = `${sistema}\n\nConversación:\n${historia}\nAnalista:`;
    const respuesta = await callGemini([{ parts: [{ text: prompt }] }]);
    res.json({ respuesta: respuesta || "No pude generar una respuesta ahora, inténtalo de nuevo." });
  } catch (e) { console.error("post-chat:", e.message); res.status(500).json({ error: e.message }); }
});

app.get("/api/meta/insights",requireAuth,async(req,res)=>{
  try{
    const{igId}=req.query;
    if(!igId)return res.status(400).json({error:"igId requerido"});
    if(!await isValidIgId(igId))return res.status(403).json({error:"Cuenta no autorizada"});
    const token=await getMetaToken();
    if(!token)return res.json({error:"Meta no conectado",connected:false});
    const until=Math.floor(Date.now()/1000);
    const since=until-30*24*60*60;
    const prevSince=since-30*24*60*60;
    const profileRes=await fetch(`https://graph.facebook.com/v19.0/${igId}?fields=followers_count,media_count,name,username,profile_picture_url&access_token=${token}`);
    const profile=await profileRes.json();
    if(profile.error)return res.json({error:profile.error.message,connected:false});
    // Reach: serie diaria para gráfico
    const reachRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=reach&period=day&since=${since}&until=${until}&access_token=${token}`);
    const reachData=await reachRes.json();
    const prevReachRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=reach&period=day&since=${prevSince}&until=${since}&access_token=${token}`);
    const prevReachData=await prevReachRes.json();
    // Métricas de valor total
    const tvRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=profile_views,accounts_engaged,total_interactions&metric_type=total_value&period=day&since=${since}&until=${until}&access_token=${token}`);
    const tvData=await tvRes.json();
    const prevTvRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=profile_views,accounts_engaged,total_interactions&metric_type=total_value&period=day&since=${prevSince}&until=${since}&access_token=${token}`);
    const prevTvData=await prevTvRes.json();
    const mediaRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/media?fields=id,caption,media_type,timestamp,like_count,comments_count,media_url,thumbnail_url&limit=9&access_token=${token}`);
    const media=await mediaRes.json();
    const totals={};const prevTotals={};
    (tvData.data||[]).forEach(m=>{totals[m.name]=m.total_value?.value||0;});
    (prevTvData.data||[]).forEach(m=>{prevTotals[m.name]=m.total_value?.value||0;});
    res.json({connected:true,profile,insights:reachData.data||[],prevInsights:prevReachData.data||[],totals,prevTotals,media:media.data||[]});
  }catch(err){
    console.error("Meta insights error:",err);
    res.status(500).json({error:err.message});
  }
});

// ===============================
// 🤖 ATLAS VOICE ASSISTANT API
// ===============================
const requireAtlas=(req,res,next)=>{
  const key=req.headers['x-atlas-key'];
  const validKey=process.env.ATLAS_API_KEY||'atlas2026XkP9mWqVz3bNj';
  if(!key||key!==validKey)return res.status(401).json({error:'unauthorized'});
  next();
};

// Read-only Meta Ads (Marketing API) access, separate from the Instagram Insights API
// used above — needs the `ads_read` scope on the Meta token (added 2026-07-13) and a
// re-authorization of the /api/auth/meta connection to take effect.
const INMERSIA_AD_ACCOUNTS={
  huemul:"act_1809797739421316",
};

app.get("/api/atlas/ads",requireAtlas,async(req,res)=>{
  try{
    const client=(req.query.client||'huemul').toLowerCase().trim();
    const adAccount=INMERSIA_AD_ACCOUNTS[client];
    if(!adAccount)return res.status(400).json({error:`No ad account mapped for '${client}'. Known: ${Object.keys(INMERSIA_AD_ACCOUNTS).join(', ')}`});
    const token=await getMetaToken();
    if(!token)return res.json({error:'Meta no conectado'});
    const days=Math.min(parseInt(req.query.days)||30,180);
    const statusFilter=(req.query.status||'ACTIVE').toUpperCase(); // 'ACTIVE' or 'ALL'
    const until=Math.floor(Date.now()/1000);
    const since=until-days*24*60*60;
    const toDateStr=ts=>new Date(ts*1000).toISOString().slice(0,10);
    const B=`https://graph.facebook.com/v19.0`;
    const T=`access_token=${token}`;
    const timeRange=encodeURIComponent(JSON.stringify({since:toDateStr(since),until:toDateStr(until)}));

    const[campaignsR,insightsR]=await Promise.all([
      fetch(`${B}/${adAccount}/campaigns?fields=id,name,objective,status,effective_status,daily_budget,lifetime_budget&limit=100&${T}`).then(r=>r.json()),
      fetch(`${B}/${adAccount}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,actions&time_range=${timeRange}&limit=100&${T}`).then(r=>r.json()),
    ]);
    if(campaignsR.error)return res.json({error:campaignsR.error.message});
    if(insightsR.error)console.error("Meta ads insights error:",insightsR.error.message||insightsR.error);

    const insightsByCampaign={};
    (insightsR.data||[]).forEach(i=>{insightsByCampaign[i.campaign_id]=i;});

    let campaigns=(campaignsR.data||[]).map(c=>{
      const ins=insightsByCampaign[c.id]||{};
      const results=(ins.actions||[]).reduce((sum,a)=>sum+(parseInt(a.value)||0),0);
      return{
        id:c.id,name:c.name,objective:c.objective,
        status:c.status,effectiveStatus:c.effective_status,
        dailyBudget:c.daily_budget?parseInt(c.daily_budget)/100:null,
        lifetimeBudget:c.lifetime_budget?parseInt(c.lifetime_budget)/100:null,
        spend:parseFloat(ins.spend||0),impressions:parseInt(ins.impressions||0),
        reach:parseInt(ins.reach||0),clicks:parseInt(ins.clicks||0),
        ctr:parseFloat(ins.ctr||0),cpc:parseFloat(ins.cpc||0),
        results,
      };
    });
    if(statusFilter!=='ALL')campaigns=campaigns.filter(c=>c.effectiveStatus===statusFilter);

    res.json({
      client,adAccount,period:`${days} días`,status:statusFilter,
      campaignCount:campaigns.length,campaigns,
    });
  }catch(err){console.error("Atlas ads error:",err);res.status(500).json({error:err.message});}
});

app.get("/api/atlas/metrics",requireAtlas,async(req,res)=>{
  try{
    const igId=req.query.igId||'17841472187907093';
    if(!await isValidIgId(igId))return res.status(403).json({error:'cuenta no autorizada'});
    const token=await getMetaToken();
    if(!token)return res.json({error:'Meta no conectado'});
    // Explicit range (unix seconds) overrides the relative "last N days" mode —
    // lets Atlas pull fixed historical windows (e.g. comparing two past quarters)
    // instead of always ending "now".
    const qSince=parseInt(req.query.since),qUntil=parseInt(req.query.until);
    const hasRange=Number.isFinite(qSince)&&Number.isFinite(qUntil)&&qUntil>qSince;
    const days=hasRange?Math.round((qUntil-qSince)/86400):Math.min(parseInt(req.query.days)||30,180);
    const until=hasRange?qUntil:Math.floor(Date.now()/1000);
    const since=hasRange?qSince:until-days*24*60*60;
    const prevSince=since-(until-since);
    const B=`https://graph.facebook.com/v19.0`;
    const T=`access_token=${token}`;
    // profile_views and impressions were dropped from this list — both are deprecated by
    // Meta on Instagram Insights (profile_views removed from this endpoint entirely;
    // impressions deprecated for all API versions since 2025-04-21). Requesting them
    // alongside valid metrics made Meta reject the WHOLE combined call, which silently
    // zeroed out all four fields (reach was unaffected — fetched in a separate call).
    const TV_METRICS="accounts_engaged,total_interactions";
    const[profileR,monthly,prevMonthly,followerR,prevFollowerR,ctaR,mediaR]=await Promise.all([
      fetch(`${B}/${igId}?fields=followers_count,media_count,name,username&${T}`).then(r=>r.json()),
      fetchMonthly(B,igId,TV_METRICS,token,since,until),
      fetchMonthly(B,igId,TV_METRICS,token,prevSince,since),
      fetch(`${B}/${igId}/insights?metric=follower_count&period=day&since=${since}&until=${until}&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/insights?metric=follower_count&period=day&since=${prevSince}&until=${since}&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/insights?metric=website_clicks,email_contacts,phone_call_clicks,direction_clicks&metric_type=total_value&period=day&since=${since}&until=${until}&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/media?fields=id,media_type,like_count,comments_count&limit=24&${T}`).then(r=>r.json()),
    ]);
    if(profileR.error)return res.json({error:profileR.error.message});
    const TV_KEYS=["reach","accounts_engaged","total_interactions"];
    const totals={},prevTotals={};
    monthly.forEach(m=>{TV_KEYS.forEach(k=>{totals[k]=(totals[k]||0)+(m[k]||0);});});
    prevMonthly.forEach(m=>{TV_KEYS.forEach(k=>{prevTotals[k]=(prevTotals[k]||0)+(m[k]||0);});});
    const followerVals=(followerR.data||[]).find(m=>m.name==="follower_count")?.values||[];
    const prevFollowerVals=(prevFollowerR.data||[]).find(m=>m.name==="follower_count")?.values||[];
    // follower_count with period=day is a daily-delta time series (net new followers
    // that day), same shape as reach — must be SUMMED across the period, not
    // last-minus-first (that was subtracting two unrelated single days' deltas, which
    // produced wrong/misleading growth numbers, e.g. showing -38 when Instagram's own
    // app showed real growth for the same period).
    const followerGrowth=followerVals.length>0?followerVals.reduce((s,v)=>s+(v.value||0),0):null;
    const prevFollowerGrowth=prevFollowerVals.length>0?prevFollowerVals.reduce((s,v)=>s+(v.value||0),0):null;
    const ctaMap={};(ctaR.data||[]).forEach(m=>{ctaMap[m.name]=m.total_value?.value||0;});
    const mediaPosts=mediaR.data||[];
    const topPost=mediaPosts.length>0?[...mediaPosts].sort((a,b)=>((b.like_count||0)+(b.comments_count||0))-((a.like_count||0)+(a.comments_count||0)))[0]:null;
    res.json({
      company:profileR.name,username:profileR.username,
      period:hasRange?`${new Date(since*1000).toISOString().slice(0,10)} a ${new Date(until*1000).toISOString().slice(0,10)}`:`${days} días`,
      followers:profileR.followers_count,followerGrowth,prevFollowerGrowth,
      reach:totals.reach||0,prevReach:prevTotals.reach||0,
      interactions:totals.total_interactions||0,
      prevInteractions:prevTotals.total_interactions||0,
      accountsEngaged:totals.accounts_engaged||0,
      // impressions/profileViews intentionally omitted — Meta deprecated both metrics on
      // this endpoint, no direct replacement exists as of 2026.
      cta:ctaMap,monthly,
      topPost:topPost?{type:topPost.media_type,likes:topPost.like_count||0,comments:topPost.comments_count||0}:null,
    });
  }catch(err){console.error("Atlas metrics error:",err);res.status(500).json({error:err.message});}
});

// Prospectos (leads) pushed by Atlas's leads_tool.py — stored as a single app_data
// row (key="prospects") like everything else in this app, deduped by place_id.
async function loadProspects(){
  const sbUrl=process.env.SUPABASE_URL||"https://cvytwyvaxccbcpfqezlr.supabase.co";
  const sbKey=process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_KEY||"sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
  const r=await fetch(`${sbUrl}/rest/v1/app_data?key=eq.prospects&select=value`,{
    headers:{apikey:sbKey,Authorization:`Bearer ${sbKey}`}
  });
  const d=await r.json();
  return d?.[0]?.value||[];
}
async function saveProspects(list){
  const sbUrl=process.env.SUPABASE_URL||"https://cvytwyvaxccbcpfqezlr.supabase.co";
  const sbKey=process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_KEY||"sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
  await fetch(`${sbUrl}/rest/v1/app_data`,{
    method:"POST",
    headers:{apikey:sbKey,Authorization:`Bearer ${sbKey}`,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates"},
    body:JSON.stringify({key:"prospects",value:list,updated_at:new Date().toISOString()})
  });
}

// Fields Atlas is allowed to fill in on an ALREADY-existing prospect (re-running
// discover/enrich, or a later deep-research pass, can find things a first pass
// missed) — only fills gaps (existing truthy value wins), and never touches
// `status`, so an aprobado/rechazado decision Jose already made is untouched.
const PROSPECT_FILLABLE_FIELDS=["instagram_handle","website","phone","profile_notes"];

app.post("/api/atlas/prospects",requireAtlas,async(req,res)=>{
  try{
    const incoming=Array.isArray(req.body?.prospects)?req.body.prospects:[];
    if(!incoming.length)return res.status(400).json({error:"prospects vacío"});
    const existing=await loadProspects();
    const byId=new Map(existing.map(p=>[p.id,p]));
    let added=0,updated=0,skipped=0;
    for(const p of incoming){
      if(!p.id||p.fit_flag==="EXCLUIR"){skipped++;continue;}
      const cur=byId.get(p.id);
      if(!cur){
        byId.set(p.id,{...p,status:p.status||"pendiente",created_at:new Date().toISOString()});
        added++;
        continue;
      }
      let changed=false;
      for(const f of PROSPECT_FILLABLE_FIELDS){
        if(!cur[f]&&p[f]){cur[f]=p[f];changed=true;}
      }
      if(changed)updated++;else skipped++;
    }
    const merged=[...byId.values()];
    await saveProspects(merged);
    res.json({added,updated,skipped,total:merged.length});
  }catch(err){console.error("Atlas prospects push error:",err);res.status(500).json({error:err.message});}
});

// GET ?status=aprobado is what Atlas/Claude Code calls later to fetch the ones Jose
// approved in the Prospectos tab, for the deeper (non-scripted) research follow-up.
app.get("/api/atlas/prospects",requireAtlas,async(req,res)=>{
  try{
    const status=(req.query.status||"").toLowerCase().trim();
    let list=await loadProspects();
    if(status)list=list.filter(p=>(p.status||"pendiente").toLowerCase()===status);
    res.json({count:list.length,prospects:list});
  }catch(err){console.error("Atlas prospects get error:",err);res.status(500).json({error:err.message});}
});

// ===============================
// 📤 SUBIDA DE CONTENIDO (Supabase Storage)
// ===============================
// Los archivos de contenido (posts, reels) NO pueden ir como base64 dentro de la fila
// `tasks` de app_data: un solo reel infla la fila decenas de MB, y DB.loadAll() se trae
// esa fila entera en cada carga de cada usuario. Aquí subimos el binario a Supabase
// Storage y devolvemos solo la URL pública, que es lo que se guarda en la tarea.
const CONTENT_BUCKET = process.env.SUPABASE_BUCKET || "contenido";
const uploadBig = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function storageKey() {
  // La subida a Storage necesita service_role: la publishable key no puede escribir.
  return process.env.SUPABASE_SERVICE_KEY || "";
}
const storageUrl = () => process.env.SUPABASE_URL || "https://cvytwyvaxccbcpfqezlr.supabase.co";

// Supabase manda el motivo real dentro del cuerpo, y devuelve 400 para cosas muy distintas
// entre sí: bucket que no existe, tipo de archivo no permitido, archivo sobre el tope del
// bucket. Un "Storage respondió 400" a secas no dejaba saber cuál de las tres era, así que
// no había por dónde empezar a arreglarlo.
function explicarStorage(status, detail) {
  let d = {};
  try { d = JSON.parse(detail); } catch (_) {}
  const m = `${d.error || ""} ${d.message || ""}`.toLowerCase();
  if (m.includes("bucket not found"))
    return `El bucket "${CONTENT_BUCKET}" no existe en Supabase Storage. Hay que crearlo y marcarlo como público.`;
  if (m.includes("mime"))
    return `Supabase rechazó el tipo de archivo. Revisa los "Allowed MIME types" del bucket "${CONTENT_BUCKET}".`;
  if (status === 413 || m.includes("maximum allowed size") || m.includes("payload too large"))
    return `El archivo pasa el tope de tamaño del bucket "${CONTENT_BUCKET}". Se sube en la configuración del bucket.`;
  // "Invalid Compact JWS" = lo que llegó en el Authorization no es un JWT. Pasa al poner una
  // clave del formato nuevo (`sb_secret_…`/`sb_publishable_…`) donde va la service_role
  // clásica. Despista porque esa misma clave sí sirve para leer el bucket.
  if (m.includes("compact jws") || m.includes("jwt"))
    return `SUPABASE_SERVICE_KEY no es una clave válida para escribir: Storage esperaba la service_role (el JWT largo que empieza por "eyJ") y recibió otra cosa.`;
  if (status === 403 || m.includes("unauthorized") || m.includes("row-level security"))
    return "La llave de Supabase no puede escribir en Storage: SUPABASE_SERVICE_KEY tiene que ser la service_role.";
  if (m.includes("invalid") && m.includes("key"))
    return "A Supabase no le sirvió el nombre del archivo.";
  return `Storage respondió ${status}${d.message ? ": " + d.message : ""}`;
}

app.post("/api/upload", requireAuth, uploadBig.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });
    // Si Storage no está disponible —falta la llave o el bucket no existe— se avisa con
    // `storage_no_configurado` para que el frontend caiga a base64 en los archivos chicos y
    // se pueda seguir trabajando. Antes solo se comprobaba la llave: con el bucket sin crear
    // la subida llegaba hasta Supabase y moría en un 400, sin fallback.
    const est = await estadoStorage();
    if (!est.ready) return res.status(503).json({ error: "storage_no_configurado", motivo: est.motivo });
    const key = storageKey();

    const sbUrl = storageUrl();
    const safeName = (req.file.originalname || "archivo")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const folder = String(req.body?.companyId || "sin_empresa").replace(/[^a-zA-Z0-9_-]/g, "");
    const objectPath = `${folder}/${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safeName}`;

    const r = await fetch(`${sbUrl}/storage/v1/object/${CONTENT_BUCKET}/${objectPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        // El `apikey` NO es redundante. Con la service_role antigua (un JWT) bastaba el Bearer,
        // porque Storage parseaba el token. Las claves nuevas `sb_secret_…` son opacas, no JWT:
        // sin este header Storage intenta parsearlas como JWT y responde 403 "Invalid Compact
        // JWS". Eso es lo que se leía como "la llave puede leer pero no escribir" —la lectura
        // del bucket sí mandaba `apikey` y por eso pasaba—. Comprobado contra Storage: la misma
        // subida da 403 sin este header y 200 con él.
        apikey: key,
        "Content-Type": req.file.mimetype || "application/octet-stream",
        "x-upsert": "true",
      },
      body: req.file.buffer,
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error("Storage upload failed:", r.status, detail);
      // Una llave puede servir para LEER el bucket y no para escribir en él —es exactamente
      // lo que pasaba: `/api/upload/status` decía "listo" y cada subida moría con 403
      // "Invalid Compact JWS". Cuando el fallo es de permisos se invalida el estado cacheado
      // y se responde como si Storage no estuviera configurado, que es la verdad práctica:
      // así el frontend vuelve a su respaldo en vez de tragarse el error.
      if (r.status === 401 || r.status === 403 || /invalid compact jws|unauthorized/i.test(detail)) {
        bucketCache = { at: Date.now(), data: { ready: false, bucket: CONTENT_BUCKET,
          motivo: "la llave puede leer el bucket pero no escribir en él — SUPABASE_SERVICE_KEY tiene que ser la service_role" } };
        return res.status(503).json({ error: "storage_no_configurado", motivo: bucketCache.data.motivo });
      }
      return res.status(502).json({ error: explicarStorage(r.status, detail), detail: detail.slice(0, 300) });
    }

    res.json({
      url: `${sbUrl}/storage/v1/object/public/${CONTENT_BUCKET}/${objectPath}`,
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Permite al frontend saber si puede subir video o si tiene que limitarse a imágenes
// pequeñas en base64 (fallback cuando el bucket todavía no está configurado).
// Tener la llave no basta: con la llave puesta y el bucket sin crear, esto respondía
// "listo" y la subida moría después con un 400 que no explicaba nada. Se comprueba el
// bucket de verdad, con un caché corto para no consultarlo en cada carga de la app.
let bucketCache = null;   // { at, data }
async function estadoStorage() {
  if (bucketCache && Date.now() - bucketCache.at < 60_000) return bucketCache.data;
  const key = storageKey();
  let data;
  if (!key) {
    data = { ready: false, bucket: CONTENT_BUCKET, motivo: "falta SUPABASE_SERVICE_KEY en el servidor" };
  } else {
    try {
      const r = await fetch(`${storageUrl()}/storage/v1/bucket/${CONTENT_BUCKET}`, {
        headers: { Authorization: `Bearer ${key}`, apikey: key },
      });
      if (r.status === 404) {
        data = { ready: false, bucket: CONTENT_BUCKET, motivo: `el bucket "${CONTENT_BUCKET}" no existe en Supabase Storage` };
      } else if (!r.ok) {
        data = { ready: false, bucket: CONTENT_BUCKET, motivo: `Supabase respondió ${r.status} al consultar el bucket` };
      } else {
        const b = await r.json().catch(() => ({}));
        data = {
          ready: true,
          bucket: CONTENT_BUCKET,
          publico: !!b.public,
          topeBytes: b.file_size_limit || null,
          tiposPermitidos: b.allowed_mime_types || null,
        };
      }
    } catch (err) {
      data = { ready: false, bucket: CONTENT_BUCKET, motivo: "no se pudo consultar Supabase: " + err.message };
    }
  }
  bucketCache = { at: Date.now(), data };
  return data;
}

app.get("/api/upload/status", requireAuth, async (req, res) => {
  res.json(await estadoStorage());
});

// ===============================
// 📣 PUBLICAR EN REDES (Zernio)
// ===============================
// Zernio publica con SUS credenciales, ya aprobadas por Meta y TikTok. Eso es lo que se está
// comprando: sin esto hay que pasar el App Review de Instagram con Advanced Access —obligatorio
// para publicar en cuentas que no son nuestras— y la auditoría de TikTok, que hasta aprobarse
// solo deja publicar en privado. Se paga por cuenta conectada y las dos primeras son gratis.
//
// Un "profile" de Zernio es el contenedor de cuentas de UNA marca, así que va uno por empresa:
// el día que se va un cliente se borra su profile y no se toca a los demás. El mapa
// empresa → profile → cuenta vive en app_data.social.
const ZERNIO_API = "https://zernio.com/api/v1";
const zernioKey = () => (process.env.ZERNIO_API_KEY || "").trim();

async function zernio(ruta, opts = {}) {
  const key = zernioKey();
  if (!key) throw new Error("falta ZERNIO_API_KEY en el servidor");
  const r = await fetch(ZERNIO_API + ruta, {
    ...opts,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 300) }; }
  if (!r.ok) {
    const err = new Error(data?.error || data?.message || `Zernio respondió ${r.status}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

const socialVacio = () => ({ profiles: {}, cuentas: {} });
async function loadSocial() {
  const v = await sbGet("social", null);
  return (v && typeof v === "object" && !Array.isArray(v)) ? { ...socialVacio(), ...v } : socialVacio();
}
// Se reusa la cola de los avisos a propósito: es la misma fila única de Supabase y el mismo
// lost update: conectar dos cuentas a la vez y que la segunda pise a la primera.
const saveSocial = fn => enCola(async () => {
  const s = await loadSocial();
  const out = (await fn(s)) || s;
  await sbPut("social", out);
  return out;
});

async function ensureProfile(companyId, nombre) {
  const s = await loadSocial();
  if (s.profiles[companyId]) return s.profiles[companyId];
  const d = await zernio("/profiles", {
    method: "POST",
    body: JSON.stringify({ name: nombre || companyId, description: `Inmersia · ${nombre || companyId}` }),
  });
  const id = d?.profile?._id || d?._id;
  if (!id) throw new Error("Zernio no devolvió el id del profile");
  await saveSocial(s2 => { s2.profiles[companyId] = id; return s2; });
  return id;
}

app.get("/api/social/status", requireAuth, async (req, res) => {
  if (!zernioKey()) return res.json({ ready: false, motivo: "falta ZERNIO_API_KEY en el servidor" });
  try {
    const d = await zernio("/accounts");
    const lista = Array.isArray(d) ? d : (d.accounts || []);
    res.json({ ready: true, conectadas: lista.length });
  } catch (err) { res.json({ ready: false, motivo: err.message }); }
});

// Devuelve la URL de OAuth. La abre la persona del equipo con la sesión de la marca puesta;
// Instagram exige cuenta Business o Creator, con una personal el propio Instagram corta.
app.post("/api/social/connect", requireAuth, async (req, res) => {
  const { companyId, nombre, platform = "instagram" } = req.body || {};
  if (!companyId) return res.status(400).json({ error: "companyId requerido" });
  try {
    const profileId = await ensureProfile(companyId, nombre);
    const d = await zernio(`/connect/${encodeURIComponent(platform)}?profileId=${encodeURIComponent(profileId)}`);
    const authUrl = d?.authUrl || d?.url;
    if (!authUrl) return res.status(502).json({ error: "Zernio no devolvió authUrl", detalle: d });
    res.json({ authUrl, profileId });
  } catch (err) { res.status(502).json({ error: err.message, detalle: err.data || null }); }
});

// Zernio es la fuente de verdad: si el cliente desconecta su cuenta desde allá, aquí tiene que
// desaparecer. Por eso el mapa se reescribe entero en vez de ir agregando.
app.get("/api/social/accounts", requireAuth, async (req, res) => {
  try {
    const s = await loadSocial();
    const d = await zernio("/accounts");
    const lista = Array.isArray(d) ? d : (d.accounts || []);
    const porProfile = {};
    for (const a of lista) {
      // Zernio devuelve profileId poblado como objeto ({_id, name}), no como string. Un
      // String() a secas daba "[object Object]" y el mapa empresa→cuenta salía vacío: la
      // publicación moría con "no_conectada" teniendo la cuenta conectada.
      const crudo = a.profileId ?? a.profile;
      const pid = String((crudo && typeof crudo === "object" ? (crudo._id || crudo.id) : crudo) || "");
      (porProfile[pid] = porProfile[pid] || []).push({
        accountId: a._id || a.id,
        platform: a.platform,
        username: a.username || a.displayName || a.name || "",
      });
    }
    const cuentas = {};
    for (const [cid, pid] of Object.entries(s.profiles)) {
      for (const a of (porProfile[String(pid)] || [])) {
        cuentas[cid] = { ...(cuentas[cid] || {}), [a.platform]: a };
      }
    }
    await saveSocial(s2 => { s2.cuentas = cuentas; return s2; });
    res.json(req.query.companyId ? (cuentas[req.query.companyId] || {}) : cuentas);
  } catch (err) { res.status(502).json({ error: err.message, detalle: err.data || null }); }
});

const IG_CAPTION_MAX = 2200;

app.post("/api/social/publish", requireAuth, async (req, res) => {
  const { companyId, platform = "instagram", caption = "", media = [], contentType, scheduledFor, timezone } = req.body || {};
  if (!companyId) return res.status(400).json({ error: "companyId requerido" });
  if (!Array.isArray(media) || !media.length) return res.status(400).json({ error: "hace falta al menos un archivo" });

  // Instagram descarga el archivo desde la URL, no se lo mandamos nosotros. Con el respaldo en
  // base64 que usa la app cuando Storage no está listo no hay publicación posible, y más vale
  // decirlo aquí que dejar que muera del otro lado con un error que no explica nada.
  if (media.some(m => !/^https?:\/\//i.test(String(m.url || ""))))
    return res.status(400).json({ error: "La pieza no está en Storage: Instagram necesita una URL pública, no un archivo incrustado en la tarea." });
  if (media.some(m => /drive\.google|dropbox|onedrive|icloud/i.test(String(m.url))))
    return res.status(400).json({ error: "Los enlaces de Drive/Dropbox devuelven una página HTML en vez del archivo. Sube la pieza a la app." });
  if (platform === "instagram" && caption.length > IG_CAPTION_MAX)
    return res.status(400).json({ error: `El texto pasa de ${IG_CAPTION_MAX} caracteres (van ${caption.length}).` });

  try {
    const s = await loadSocial();
    const cuenta = s.cuentas?.[companyId]?.[platform];
    if (!cuenta?.accountId) return res.status(409).json({ error: "no_conectada", motivo: `esta empresa no tiene ${platform} conectado` });

    const d = await zernio("/posts", {
      method: "POST",
      body: JSON.stringify({
        content: caption,
        mediaItems: media.map(m => ({ type: m.type === "video" ? "video" : "image", url: m.url })),
        platforms: [{ platform, accountId: cuenta.accountId, ...(contentType ? { platformSpecificData: { contentType } } : {}) }],
        ...(scheduledFor ? { scheduledFor, timezone: timezone || "America/Santiago" } : { publishNow: true }),
      }),
    });
    const post = d?.post || d;
    res.json({ ok: true, postId: post?._id || post?.id || null, status: post?.status || "enviado" });
  } catch (err) { res.status(502).json({ error: err.message, detalle: err.data || null }); }
});

// Responder 200 no significa publicado: Instagram procesa el video después. Sin consultar el
// estado real, la ficha de Contenido cantaría victoria antes de tiempo.
app.get("/api/social/post/:id", requireAuth, async (req, res) => {
  try {
    const d = await zernio(`/posts/${encodeURIComponent(req.params.id)}`);
    const post = d?.post || d;
    res.json({ status: post?.status || null, platforms: post?.platforms || [] });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ===============================
// 💬 INSTAGRAM DIRECTO — comentario → DM (respuesta privada)
// ===============================
// Zernio publica bien, pero su respuesta a comentarios es PÚBLICA: devuelve un commentId. La
// respuesta privada —el "comenta EXPLORA y te mando la info"— es una capacidad aparte de Meta
// y hay que hablarla con Meta directamente. De ahí este bloque, que no pasa por Zernio.
//
// Meta permite UN solo mensaje privado por comentario, dentro de 7 días. Para seguir la
// conversación la persona tiene que responder. Eso no es una limitación nuestra y no se puede
// esquivar: es la regla que hace que esto no sea spam.
//
// Acceso: con Standard Access basta para cuentas propias (Valle Aventura). Para cuentas de
// clientes hace falta Advanced Access, que exige App Review y verificación de negocio.
// v25.0 y el token SIEMPRE como parámetro de consulta. Con `Authorization: Bearer` —que es lo
// habitual en el resto de APIs de Meta— graph.instagram.com contesta "Unsupported request -
// method type: get", un error que no menciona la autenticación por ninguna parte y manda a
// buscar el fallo en los permisos, que es donde no está.
const IG_API = "https://graph.instagram.com/v25.0";
const igAppId = () => (process.env.IG_APP_ID || "").trim();
const igAppSecret = () => (process.env.IG_APP_SECRET || "").trim();
const igVerifyToken = () => (process.env.IG_WEBHOOK_VERIFY_TOKEN || "").trim();
const IG_SCOPE = "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages";

function igRedirectURI(req) {
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").toLowerCase();
  const h = HOSTS_OK.has(host) ? host : "portal.inmersiaperformance.cl";
  // Meta exige https en la URL de retorno, así que localhost no sirve para esta parte.
  return `https://${h}/api/ig/callback`;
}

// El companyId viaja en el `state`, firmado: sin firma, cualquiera podría completar el OAuth
// apuntando a otra empresa y quedarse con la cuenta conectada de un cliente ajeno.
const igState = cid => {
  const p = Buffer.from(JSON.stringify({ cid, t: Date.now() })).toString("base64url");
  return p + "." + crypto.createHmac("sha256", JWT_SECRET).update(p).digest("base64url");
};
function igLeerState(s) {
  try {
    const i = String(s).lastIndexOf(".");
    const p = String(s).slice(0, i);
    if (crypto.createHmac("sha256", JWT_SECRET).update(p).digest("base64url") !== String(s).slice(i + 1)) return null;
    const d = JSON.parse(Buffer.from(p, "base64url").toString());
    return Date.now() - d.t > 30 * 60000 ? null : d;   // media hora para completar el OAuth
  } catch { return null; }
}

const igVacio = () => ({ cuentas: {}, reglas: {}, respondidos: {} });
async function loadIG() {
  const v = await sbGet("ig", null);
  return (v && typeof v === "object" && !Array.isArray(v)) ? { ...igVacio(), ...v } : igVacio();
}
const saveIG = fn => enCola(async () => {
  const s = await loadIG();
  const out = (await fn(s)) || s;
  await sbPut("ig", out);
  return out;
});

// Los tokens de larga duración viven 60 días. Se renuevan cuando quedan menos de 10: si se
// dejara vencer, la automatización moriría en silencio y nadie se enteraría hasta que un
// cliente reclamara que no le llegan los mensajes.
async function igToken(companyId) {
  const s = await loadIG();
  const c = s.cuentas[companyId];
  if (!c?.token) return null;
  const quedan = (c.expira || 0) - Date.now();
  if (quedan > 10 * 24 * 3600000) return c;
  try {
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(c.token)}`);
    const d = await r.json();
    if (d?.access_token) {
      const nuevo = { ...c, token: d.access_token, expira: Date.now() + (d.expires_in || 5184000) * 1000 };
      await saveIG(s2 => { s2.cuentas[companyId] = nuevo; return s2; });
      return nuevo;
    }
  } catch (e) { console.error("IG refresh:", e.message); }
  return c;   // se devuelve el viejo: puede que aún sirva
}

app.get("/api/ig/status", requireAuth, async (req, res) => {
  const cid = String(req.query.companyId || "");
  if (!igAppId() || !igAppSecret())
    return res.json({ configurado: false, motivo: "faltan IG_APP_ID e IG_APP_SECRET en el servidor" });
  const s = await loadIG();
  const c = s.cuentas[cid];
  res.json({
    configurado: true,
    conectada: !!c,
    username: c?.username || null,
    expiraEn: c?.expira ? Math.max(0, Math.round((c.expira - Date.now()) / 86400000)) : null,
    reglas: s.reglas[cid] || [],
    // Solo mientras no haya conexión: una vez conectada, un error viejo confunde más que ayuda.
    ultimoError: c ? null : (s.ultimoError || null),
  });
});

app.get("/api/ig/connect", requireAuth, (req, res) => {
  const cid = String(req.query.companyId || "");
  if (!cid) return res.status(400).json({ error: "companyId requerido" });
  if (!igAppId()) return res.status(400).json({ error: "falta IG_APP_ID en el servidor" });
  const url = "https://www.instagram.com/oauth/authorize"
    + `?client_id=${encodeURIComponent(igAppId())}`
    + `&redirect_uri=${encodeURIComponent(igRedirectURI(req))}`
    + `&scope=${encodeURIComponent(IG_SCOPE)}`
    + `&response_type=code&state=${encodeURIComponent(igState(cid))}`;
  res.json({ authUrl: url });
});

// Pública a propósito: aquí vuelve Instagram, sin la cookie de sesión. Lo que autentica no es
// la sesión sino la firma del `state` más el código de un solo uso.
app.get("/api/ig/callback", async (req, res) => {
  // El motivo del fallo se guarda además de mostrarse: el aviso en pantalla dura dos segundos
  // y medio y se pierde con la recarga, así que sin esto no hay forma de saber qué dijo
  // Instagram salvo mirar los registros del servidor.
  const fin = async (ok, msg) => {
    if (!ok) {
      try { await saveIG(s => { s.ultimoError = { msg, fecha: new Date().toISOString() }; return s; }); }
      catch (_) { /* que un fallo al anotar no tape el fallo real */ }
      console.error("IG callback:", msg);
    }
    res.redirect(`/?ig=${ok ? "ok" : "error"}&msg=${encodeURIComponent(msg)}`);
  };
  try {
    const st = igLeerState(req.query.state);
    if (!st) return fin(false, "el enlace de autorización venció o fue alterado");
    if (req.query.error) return fin(false, String(req.query.error_description || req.query.error));

    const cuerpo = new URLSearchParams({
      client_id: igAppId(), client_secret: igAppSecret(), grant_type: "authorization_code",
      redirect_uri: igRedirectURI(req), code: String(req.query.code || ""),
    });
    const r = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: cuerpo.toString(),
    });
    const corto = await r.json();
    if (!corto?.access_token) return fin(false, corto?.error_message || "Instagram no entregó el token");

    // El token corto dura una hora; sin cambiarlo por el largo habría que reconectar cada rato.
    const rl = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(igAppSecret())}&access_token=${encodeURIComponent(corto.access_token)}`);
    const largo = await rl.json();
    const token = largo?.access_token || corto.access_token;

    // Se comprueba que el token SIRVA antes de guardarlo. Antes se aceptaba el user_id del
    // intercambio como respaldo y la conexión quedaba marcada como buena aunque Meta emitiera
    // un token inerte —lo que pasa cuando la cuenta no tiene el rol de tester y la app aún no
    // está aprobada—. El portal decía "conectado" y no funcionaba nada: peor que fallar.
    // La ruta documentada de Instagram Login es sin versión.
    const rm = await fetch(`${IG_API}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
    const meTxt = await rm.text();
    let me = {}; try { me = JSON.parse(meTxt); } catch { /* se maneja abajo */ }
    // El id se saca del TEXTO, no del JSON ya convertido. Meta lo manda como número de 17
    // cifras y eso pasa del entero seguro de JavaScript: al parsearlo se redondea y queda un
    // id que no existe. Guardamos 28135170359435772 donde Instagram decía ...773, y por eso
    // fallaba cada llamada. No se ve en ninguna traza: el número simplemente cambia solo.
    const igId = (meTxt.match(/"user_id"\s*:\s*"?(\d+)"?/) || [])[1] || "";
    if (!rm.ok || !igId) {
      const detalle = me?.error?.message || `Instagram respondió ${rm.status}`;
      console.error("IG callback, /me falló:", meTxt.slice(0, 300));
      return fin(false, `Instagram entregó el permiso pero no deja consultar la cuenta (${detalle}). Suele ser que a la cuenta le falta el rol de evaluador en la app, o que la app aún no tiene acceso avanzado aprobado.`);
    }

    await saveIG(s => {
      // Una cuenta de Instagram pertenece a UNA empresa. Si estaba enganchada a otra —basta con
      // haberla conectado una vez con otra seleccionada— se suelta de allí antes de guardarla
      // aquí. Sin esto quedaban dos empresas apuntando al mismo igId, y el webhook resolvía por
      // orden de inserción: entregaba a la primera, que podía no tener ninguna regla, y la
      // automatización no respondía nunca sin dar un solo error.
      for (const [cid, c] of Object.entries(s.cuentas)) {
        if (cid !== String(st.cid) && String(c.igId) === String(igId)) {
          console.log(`IG: @${me?.username || igId} estaba en la empresa ${cid}; se suelta y pasa a la ${st.cid}`);
          // Las reglas de la empresa vieja se mudan con la cuenta, salvo que la nueva ya tenga las
          // suyas (no se pisan). Dejarlas atrás las volvía inalcanzables: el webhook solo recorre
          // empresas presentes en `cuentas`, así que quedaban visibles y "activas" en pantalla
          // pero muertas — justo el fallo silencioso que este soltado pretende evitar.
          if ((s.reglas[cid] || []).length && !(s.reglas[String(st.cid)] || []).length) {
            s.reglas[String(st.cid)] = s.reglas[cid];
            console.log(`IG: ${s.reglas[cid].length} regla(s) mudadas de la empresa ${cid} a la ${st.cid}`);
          }
          delete s.reglas[cid];
          delete s.cuentas[cid];
        }
      }
      s.cuentas[st.cid] = {
        igId, username: me?.username || "", token,
        expira: Date.now() + ((largo?.expires_in || 5184000) * 1000),
        conectadaEl: new Date().toISOString(),
      };
      return s;
    });

    // Suscribir ESTA cuenta a los webhooks. Estar suscrito al campo `comments` en el panel de
    // Meta no alcanza: eso declara qué campos quiere la app, pero cada cuenta autorizada tiene
    // que activarse aparte. Sin esto el OAuth funciona, la publicación funciona, y los
    // comentarios sencillamente no llegan nunca — un fallo mudo y muy caro de diagnosticar.
    try {
      const rs = await fetch(`${IG_API}/${encodeURIComponent(igId)}/subscribed_apps?subscribed_fields=comments&access_token=${encodeURIComponent(token)}`, { method: "POST" });
      const sd = await rs.json().catch(() => ({}));
      console.log(`IG: suscripción de @${me?.username || igId} a comments -> ${rs.status} ${JSON.stringify(sd)}`);
    } catch (e) { console.error("IG subscribed_apps:", e.message); }

    // Aviso al equipo. Quien autoriza es el cliente, desde su portal y en su propio teléfono:
    // sin esto nadie de Inmersia se entera de que esa cuenta ya está disponible, y la
    // automatización se queda sin montar hasta que a alguien se le ocurra ir a mirar.
    // Va después de suscribir los webhooks a propósito: antes de eso la cuenta está autorizada
    // pero todavía no llegan los comentarios, así que avisar ahí sería avisar de más.
    try {
      const empresas = (await sbGet("companies", [])) || [];
      const emp = empresas.find(c => String(c.id) === String(st.cid));
      await crearNotif({
        type: "contenido",
        title: "📸 Instagram conectado",
        body: `${emp?.name || "Un cliente"} autorizó @${me?.username || igId}. Ya se pueden crear automatizaciones sobre sus publicaciones.`,
        to: correosDe(TEAM.filter(u => u.role === "admin")),
        url: "/", important: true,
        dedupKey: "igconn_" + st.cid + "_" + igId,
      });
    } catch (e) { console.error("IG aviso de conexión:", e.message); }

    fin(true, `@${me?.username || igId} conectada`);
  } catch (e) { fin(false, e.message); }
});

// Las publicaciones reales de la cuenta, para poder elegir en cuál se aplica la automatización.
app.get("/api/ig/publicaciones", requireAuth, async (req, res) => {
  const cid = String(req.query.companyId || "");
  const c = await igToken(cid);
  if (!c?.token) return res.status(409).json({ error: "no_conectada" });
  try {
    const r = await fetch(`${IG_API}/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count&limit=30&access_token=${encodeURIComponent(c.token)}`);
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: d?.error?.message || `Instagram respondió ${r.status}` });
    res.json({
      publicaciones: (d.data || []).map(m => ({
        id: m.id,
        // El pie completo no cabe en un selector y tampoco hace falta para reconocer el post.
        titulo: String(m.caption || "").split("\n")[0].slice(0, 80) || "(sin texto)",
        // Los reels no traen media_url utilizable como imagen; para esos vale la miniatura.
        img: m.thumbnail_url || m.media_url || null,
        tipo: m.media_type, permalink: m.permalink, fecha: m.timestamp,
        comentarios: m.comments_count ?? null,
      })),
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Reglas: palabra que dispara → mensaje que se manda ──
app.get("/api/ig/reglas", requireAuth, async (req, res) => {
  const s = await loadIG();
  res.json({ reglas: s.reglas[String(req.query.companyId || "")] || [] });
});
app.put("/api/ig/reglas", requireAuth, async (req, res) => {
  const { companyId, reglas } = req.body || {};
  if (!companyId) return res.status(400).json({ error: "companyId requerido" });
  if (!Array.isArray(reglas)) return res.status(400).json({ error: "reglas debe ser una lista" });
  const limpias = reglas.slice(0, 20).map(r => {
    const TIPOS = ["mensaje", "condicion", "retraso", "accion"];
    const pasos = (Array.isArray(r.pasos) ? r.pasos : []).slice(0, 20).map(p => ({
      id: String(p.id || crypto.randomBytes(3).toString("hex")),
      tipo: TIPOS.includes(p.tipo) ? p.tipo : "mensaje",
      titulo: String(p.titulo || "").trim().slice(0, 60),
      // Retraso y acción tienen una sola salida; el mensaje sale por sus botones y la
      // condición por sus dos ramas.
      siguiente: String(p.siguiente || "").trim(),
      // Tope de 30 días. Más allá la ventana de 24 h ya se cerró hace mucho y el envío
      // fallaría igual, así que no tiene sentido permitirlo.
      minutos: Math.max(1, Math.min(43200, Number(p.minutos) || 60)),
      // 640 es el tope de Instagram para el texto de una plantilla con botones.
      texto: String(p.texto || "").trim().slice(0, 640),
      botones: (Array.isArray(p.botones) ? p.botones : []).slice(0, 3).map(b => {
        // Un botón hace una de dos cosas: sigue la cadena, o abre un enlace. El enlace se
        // filtra por esquema a propósito — aquí entra texto que acaba dentro de un mensaje
        // que Instagram manda en nuestro nombre, y `javascript:` o `data:` no pintan nada.
        const url = String(b.url || "").trim().slice(0, 1000);
        return {
          id: String(b.id || crypto.randomBytes(3).toString("hex")),
          // 20 caracteres: más allá Instagram lo corta y queda un botón ilegible.
          titulo: String(b.titulo || "").trim().slice(0, 20),
          siguiente: String(b.siguiente || "").trim(),
          url: /^https?:\/\/\S+$/i.test(url) ? url : "",
          // Cuál de las dos cosas quiere ser, guardado aparte de si ya está relleno. Deducirlo
          // de que haya URL hacía que un botón de enlace a medio configurar volviera a aparecer
          // como botón de bloque al reabrir la cadena, y no había forma de distinguir "todavía
          // no pegué el enlace" de "esto nunca fue un enlace".
          modo: b.modo === "enlace" ? "enlace" : "bloque",
        };
      }).filter(b => b.titulo),
      siSi: String(p.siSi || "").trim(),
      siNo: String(p.siNo || "").trim(),
      // Qué comprueba una condición, y sus parámetros.
      que: ["sigue", "respondio", "seguidores", "verificado"].includes(p.que) ? p.que : "sigue",
      esperaMin: Math.max(0, Math.min(43200, Number(p.esperaMin) || 0)),
      minSeguidores: Math.max(0, Math.min(100000000, Number(p.minSeguidores) || 0)),
      // La posición en el lienzo es del constructor, pero se guarda con el paso: si no, cada
      // vez que se abriera la cadena los bloques saltarían a otro sitio y no se reconocería.
      x: Number.isFinite(+p.x) ? Math.round(+p.x) : 0,
      y: Number.isFinite(+p.y) ? Math.round(+p.y) : 0,
      // Un mensaje sin texto no se puede enviar; los demás tipos sí valen vacíos.
    })).filter(p => p.tipo !== "mensaje" || p.texto);
    const ids = new Set(pasos.map(p => p.id));
    return {
      id: String(r.id || crypto.randomBytes(4).toString("hex")),
      nombre: String(r.nombre || "").trim().slice(0, 60),
      // Vacío = la regla vale para toda la cuenta. Es lo que quieres para algo permanente
      // ("info" siempre responde); una publicación concreta es para campañas puntuales.
      mediaId: String(r.mediaId || "").trim(),
      palabra: String(r.palabra || "").trim().slice(0, 40),
      // Por dónde empieza la cadena. En un grafo el primero de la lista no tiene por qué ser
      // el de arriba, así que se guarda explícito; si apunta a un paso borrado, vale el primero.
      inicio: ids.has(String(r.inicio || "")) ? String(r.inicio) : (pasos[0]?.id || ""),
      pasos,
      activa: r.activa !== false,
      // El vínculo con la pieza y la marca de "esperando publicación" TIENEN que sobrevivir al
      // guardado. Sin esto, cada vez que se abría y guardaba la lista de reglas se perdían: la
      // cadena preparada dejaba de estar `pendienteMedia` (→ el webhook la disparaba como comodín
      // sobre cualquier post, antes de publicar) y `igArmarPendientes` —que exige taskId+pendiente—
      // nunca la armaba. Solo se añaden si la regla está ligada a una pieza; una regla normal
      // (permanente, sin taskId) no los lleva. `pendienteMedia` se conserva como false solo si ya
      // se armó explícitamente; ante la duda queda en espera, nunca comodín.
      ...(r.taskId ? { taskId: String(r.taskId), pendienteMedia: r.pendienteMedia !== false, ...(r.expirada ? { expirada: true } : {}) } : {}),
    };
  }).filter(r => r.palabra && r.pasos.length);
  const s = await saveIG(s2 => { s2.reglas[String(companyId)] = limpias; return s2; });
  res.json({ ok: true, reglas: s.reglas[String(companyId)] });
});

// ── Webhook ──
// Meta valida el endpoint con un GET antes de mandar nada.
app.get("/api/ig/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === igVerifyToken() && igVerifyToken())
    return res.status(200).send(String(req.query["hub.challenge"] || ""));
  res.sendStatus(403);
});

// Sin acentos y en minúsculas: "explora" tiene que disparar aunque escriban "EXPLORA" o
// "Exploro" con tilde. Comparar en crudo dejaría fuera media Latinoamérica.
const igNorm = t => String(t || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

// ── Motor de cadenas ──
// El estado NO se guarda por persona. El identificador del paso siguiente viaja dentro del
// `payload` del botón, así que cuando alguien lo pulsa el mensaje ya trae escrito adónde ir.
// Guardar el punto de cada conversación obligaría a limpiar sesiones colgadas para siempre.
const igPayload = (flujoId, pasoId) => `f:${flujoId}:${pasoId}`;
function igLeerPayload(p) {
  const m = String(p || "").match(/^f:([^:]+):(.+)$/);
  return m ? { flujoId: m[1], pasoId: m[2] } : null;
}

async function igEnviar(cuenta, destinatario, mensaje) {
  const r = await fetch(`${IG_API}/${encodeURIComponent(cuenta.igId)}/messages?access_token=${encodeURIComponent(cuenta.token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: destinatario, message: mensaje }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Meta respondió ${r.status}`);
  return d;
}

// Todo lo que Meta deja saber de quien escribe. Se pide de una vez: son los mismos permisos
// y una sola llamada sirve para cualquiera de las condiciones.
async function igPerfil(cuenta, igsid) {
  const campos = "username,follower_count,is_verified_user,is_user_follow_business,is_business_follow_user";
  const r = await fetch(`${IG_API}/${encodeURIComponent(igsid)}?fields=${campos}&access_token=${encodeURIComponent(cuenta.token)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Meta respondió ${r.status}`);
  return d;
}

// Cuándo escribió por última vez cada persona, y cuándo le escribimos nosotros. Con esas dos
// fechas se resuelve "¿respondió?" sin preguntarle nada a Instagram.
const igContacto = (s, igsid) => (s.contactos || {})[String(igsid)] || {};
const igMarcar = (igsid, campo) => saveIG(s => {
  s.contactos = s.contactos || {};
  const c = s.contactos[String(igsid)] || {};
  s.contactos[String(igsid)] = { ...c, [campo]: Date.now() };
  // Se conservan los 2000 contactos más recientes: sin tope, esta clave crecería sin fin.
  const ids = Object.keys(s.contactos);
  if (ids.length > 2000) {
    const vivos = ids.sort((a, b) => (s.contactos[b].respondio || s.contactos[b].enviado || 0) - (s.contactos[a].respondio || s.contactos[a].enviado || 0)).slice(0, 2000);
    const nuevo = {}; for (const id of vivos) nuevo[id] = s.contactos[id];
    s.contactos = nuevo;
  }
  return s;
});

// Evalúa la condición del paso. Devuelve true/false, o lanza si no se puede comprobar.
async function igEvaluar(cuenta, paso, igsid) {
  const que = paso.que || "sigue";
  if (que === "respondio") {
    const s = await loadIG();
    const c = igContacto(s, igsid);
    // Responder es haber escrito DESPUÉS de nuestro último mensaje. Comparar contra "hace
    // X horas" a secas daría por respondido a quien escribió antes de que le escribiéramos.
    return !!(c.respondio && c.enviado && c.respondio > c.enviado);
  }
  const p = await igPerfil(cuenta, igsid);
  if (que === "seguidores") return Number(p.follower_count || 0) >= Math.max(0, Number(paso.minSeguidores) || 0);
  if (que === "verificado") return !!p.is_verified_user;
  return !!p.is_user_follow_business;
}

// Las reglas viejas tenían un solo `mensaje`. Se leen como una cadena de un paso para no
// romper lo que ya estaba configurado ni obligar a migrar la base a mano.
function igPasosDe(flujo) {
  if (Array.isArray(flujo.pasos) && flujo.pasos.length) return flujo.pasos;
  return flujo.mensaje ? [{ id: "p1", tipo: "mensaje", texto: flujo.mensaje, botones: [] }] : [];
}

// Ejecuta un paso y, si es una condición, salta al que corresponda. La profundidad frena los
// bucles: dos condiciones que se apunten entre sí colgarían el proceso para siempre.
async function igEjecutarPaso(companyId, cuenta, flujo, pasoId, destinatario, igsid, prof = 0, opts = {}) {
  if (prof > 8) { console.error("IG: cadena demasiado profunda, se corta"); return; }
  const pasos = igPasosDe(flujo);
  const paso = pasos.find(p => String(p.id) === String(pasoId)) || pasos[0];
  if (!paso) return;

  if (paso.tipo === "condicion") {
    // "No respondió en 3 horas" es una condición que hay que evaluar MÁS TARDE, no ahora.
    // La condición se agenda a sí misma y al volver ya no espera (`sinEspera`), o se quedaría
    // reprogramándose para siempre.
    const espera = Math.max(0, Number(paso.esperaMin) || 0);
    if (espera > 0 && !opts.sinEspera) {
      await saveIG(s => {
        s.pendientes = [...(s.pendientes || []), {
          cuando: Date.now() + espera * 60000, companyId: String(companyId),
          flujoId: String(flujo.id), pasoId: String(paso.id), igsid: String(igsid), sinEspera: true,
        }].slice(-500);
        return s;
      });
      return;
    }
    let cumple = false;
    try { cumple = await igEvaluar(cuenta, paso, igsid); }
    catch (e) {
      // Si no se puede comprobar, se va por la rama del "no". Estas condiciones existen para
      // condicionar algo —un beneficio, un descuento— a un requisito: dar por bueno un "sí"
      // que no se pudo verificar lo regalaría ante cualquier fallo de red. La rama del "no"
      // normalmente ofrece reintentar, así que la persona tampoco queda colgada.
      console.error("IG condición:", e.message); cumple = false;
    }
    const sig = cumple ? paso.siSi : paso.siNo;
    if (sig) return igEjecutarPaso(companyId, cuenta, flujo, sig, destinatario, igsid, prof + 1, opts);
    return;
  }

  // Espera y continúa después. No sirve un setTimeout: Render duerme el proceso y el plan
  // gratuito se reinicia, así que la espera se guarda y la retoma el repaso de cada 10 min.
  // Eso hace que la granularidad real sea de 10 minutos, no de segundos.
  if (paso.tipo === "retraso") {
    if (!paso.siguiente) return;
    const min = Math.max(1, Math.min(43200, Number(paso.minutos) || 60));
    await saveIG(s => {
      s.pendientes = [...(s.pendientes || []), {
        cuando: Date.now() + min * 60000,
        companyId: String(companyId), flujoId: String(flujo.id), pasoId: String(paso.siguiente), igsid: String(igsid),
      }].slice(-500);   // tope de seguridad por si algo se desboca
      return s;
    });
    return;
  }

  // Aviso interno al equipo. No sale nada hacia Instagram.
  if (paso.tipo === "accion") {
    const texto = String(paso.texto || "").trim();
    if (texto) {
      await crearNotif({
        type: "contenido", title: "⚡ Automatización de Instagram",
        body: texto, to: [], url: "/",
        dedupKey: "igacc_" + flujo.id + "_" + paso.id + "_" + igsid,
      }).catch(e => console.error("IG acción:", e.message));
    }
    if (paso.siguiente) return igEjecutarPaso(companyId, cuenta, flujo, paso.siguiente, destinatario, igsid, prof + 1, opts);
    return;
  }

  const texto = String(paso.texto || "").slice(0, 640);
  if (!texto) return;
  // Dos clases de botón. El de enlace (`web_url`) abre una web y NO continúa la cadena: al
  // pulsarlo Instagram no nos manda nada, así que después de un enlace el hilo se corta —si hace
  // falta seguir, se acompaña de un retraso o de otro botón. El de siempre (`postback`) es el
  // que trae de vuelta a qué paso ir.
  const botones = (paso.botones || [])
    .filter(b => b.titulo && (b.url || b.siguiente))
    .slice(0, 3)   // Instagram admite 3 como mucho
    .map(b => b.url
      ? ({ type: "web_url", title: String(b.titulo).slice(0, 20), url: b.url })
      : ({ type: "postback", title: String(b.titulo).slice(0, 20), payload: igPayload(flujo.id, b.siguiente) }));

  const mensaje = botones.length
    ? { attachment: { type: "template", payload: { template_type: "button", text: texto, buttons: botones } } }
    : { text: texto };
  await igEnviar(cuenta, destinatario, mensaje);
  // Marca que YA salió al menos un mensaje de esta cadena. Lo comparte todo el recorrido (opts se
  // pasa en cada recursión), y quien arrancó la cadena lo mira para decidir si puede reintentar:
  // si el primer mensaje ya se entregó, reintentar mandaría un segundo y Instagram lo rechaza.
  if (opts && typeof opts === "object") opts.enviado = true;
  // Se anota para poder resolver después "¿respondió?": responder es escribir DESPUÉS de esto.
  await igMarcar(igsid, "enviado");

  // Un mensaje puede seguir solo, sin esperar a que pulsen nada. Hasta ahora la única salida de
  // un mensaje eran sus botones, y eso dejaba sin construir lo más pedido: entregar algo y
  // hacer seguimiento un rato después. Con un botón de enlace era imposible —Instagram no nos
  // avisa de ese toque—, así que el hilo se cortaba justo donde tenía que continuar.
  //
  // Se continúa SIEMPRE por DM, nunca por la respuesta al comentario: esa se gasta con el
  // primer mensaje y un segundo intento por ahí lo rechaza Instagram.
  if (paso.siguiente) return igEjecutarPaso(companyId, cuenta, flujo, paso.siguiente, { id: igsid }, igsid, prof + 1, opts);
}

async function igProcesarComentario(entry) {
  const igId = String(entry?.id || "");
  for (const ch of (entry?.changes || [])) {
    if (ch.field !== "comments") continue;
    const v = ch.value || {};
    const commentId = String(v.id || "");
    const texto = String(v.text || "");
    const autor = String(v.from?.id || "");
    if (!commentId || !texto) continue;
    // Nunca responder a los propios comentarios de la marca: se haría un bucle.
    if (autor && autor === igId) continue;

    const s = await loadIG();
    const mediaId = String(v.media?.id || v.media_id || "");
    // Antes, cada uno de los descartes de aquí abajo era un `continue` mudo: el webhook llegaba,
    // no pasaba nada, y desde fuera era idéntico a que Meta no hubiera entregado nada. Tres
    // causas distintas con el mismo síntoma y ninguna forma de distinguirlas. Ahora cada una
    // dice lo suyo y con qué valores, que es lo único que permite arreglarla.
    console.log(`IG webhook: comentario ${commentId} en cuenta ${igId}, publicación ${mediaId || "(sin id)"}, texto "${texto.slice(0, 60)}"`);

    // TODAS las empresas que tengan esta cuenta, no la primera que aparezca. Una misma cuenta
    // de Instagram puede haber quedado enganchada a dos empresas —basta con haberla conectado
    // una vez con otra seleccionada—, y quedarse con la primera del objeto significaba elegir
    // por orden de inserción: el webhook llegaba bien, encontraba la empresa equivocada, veía
    // que no tenía reglas y lo tiraba. La cadena estaba impecable en la otra.
    const pares = Object.entries(s.cuentas).filter(([, c]) => String(c.igId) === igId);
    if (!pares.length) {
      console.error(`IG: nadie tiene la cuenta ${igId}. Guardadas: ${Object.entries(s.cuentas).map(([e, c]) => e + "=" + c.igId).join(", ") || "ninguna"}`);
      continue;
    }

    // Meta reintenta la entrega del webhook. Sin esta guarda, el mismo comentario dispararía
    // el mensaje dos veces —y Meta solo admite uno, así que el segundo sería un error feo.
    if (s.respondidos[commentId]) { console.log(`IG: el comentario ${commentId} ya se respondió el ${s.respondidos[commentId]}`); continue; }

    // Se recogen las reglas que encajan en TODAS las empresas que tienen la cuenta y solo
    // después se elige, para que la especificidad mande por encima del orden de las empresas: una
    // regla atada a esta publicación gana sobre una general, esté en la empresa que esté. Al
    // elegir empresa por empresa y cortar en la primera con match, una cadena general de una
    // conexión vieja (o a medio configurar) tapaba la campaña real de la otra empresa.
    let companyId = null, cuenta = null, regla = null;
    const rastro = [];
    const candidatas = [];   // { cid, c, r }
    for (const [cid, c] of pares) {
      const activas = (s.reglas[cid] || []).filter(r => r.activa);
      // Una regla SIN palabra encaja con TODO comentario (`"x".includes("")===true`): es un
      // comodín que se traga cada comentario y quema el único mensaje permitido, dejando a la
      // regla real sin poder disparar. Una cadena recién creada o un preset sin la palabra
      // escrita cae aquí, así que se descartan.
      // `pendienteMedia`: cadena preparada para una pieza que TODAVÍA no se publica. Se ignora
      // hasta que el motor de armado (repasoCorto) le ponga el mediaId real al publicarse; si no,
      // dispararía como cadena general sobre cualquier post desde que se deja lista.
      const enc = activas.filter(r => !r.pendienteMedia && igNorm(r.palabra) && igNorm(texto).includes(igNorm(r.palabra)));
      enc.forEach(r => candidatas.push({ cid, c, r }));
      if (!enc.length) rastro.push(`empresa ${cid}: ninguna palabra encaja (activas: ${activas.map(x => JSON.stringify(x.palabra)).join(", ") || "ninguna"})`);
    }
    // Especificidad global: primero una regla de ESTA publicación, luego una general.
    const elegido = candidatas.find(x => x.r.mediaId && x.r.mediaId === mediaId) || candidatas.find(x => !x.r.mediaId);
    if (elegido) { companyId = elegido.cid; cuenta = elegido.c; regla = elegido.r; }
    else if (candidatas.length) {
      // La palabra encaja pero la publicación no: el caso silencioso más traicionero, porque en
      // pantalla la cadena se ve perfecta y atada al post correcto.
      rastro.push(`la palabra encaja en ${candidatas.length} regla(s) pero ninguna es de esta publicación (el webhook trae ${mediaId || "(sin id)"}, las reglas apuntan a ${candidatas.map(x => x.r.mediaId || "(todas)").join(", ")})`);
    }
    if (!regla) {
      console.error(`IG: ningún patrón encaja con "${texto.slice(0, 40)}". ${rastro.join(" · ")}`);
      continue;
    }
    if (pares.length > 1) console.log(`IG: la cuenta ${igId} está en ${pares.length} empresas; responde la ${companyId}`);

    await saveIG(s2 => {
      s2.respondidos[commentId] = new Date().toISOString();
      // Se podan los de más de 7 días. Esa es la ventana en la que Instagram deja contestar a
      // un comentario: pasada, el id ya no puede volver a dispararse, así que guardarlo no
      // protege de nada. Sus dos vecinos en esta fila ya tienen tope —`contactos` 2000,
      // `pendientes` 500— y esta se leía entera en cada webhook mientras crecía para siempre.
      const limite = Date.now() - 7 * 24 * 3600000;
      for (const [id, cuando] of Object.entries(s2.respondidos)) {
        const t = Date.parse(cuando);
        if (Number.isFinite(t) && t < limite) delete s2.respondidos[id];
      }
      return s2;
    });
    const traza = { enviado: false };
    try {
      // El primer paso va por respuesta privada al comentario: es el único mensaje que
      // Instagram deja mandar a alguien que no te ha escrito. De ahí en adelante manda el
      // botón, que al pulsarse abre la ventana de 24 h y permite seguir la conversación.
      const pasos = igPasosDe(regla);
      await igEjecutarPaso(companyId, cuenta, regla, regla.inicio || pasos[0]?.id, { comment_id: commentId }, autor, 0, traza);
      console.log(`IG: cadena "${regla.palabra}" iniciada con quien comentó ${commentId}`);
    } catch (e) {
      console.error("IG respuesta privada:", e.message);
      // Solo se libera si NO llegó a salir ningún mensaje (p.ej. un fallo de red en el primero):
      // ahí reintentar es seguro. Si el primer mensaje YA se entregó y falló un paso posterior,
      // liberar sería fatal: en el reintento se mandaría una segunda respuesta privada al mismo
      // comentario y Instagram solo admite una, así que el reintento fallaría siempre.
      if (!traza.enviado) await saveIG(s2 => { delete s2.respondidos[commentId]; return s2; });
      else console.error(`IG: la cadena de ${commentId} falló DESPUÉS del primer envío; no se libera para no duplicar la respuesta privada.`);
    }
  }
}

// Alguien pulsó un botón. El paso al que hay que ir viene escrito en el propio payload, así
// que no hace falta recordar en qué punto de la cadena estaba esta persona.
async function igProcesarPostback(entry, m) {
  const igId = String(entry?.id || m?.recipient?.id || "");
  const igsid = String(m?.sender?.id || "");
  if (!igsid) return;
  // El eco de nuestros propios mensajes también llega aquí; ignorarlo evita responderse solo.
  if (igsid === igId || m?.message?.is_echo) return;

  // Cualquier mensaje entrante cuenta como respuesta, lleve botón o no. Es lo que resuelve
  // la condición "¿respondió?" sin tener que preguntarle nada a Instagram.
  if (m?.message) await igMarcar(igsid, "respondio");

  const payload = m?.postback?.payload || m?.message?.quick_reply?.payload;
  if (!payload) return;
  const ref = igLeerPayload(payload);
  if (!ref) return;

  const s = await loadIG();
  // Igual que con los comentarios: se miran todas las empresas que tengan esta cuenta y se
  // elige la que de verdad conoce esta cadena. El id del flujo viene en el propio botón, así
  // que aquí no hay que adivinar nada — solo no quedarse con la primera por costumbre. Con la
  // cuenta enganchada a dos empresas, el primer mensaje salía y la cadena moría al pulsar.
  const pares = Object.entries(s.cuentas).filter(([, c]) => String(c.igId) === igId);
  if (!pares.length) { console.error(`IG postback: nadie tiene la cuenta ${igId}`); return; }

  let companyId = null, cuenta = null, flujo = null;
  for (const [cid, c] of pares) {
    // Se ignoran las cadenas pendienteMedia: no han enviado nada, así que ningún botón puede
    // referenciarlas; y si por lo que fuera llegara, no deben responder hasta estar armadas.
    const f = (s.reglas[cid] || []).find(r => String(r.id) === ref.flujoId && !r.pendienteMedia);
    if (f) { companyId = cid; cuenta = c; flujo = f; break; }
  }
  if (!flujo) { console.error(`IG postback: la cadena ${ref.flujoId} no está en ninguna empresa con la cuenta ${igId}`); return; }
  if (flujo.activa === false) { console.log(`IG postback: la cadena "${flujo.palabra}" está pausada`); return; }

  try {
    // Ya hay conversación abierta: a partir de aquí se escribe a la persona, no al comentario.
    await igEjecutarPaso(companyId, cuenta, flujo, ref.pasoId, { id: igsid }, igsid);
    console.log(`IG: paso ${ref.pasoId} de "${flujo.palabra}" enviado a ${igsid}`);
  } catch (e) { console.error("IG postback:", e.message); }
}

// Retoma las esperas cumplidas. La llama `repasoCorto` cada 10 minutos.
async function igProcesarPendientes() {
  const s = await loadIG();
  const cola = s.pendientes || [];
  if (!cola.length) return;
  const ahora = Date.now();
  const toca = cola.filter(p => p.cuando <= ahora);
  if (!toca.length) return;
  // Se sacan de la cola ANTES de ejecutar: si el envío falla, reintentarlo cada 10 minutos
  // para siempre sería peor que perderlo.
  await saveIG(s2 => { s2.pendientes = (s2.pendientes || []).filter(p => p.cuando > ahora); return s2; });

  for (const p of toca) {
    const cuenta = s.cuentas[p.companyId];
    const flujo = (s.reglas[p.companyId] || []).find(f => String(f.id) === String(p.flujoId));
    if (!cuenta || !flujo || flujo.activa === false) continue;
    try {
      await igEjecutarPaso(p.companyId, cuenta, flujo, p.pasoId, { id: p.igsid }, p.igsid, 0, { sinEspera: !!p.sinEspera });
      console.log(`IG: espera cumplida, paso ${p.pasoId} enviado a ${p.igsid}`);
    } catch (e) {
      // Lo normal aquí es "outside of allowed window": la ventana de 24 h se cerró durante la
      // espera. No es un fallo del código y no tiene arreglo por nuestra parte.
      console.error("IG pendiente:", e.message);
    }
  }
}

// ── Auto-armado de automatizaciones al publicarse la pieza ────────────────────
// Una cadena marcada `pendienteMedia` está atada a una pieza (taskId) pero todavía no tiene el
// mediaId real de Instagram, porque ese id solo existe DESPUÉS de publicar. Este repaso (cada 10
// min) mira las cadenas en esa espera: si su pieza ya se publicó, busca el post recién salido en
// la cuenta (me/media, la misma API que usa el webhook), le pega el mediaId a la cadena y la
// suelta (`pendienteMedia:false`). A partir de ahí el webhook ya la reconoce y responde. Así la
// cadena se deja lista hoy y se enciende sola cuando el reel salga —aunque sea en 3 días—, sin que
// nadie tenga que volver a tocar nada. Reusa el motor de 10 minutos porque Render duerme el plan
// gratuito y no sirve un temporizador.
async function igArmarPendientes() {
  const s = await loadIG();
  const pend = [];
  for (const [cid, rules] of Object.entries(s.reglas || {})) {
    for (const r of (rules || [])) if (r.pendienteMedia && r.taskId && !r.expirada) pend.push({ cid, reglaId: r.id, taskId: r.taskId });
  }
  if (!pend.length) return;
  const tasks = (await sbGet("tasks", [])) || [];
  const ahora = Date.now();
  const armados = [];   // { cid, reglaId, taskId, mediaId, task }
  // Medias ya asignados EN ESTA corrida, por cuenta: si dos piezas de la misma cuenta se
  // publican a la vez, sin esto ambas cadenas podrían casar el mismo post (el estado de reglas
  // se leyó una vez al inicio y no refleja lo recién armado aquí).
  const usadosRun = {};

  for (const p of pend) {
    const task = tasks.find(t => String(t.id) === String(p.taskId));
    if (!task) continue;
    // ¿Ya se publicó? Publicada de inmediato → estado "publicado". Programada → cuando su hora ya
    // pasó (Zernio la publica sola a esa hora; aquí solo se detecta). Si no, todavía no toca.
    const programada = task.socialPost?.programadaPara ? Date.parse(task.socialPost.programadaPara) : null;
    const yaPublicada = task.state === "publicado" || (Number.isFinite(programada) && programada <= ahora);
    if (!yaPublicada) continue;
    // Se rinde tras 3 días desde la publicación prevista: si el media nunca apareció (Zernio no
    // publicó, o se canceló), no tiene sentido golpear la API cada 10 min para siempre. Se avisa
    // una vez a los admins (crearNotif deduplica) y se deja de reintentar; la cadena queda visible
    // como pendiente para que el equipo la revise o la rearme.
    const refPub = Number.isFinite(programada) ? programada : (Date.parse(task.socialPost?.at || "") || 0);
    if (refPub && ahora - refPub > 3 * 24 * 3600000) {
      await crearNotif({
        type: "contenido", title: "⚠️ Automatización sin publicación",
        body: `«${task.title || "Una pieza"}» tenía una automatización lista pero su publicación no apareció en 3 días. Revisa si de verdad se publicó, o vuelve a prepararla.`,
        to: correosDe(TEAM.filter(u => u.role === "admin")), url: "/", important: true,
        dedupKey: "autostuck_" + p.taskId,
      }).catch(e => console.error("IG armar stuck:", e.message));
      // Se marca `expirada` para que deje de re-entrar a la cola en cada repaso: sin esto seguía en
      // `pend` y, al vencer el dedup de 12 h, el mismo aviso se reenviaba a los admins para siempre.
      // Se conserva `pendienteMedia:true` a propósito —así el webhook la sigue ignorando (nunca tuvo
      // mediaId)— y queda visible como pendiente por si el equipo quiere rearmarla.
      await saveIG(s2 => {
        const rr = (s2.reglas[p.cid] || []).find(x => String(x.id) === String(p.reglaId));
        if (rr) rr.expirada = true;
        return s2;
      }).catch(e => console.error("IG armar marcar expirada:", e.message));
      continue;
    }
    const cuenta = s.cuentas[p.cid];
    if (!cuenta?.token) continue;

    let media = null;
    try {
      const r = await fetch(`${IG_API}/me/media?fields=id,caption,media_type,timestamp&limit=15&access_token=${encodeURIComponent(cuenta.token)}`);
      const d = await r.json();
      if (!r.ok) { console.error(`IG armar: /me/media falló para empresa ${p.cid}:`, d?.error?.message || r.status); continue; }
      // No reusar un media que ya esté armado en otra cadena de esta cuenta —ni uno recién
      // asignado en esta misma corrida (usadosRun).
      const yaUsados = new Set([...(s.reglas[p.cid] || []).map(x => x.mediaId).filter(Boolean), ...(usadosRun[p.cid] || [])]);
      // Ventana desde la que buscar: la hora programada (menos 1 h de margen) o, si fue inmediata,
      // cuando se marcó publicada. Evita casar un post viejo.
      const desde = Number.isFinite(programada) ? programada - 3600000
        : (Date.parse(task.socialPost?.at || "") || (ahora - 24 * 3600000));
      const esReel = task.type === "reel";
      const cands = (d.data || [])
        .filter(m => !yaUsados.has(m.id))
        // Un reel sale como VIDEO; un post es IMAGE o CAROUSEL_ALBUM. Se excluye el tipo contrario
        // para que una cadena de post no se arme al reel que salió a la misma hora (ni al revés).
        .filter(m => esReel ? m.media_type === "VIDEO" : m.media_type !== "VIDEO")
        .filter(m => { const t = Date.parse(m.timestamp); return Number.isFinite(t) && t >= desde; })
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      // Si la pieza tiene pie escrito, se prefiere el post cuyo caption coincide; si no, el más
      // reciente dentro de la ventana.
      const cap = String(task.caption || "").trim().slice(0, 60);
      media = (cap && cands.find(m => String(m.caption || "").trim().slice(0, 60) === cap)) || cands[0] || null;
    } catch (e) { console.error("IG armar (me/media):", e.message); continue; }
    if (!media) { console.log(`IG armar: la pieza ${p.taskId} figura publicada pero aún no aparece su media en la cuenta; se reintenta.`); continue; }
    (usadosRun[p.cid] = usadosRun[p.cid] || []).push(media.id);

    await saveIG(s2 => {
      const rr = (s2.reglas[p.cid] || []).find(x => String(x.id) === String(p.reglaId));
      if (rr) { rr.mediaId = media.id; rr.pendienteMedia = false; }
      return s2;
    });
    console.log(`IG armar: cadena ${p.reglaId} atada al media ${media.id} (pieza «${task.title || p.taskId}»)`);
    armados.push({ ...p, mediaId: media.id, task });
  }

  if (!armados.length) return;
  // Marcar las piezas como publicadas + "armada" y avisar al equipo y al cliente. Se relee justo
  // antes de escribir para pisar lo menos posible lo que otros hayan tocado mientras tanto.
  const fresh = (await sbGet("tasks", [])) || [];
  const map = new Map(armados.map(a => [String(a.taskId), a]));
  const next = fresh.map(t => map.has(String(t.id))
    ? { ...t, state: "publicado", autoEstado: "armada", socialPost: { ...(t.socialPost || {}), at: t.socialPost?.at || new Date().toISOString(), mediaId: map.get(String(t.id)).mediaId } }
    : t);
  await sbPut("tasks", next);

  const empresas = (await sbGet("companies", [])) || [];
  for (const a of armados) {
    const emp = empresas.find(c => String(c.id) === String(a.task.companyId));
    const dest = [...new Set([...correosDe(TEAM.filter(u => u.role === "admin")), ...(emp?.email && emp.email.includes("@") ? [emp.email] : [])])];
    await crearNotif({
      type: "contenido", title: "🟢 Automatización activa",
      body: `«${a.task.title || "El contenido"}» ya se publicó y su automatización de comentarios está respondiendo.`,
      to: dest, url: "/", important: false,
      dedupKey: "autoarmada_" + a.taskId,
    }).catch(e => console.error("IG armar aviso:", e.message));
  }
}

app.post("/api/ig/webhook", (req, res) => {
  // Meta corta a los 20 segundos y reintenta: primero se contesta, después se trabaja.
  const firma = String(req.headers["x-hub-signature-256"] || "");
  const esperada = "sha256=" + crypto.createHmac("sha256", igAppSecret()).update(req.rawBody || Buffer.from("")).digest("hex");
  const ok = igAppSecret() && firma.length === esperada.length &&
    crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
  if (!ok) return res.sendStatus(403);
  res.sendStatus(200);

  (async () => {
    try {
      // La primera línea del rastro: deja constancia de que Meta ENTREGÓ algo. Sin esto, un
      // webhook que nunca llega y uno que llega y se descarta por dentro se ven exactamente
      // igual desde fuera —silencio—, y son dos problemas opuestos.
      console.log(`IG webhook recibido: objeto=${req.body?.object} entradas=${(req.body?.entry || []).length} campos=${(req.body?.entry || []).flatMap(e => (e.changes || []).map(c => c.field)).join(",") || "(ninguno)"}`);
      if (req.body?.object !== "instagram") return;
      for (const entry of (req.body.entry || [])) {
        // Los comentarios llegan en `changes`; los mensajes y los botones pulsados, en
        // `messaging`. Son dos formas distintas en el mismo webhook y hay que mirar las dos.
        await igProcesarComentario(entry);
        for (const m of (entry.messaging || [])) await igProcesarPostback(entry, m);
      }
    } catch (e) { console.error("IG webhook:", e.message); }
  })();
});

// ── Desautorización y borrado de datos ──
// Meta llama a estas dos cuando alguien quita la app desde Instagram o pide que se borren sus
// datos. Las exige antes del App Review, pero la primera vale desde ya: sin ella nos
// quedaríamos con un token muerto intentando publicar en una cuenta que ya no nos quiere.
//
// Llegan como formulario, no como JSON, y con un `signed_request` firmado con la clave de la
// app: `<firma>.<payload>`, ambos en base64url. Verificar la firma es obligatorio — sin eso,
// cualquiera podría desconectar las cuentas de tus clientes mandando un POST.
const igForm = express.urlencoded({ extended: false });

function igSignedRequest(sr) {
  try {
    const [firma, payload] = String(sr).split(".");
    if (!firma || !payload) return null;
    const esperada = crypto.createHmac("sha256", igAppSecret()).update(payload).digest("base64url");
    if (firma !== esperada) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch { return null; }
}

// Borra lo que tengamos de esa cuenta de Instagram, venga de donde venga la petición. Recorre
// TODAS las empresas que la tengan, no solo la primera: una cuenta pudo quedar duplicada en filas
// viejas, y borrar solo una dejaba a la otra con un token ya revocado, respondiendo comentarios
// contra Meta con un permiso muerto y quemando el único mensaje por comentario.
async function igOlvidar(igUserId) {
  const s = await loadIG();
  const cids = Object.entries(s.cuentas).filter(([, c]) => String(c.igId) === String(igUserId)).map(([cid]) => cid);
  if (!cids.length) return null;
  await saveIG(s2 => { for (const cid of cids) { delete s2.cuentas[cid]; delete s2.reglas[cid]; } return s2; });
  return cids[0];
}

app.post("/api/ig/deauth", igForm, async (req, res) => {
  const d = igSignedRequest(req.body?.signed_request);
  if (!d) return res.sendStatus(403);
  const cid = await igOlvidar(d.user_id);
  console.log(`IG: desautorizada la cuenta ${d.user_id}${cid ? ` (empresa ${cid})` : " (no la teníamos)"}`);
  res.sendStatus(200);
});

// Meta exige responder con una URL donde la persona pueda seguir el estado, y un código.
app.post("/api/ig/borrar-datos", igForm, async (req, res) => {
  const d = igSignedRequest(req.body?.signed_request);
  if (!d) return res.sendStatus(403);
  const codigo = crypto.randomBytes(8).toString("hex");
  const cid = await igOlvidar(d.user_id);
  await saveIG(s => {
    s.borrados = s.borrados || {};
    s.borrados[codigo] = { igId: String(d.user_id), companyId: cid || null, fecha: new Date().toISOString() };
    return s;
  });
  const proto = req.headers["x-forwarded-proto"] === "https" || req.secure ? "https" : "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  res.json({ url: `${proto}://${host}/api/ig/borrar-datos/estado?code=${codigo}`, confirmation_code: codigo });
});

app.get("/api/ig/borrar-datos/estado", async (req, res) => {
  const s = await loadIG();
  const r = (s.borrados || {})[String(req.query.code || "")];
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Eliminación de datos — Inmersia</title>
<body style="font-family:system-ui,sans-serif;background:#05060B;color:#C9CFDC;margin:0;padding:48px 24px;line-height:1.6">
<div style="max-width:560px;margin:0 auto">
<h1 style="color:#F4F2ED;font-size:24px">Eliminación de datos</h1>
${r
  ? `<p>Solicitud <b style="color:#6FE7F2">${req.query.code}</b>: <b>completada</b> el ${new Date(r.fecha).toLocaleDateString("es-CL")}.</p>
     <p>Se eliminaron el permiso de acceso a Instagram y las reglas de respuesta automática asociadas a esa cuenta.</p>`
  : `<p>No encontramos ninguna solicitud con ese código.</p>`}
<p style="color:#6B7484;font-size:14px;margin-top:32px">¿Dudas? <a href="mailto:inmersiatours@gmail.com" style="color:#6FE7F2">inmersiatours@gmail.com</a> ·
<a href="https://inmersiaperformance.cl/privacidad.html#eliminacion" style="color:#6FE7F2">Política de privacidad</a></p>
</div></body>`);
});

// ===============================
// 🟢 SERVIR FRONTEND
// ===============================
app.use(express.static(path.join(__dirname, "public")));
app.get("/guion", (req, res) => { res.sendFile(path.join(__dirname, "public", "inm_guion_definitivo.html")); });

// Fidelización, cara pública. Son páginas APARTE de la SPA y eso es deliberado: quien las abre
// es el cliente final parado en el mesón con el teléfono en la mano, no el equipo. Bajarle los
// 650 KB de index.html —más React, ReactDOM y Babel transpilando en vivo— para pedirle un correo
// es perder a la mitad en la espera. Estas pesan unos pocos KB y no dependen de ningún CDN.
// Van ANTES del comodín; si no, el catch-all les devuelve el login de la app.
app.get("/unirse/:id",     (req, res) => { res.sendFile(path.join(__dirname, "public", "unirse.html")); });
app.get("/tarjeta/:codigo", (req, res) => { res.sendFile(path.join(__dirname, "public", "tarjeta.html")); });

app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => { console.log("Server INMERSIA v3.3 corriendo en puerto", PORT); });
