const express = require("express");
const path = require("path");
const multer = require("multer");
const nodemailer = require("nodemailer");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json());

// ===============================
// 📧 EMAIL SETUP
// ===============================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendEmail(to, subject, html) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log("EMAIL no configurado, skip:", subject);
    return;
  }
  try {
    await transporter.sendMail({
      from: `"INMERSIA" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html
    });
    console.log("Email enviado a:", to, "->", subject);
  } catch (err) {
    console.error("Error email:", err.message);
  }
}

// ===============================
// 📧 NOTIFICACIÓN POR EMAIL
// ===============================
app.post("/api/notify", async (req, res) => {
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
    if (!tpl) return res.json({ ok: false, msg: "Tipo de notificación no válido" });

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
// 📧 TEST EMAIL
// ===============================
app.get("/api/test-email", async (req, res) => {
  try {
    await sendEmail(
      process.env.EMAIL_USER,
      "🧪 Test INMERSIA - Email funcionando",
      `<div style="font-family:Arial;padding:20px;background:#12121f;color:#e8e6f0;border-radius:12px">
        <h2 style="color:#c9a0ff">INMERSIA</h2>
        <p>Las notificaciones por email están funcionando correctamente ✅</p>
      </div>`
    );
    res.json({ ok: true, msg: "Email de prueba enviado a " + process.env.EMAIL_USER });
  } catch (err) {
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
    email: !!process.env.EMAIL_USER
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
app.post("/api/generate-acta", upload.single("audio"), async (req, res) => {
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
          { text: `Eres un asistente profesional de reuniones. Escucha este audio y genera DOS cosas:\n\n1. TRANSCRIPCIÓN: La transcripción completa y fiel del audio.\n\n2. ACTA DE REUNIÓN: Un acta formal con EXACTAMENTE este formato:\n\n**ACTA DE REUNIÓN**   |   ${company}\n\n**Reunión ${company}**\n\n${fechaStr}\n\n| **Fecha** | ${fechaStr} |\n| --- | --- |\n| **Proyecto** | ${company} – [Tema principal de la reunión] |\n| **Tipo de reunión** | [Tipo: Seguimiento / Kickoff / Planificación / etc.] |\n| **Participantes** | ${participants} |\n\nLuego enumera cada tema discutido como sección numerada (**1. Título**, **2. Título**, etc.) con bullets describiendo lo discutido.\n\nAl final agrega:\n\n**Próximos Pasos**\n\n| **Acción** | **Responsable** | **Plazo** |\n| --- | --- | --- |\n\nCon las acciones concretas extraídas de la reunión.\n\nTermina con:\n*— Fin del acta —*\nDocumento confidencial  •  ${company}  •  ${fechaStr}\n\nIMPORTANTE: Responde en este formato exacto:\n===TRANSCRIPCION===\n[transcripción aquí]\n===ACTA===\n[acta aquí]` }
        ]
      }];
    } else {
      contents = [{
        parts: [{
          text: `Genera un acta de reunión de ejemplo para la empresa ${company} con fecha ${fechaStr} y participantes: ${participants}. Usa el formato estándar con tabla de fecha, secciones numeradas y tabla de Próximos Pasos. Termina con:\n*— Fin del acta —*\nDocumento confidencial  •  ${company}  •  ${fechaStr}`
        }]
      }];
    }

    const result = await callGemini(contents);

    let transcript = "";
    let acta = result;

    if (result.includes("===TRANSCRIPCION===") && result.includes("===ACTA===")) {
      const parts = result.split("===ACTA===");
      transcript = parts[0].replace("===TRANSCRIPCION===", "").trim();
      acta = parts[1].trim();
    }

    let tasks = [];
    try {
      const taskContents = [{
        parts: [{
          text: `Del siguiente acta de reunión, extrae las tareas/acciones pendientes como un JSON array. Cada tarea debe tener: "title" (string), "responsable" (string o null), "date" (string YYYY-MM-DD o null). Responde SOLO con el JSON array, sin markdown, sin backticks.\n\nActa:\n${acta}`
        }]
      }];
      const taskResult = await callGemini(taskContents);
      const cleaned = taskResult.replace(/```json|```/g, "").trim();
      tasks = JSON.parse(cleaned);
    } catch (e) {
      console.log("No se pudieron extraer tareas:", e.message);
    }

    res.json({ transcript, acta, tasks });

  } catch (err) {
    console.error("Error generate-acta:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🤖 CUMBRE AI
// ===============================
app.post("/api/ai/generate", async (req, res) => {
  try {
    const { prompt } = req.body;
    const text = await callGemini([{ parts: [{ text: prompt }] }]);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 💳 LOYALTY PUSH
// ===============================
app.post("/api/loyalty/generate-push", async (req, res) => {
  try {
    const { company, topic } = req.body;
    const text = await callGemini([{ parts: [{ text: `Genera una notificación push de fidelización para la empresa ${company} sobre: ${topic}. Máximo 2 líneas, tono cercano y profesional.` }] }]);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 📣 META ADS ADVISOR
// ===============================
app.post("/api/meta/advisor", async (req, res) => {
  try {
    const { company, campaigns, totalBudget, question } = req.body;
    const text = await callGemini([{ parts: [{ text: `Eres un experto en Meta Ads. Empresa: ${company}. Presupuesto total: $${totalBudget}. Campañas actuales: ${JSON.stringify(campaigns)}. Pregunta: ${question}. Responde conciso y accionable.` }] }]);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🔐 AUTH GOOGLE
// ===============================
app.get("/api/auth/google-login", (req, res) => {
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid email profile`);
});

app.get("/api/auth/google", (req, res) => {
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/calendar&state=gcal`);
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

    if (state === "gcal") return res.redirect(`/?gcal=success&gcal_token=${tokenData.access_token}`);
    return res.redirect(`/?login=success&email=${userData.email}`);
  } catch (err) {
    console.error(err);
    res.send("Error en callback Google");
  }
});

// ===============================
// 🟢 SERVIR FRONTEND
// ===============================
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => { console.log("Server corriendo en puerto", PORT); });
