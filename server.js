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

    res.json({ ok: true, sent: recipients.length });

  } catch (err) {
    console.error("Error notify:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🧪 TEST & HEALTH
// ===============================
app.get("/api/test", (req, res) => {
  res.json({ ok: true, msg: "INMERSIA server running" });
});

app.get("/api/health", (req, res) => {
  res.json({
    gemini: !!process.env.GEMINI_API_KEY,
    email: !!process.env.RESEND_API_KEY
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
app.get("/api/auth/google-login", (req, res) => {
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid email profile`);
});

app.get("/api/auth/google", (req, res) => {
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/calendar openid email profile&state=gcal&access_type=offline&prompt=consent`);
});

app.get("/api/auth/callback/google", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send("No code recibido");

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: "authorization_code" })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) { console.log("TOKEN ERROR:", tokenData); return res.send("Error obteniendo token"); }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const userData = await userRes.json();
    console.log("LOGIN OK:", userData.email);

    if (state === "gcal") {
      // Store refresh_token in Supabase for persistent access
      if (tokenData.refresh_token) {
        try {
          const sbUrl = process.env.SUPABASE_URL || "https://cvytwyvaxccbcpfqezlr.supabase.co";
          const sbKey = process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
          // Load existing gcal tokens
          const loadRes = await fetch(`${sbUrl}/rest/v1/app_data?key=eq.gcal_tokens&select=value`, {
            headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` }
          });
          const loadData = await loadRes.json();
          const existing = loadData?.[0]?.value || {};
          existing[userData.email] = { refresh_token: tokenData.refresh_token, access_token: tokenData.access_token, email: userData.email };

          // Upsert
          await fetch(`${sbUrl}/rest/v1/app_data`, {
            method: "POST",
            headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify({ key: "gcal_tokens", value: existing, updated_at: new Date().toISOString() })
          });
          console.log("GCal refresh_token stored for:", userData.email);
        } catch (e) { console.error("Error storing gcal token:", e.message); }
      }
      return res.redirect(`/?gcal=success&gcal_token=${tokenData.access_token}&gcal_email=${userData.email}`);
    }

    res.cookie("_iauth", signToken(userData.email), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
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
  if (!refreshData.access_token) { console.error("Refresh failed:", refreshData); return null; }
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

// Fetch metrics broken down by 30-day windows → returns [{label,reach,total_interactions,...}, ...]
async function fetchMonthly(base,igId,tvMetrics,token,since,until){
  const CHUNK=30*24*60*60;
  const months=[];
  let s=since;
  while(s<until){const u=Math.min(s+CHUNK,until);months.push([s,u]);s=u;}
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
    const days=Math.min(parseInt(req.query.days)||30,180);
    const until=Math.floor(Date.now()/1000);
    const since=until-days*24*60*60;
    const prevSince=since-days*24*60*60;
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
      company:profileR.name,username:profileR.username,period:`${days} días`,
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
// 🟢 SERVIR FRONTEND
// ===============================
app.use(express.static(path.join(__dirname, "public")));
app.get("/guion", (req, res) => { res.sendFile(path.join(__dirname, "public", "inm_guion_definitivo.html")); });
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => { console.log("Server INMERSIA v3.3 corriendo en puerto", PORT); });
