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

app.use(express.json());

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
function rateLimit(max) {
  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const n = (_hits.get(ip) || 0) + 1;
    _hits.set(ip, n);
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

app.use("/api", rateLimit(120));

// ===============================
// ✅ igId WHITELIST
// ===============================
let _igCache = null, _igCacheAt = 0;
async function isValidIgId(igId) {
  const now = Date.now();
  if (_igCache && now - _igCacheAt < 300000) return _igCache.has(igId);
  try {
    const sbUrl = process.env.SUPABASE_URL || "https://cvytwyvaxccbcpfqezlr.supabase.co";
    const sbKey = process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
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
app.get("/api/test-email", async (req, res) => {
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

app.post("/api/auth/login", rateLimit(30), async (req, res) => {
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

app.post("/api/auth/password", requireAuth, rateLimit(20), async (req, res) => {
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
  key: process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT",
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
    const fin = new Date(Date.UTC(2000, 0, 1, h, m + dur));
    const hhmm = d => String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");

    const correos = [...new Set((invitados || []).map(e => String(e).trim().toLowerCase()).filter(e => e.includes("@")))];
    const evento = {
      summary: title,
      description: description || "",
      start: { dateTime: `${date}T${time}:00`, timeZone: MEET_TZ },
      end: { dateTime: `${date}T${hhmm(fin)}:00`, timeZone: MEET_TZ },
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
  await fetch(`${url}/rest/v1/app_data`, {
    method: "POST",
    headers: { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

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
    try { push = await sendPush({ title: n.title, body: n.body, url: n.url, tag: n.type, important: !!important }, dest); }
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
      const atrasadas = mias.filter(t => t.date && t.date < hoy);
      const partes = [];
      if (hoyMias.length) partes.push(`${hoyMias.length} para hoy`);
      if (atrasadas.length) partes.push(`${atrasadas.length} atrasada${atrasadas.length === 1 ? "" : "s"}`);
      await crearNotif({
        type: "mi_dia",
        title: partes.length ? "☀️ Tu día" : "☀️ Día despejado",
        body: partes.length
          ? partes.join(" · ") + ". " + (hoyMias[0] || atrasadas[0]).title
          : "No tienes nada agendado para hoy.",
        to: correosDe([u]), url: "/", important: !!atrasadas.length,
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
  const sbKey = process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";

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
    const sbKey=process.env.SUPABASE_KEY||"sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
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
    const sbKey=process.env.SUPABASE_KEY;
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
        const m=p.media_type==="VIDEO"?"reach,plays,likes,comments,shares,saved":"reach,likes,comments,shares,saved";
        const ins=await fetch(`${B}/${p.id}/insights?metric=${m}&${T}`).then(r=>r.json());
        const map={};(ins.data||[]).forEach(i=>{map[i.name]=i.values?.[0]?.value||0;});
        return{...p,ins:map,eng:(p.like_count||0)+(p.comments_count||0)+(map.saved||0)+(map.shares||0)};
      }catch{return{...p,ins:{},eng:(p.like_count||0)+(p.comments_count||0)};}
    }));
    withInsights.sort((a,b)=>b.eng-a.eng);
    res.json({posts:withInsights,count:withInsights.length});
  }catch(err){res.status(500).json({error:err.message});}
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
  const sbKey=process.env.SUPABASE_KEY||"sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
  const r=await fetch(`${sbUrl}/rest/v1/app_data?key=eq.prospects&select=value`,{
    headers:{apikey:sbKey,Authorization:`Bearer ${sbKey}`}
  });
  const d=await r.json();
  return d?.[0]?.value||[];
}
async function saveProspects(list){
  const sbUrl=process.env.SUPABASE_URL||"https://cvytwyvaxccbcpfqezlr.supabase.co";
  const sbKey=process.env.SUPABASE_KEY||"sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
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
// 🟢 SERVIR FRONTEND
// ===============================
app.use(express.static(path.join(__dirname, "public")));
app.get("/guion", (req, res) => { res.sendFile(path.join(__dirname, "public", "inm_guion_definitivo.html")); });
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => { console.log("Server INMERSIA v3.3 corriendo en puerto", PORT); });
