const express = require("express");
const path = require("path");
const multer = require("multer");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json());

// ===============================
// 🧪 TEST & HEALTH
// ===============================
app.get("/api/test", (req, res) => {
  res.json({ ok: true, msg: "INMERSIA server running" });
});

app.get("/api/health", (req, res) => {
  res.json({
    gemini: !!process.env.GEMINI_API_KEY
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
          {
            inlineData: {
              mimeType: mimeType,
              data: audioBase64
            }
          },
          {
            text: `Eres un asistente profesional de reuniones. Escucha este audio y genera DOS cosas:

1. TRANSCRIPCIÓN: La transcripción completa y fiel del audio.

2. ACTA DE REUNIÓN: Un acta formal con EXACTAMENTE este formato:

**ACTA DE REUNIÓN**   |   ${company}

**Reunión ${company}**

${fechaStr}

| **Fecha** | ${fechaStr} |
| --- | --- |
| **Proyecto** | ${company} – [Tema principal de la reunión] |
| **Tipo de reunión** | [Tipo: Seguimiento / Kickoff / Planificación / etc.] |
| **Participantes** | ${participants} |

Luego enumera cada tema discutido como sección numerada (**1. Título**, **2. Título**, etc.) con bullets describiendo lo discutido.

Al final agrega:

**Próximos Pasos**

| **Acción** | **Responsable** | **Plazo** |
| --- | --- | --- |

Con las acciones concretas extraídas de la reunión.

Termina con:
*— Fin del acta —*
Documento confidencial  •  ${company}  •  ${fechaStr}

IMPORTANTE: Responde en este formato exacto:
===TRANSCRIPCION===
[transcripción aquí]
===ACTA===
[acta aquí]`
          }
        ]
      }];
    } else {
      contents = [{
        parts: [{
          text: `Genera un acta de reunión de ejemplo para la empresa ${company} con fecha ${fechaStr} y participantes: ${participants}. Usa este formato:

**ACTA DE REUNIÓN**   |   ${company}

**Reunión ${company}**

${fechaStr}

| **Fecha** | ${fechaStr} |
| --- | --- |
| **Proyecto** | ${company} – Estrategia de Contenido y Marketing |
| **Tipo de reunión** | Seguimiento y alineación estratégica |
| **Participantes** | ${participants} |

Incluye secciones numeradas con los temas discutidos y una tabla de Próximos Pasos al final.

Termina con:
*— Fin del acta —*
Documento confidencial  •  ${company}  •  ${fechaStr}`
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

    // Extraer tareas del acta
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
// 🤖 CUMBRE AI (Chat general)
// ===============================
app.post("/api/ai/generate", async (req, res) => {
  try {
    const { prompt } = req.body;
    const contents = [{ parts: [{ text: prompt }] }];
    const text = await callGemini(contents);
    res.json({ text });
  } catch (err) {
    console.error("Error AI generate:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 💳 LOYALTY PUSH
// ===============================
app.post("/api/loyalty/generate-push", async (req, res) => {
  try {
    const { company, topic } = req.body;
    const contents = [{ parts: [{ text: `Genera una notificación push de fidelización para la empresa ${company} sobre: ${topic}. Máximo 2 líneas, tono cercano y profesional.` }] }];
    const text = await callGemini(contents);
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
    const contents = [{ parts: [{ text: `Eres un experto en Meta Ads. Empresa: ${company}. Presupuesto total: $${totalBudget}. Campañas actuales: ${JSON.stringify(campaigns)}. Pregunta del usuario: ${question}. Responde de forma concisa y accionable.` }] }];
    const text = await callGemini(contents);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🔐 LOGIN GOOGLE
// ===============================
app.get("/api/auth/google-login", (req, res) => {
  const redirect = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid email profile`;
  res.redirect(redirect);
});

// ===============================
// 📅 GOOGLE CALENDAR AUTH
// ===============================
app.get("/api/auth/google", (req, res) => {
  const redirect = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/calendar&state=gcal`;
  res.redirect(redirect);
});

// ===============================
// 🔁 CALLBACK GOOGLE
// ===============================
app.get("/api/auth/callback/google", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code) return res.send("No code recibido");

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.log("TOKEN ERROR:", tokenData);
      return res.send("Error obteniendo token");
    }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const userData = await userRes.json();
    const email = userData.email;
    console.log("LOGIN OK:", email);

    if (state === "gcal") {
      return res.redirect(`/?gcal=success&gcal_token=${tokenData.access_token}`);
    }

    return res.redirect(`/?login=success&email=${email}`);

  } catch (err) {
    console.error(err);
    res.send("Error en callback Google");
  }
});

// ===============================
// 🟢 SERVIR FRONTEND
// ===============================
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Server corriendo en puerto", PORT);
});
