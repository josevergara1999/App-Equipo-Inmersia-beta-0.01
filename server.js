require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== USERS (simple demo)
const users = {
  "cleme@inmersia.com": { password: "1234", googleTokens: null },
  "jose@inmersia.com": { password: "1234", googleTokens: null },
};

const sessions = {};

// ===== GOOGLE CONFIG
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ===== LOGIN
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  if (!users[email] || users[email].password !== password) {
    return res.status(401).json({ error: "Credenciales inválidas" });
  }

  const sessionId = Math.random().toString(36).substring(2);
  sessions[sessionId] = email;

  res.json({ sessionId });
});

// ===== GET USER
function getUser(req) {
  const sessionId = req.headers["x-session-id"];
  const email = sessions[sessionId];
  return users[email];
}

// ===== GOOGLE LOGIN
app.get("/api/auth/google", (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    return res.send("❌ Falta sessionId");
  }

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: sessionId,
  });

  res.redirect(url);
});

// ===== CALLBACK GOOGLE
app.get("/api/auth/callback/google", async (req, res) => {
  const code = req.query.code;
  const sessionId = req.query.state;

  const email = sessions[sessionId];
  const user = users[email];

  if (!user) {
    return res.send("❌ Sesión inválida");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    user.googleTokens = tokens;

    res.send(`
      <h2>✅ Google conectado correctamente</h2>
      <script>
        window.location.href = "/";
      </script>
    `);
  } catch (err) {
    console.error(err);
    res.send("❌ Error conectando Google");
  }
});

// ===== TEST CALENDAR
app.get("/api/calendar/test", async (req, res) => {
  const user = getUser(req);

  if (!user || !user.googleTokens) {
    return res.status(400).json({ error: "No conectado a Google" });
  }

  oauth2Client.setCredentials(user.googleTokens);

  const calendar = google.calendar({
    version: "v3",
    auth: oauth2Client,
  });

  try {
    const response = await calendar.events.list({
      calendarId: "primary",
      maxResults: 5,
    });

    res.json(response.data.items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== AI GENERATE (OPENAI)
app.post("/api/ai/generate", async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    res.json({ text: data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== FAKE TRANSCRIBE (placeholder)
app.post("/api/transcribe", async (req, res) => {
  res.json({ transcript: "Transcripción simulada (configura Whisper después)" });
});

// ===== GENERATE ACTA
app.post("/api/generate-acta", async (req, res) => {
  try {
    const { company, participants } = req.body;

    const fakeTranscript = "Reunión sobre marketing y contenido";

    const prompt = `
Resumen de reunión para ${company}
Participantes: ${participants}
Texto: ${fakeTranscript}

Devuelve:
1. Acta
2. Lista de tareas
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    res.json({
      acta: data.choices[0].message.content,
      transcript: fakeTranscript,
      tasks: [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== LOYALTY
app.post("/api/loyalty/generate-push", async (req, res) => {
  const { company, topic } = req.body;

  res.json({
    text: `Promo para ${company}: ${topic} 🔥`,
  });
});

// ===== META ADS
app.post("/api/meta/advisor", async (req, res) => {
  const { company } = req.body;

  res.json({
    text: `Estrategia recomendada para ${company}: aumentar inversión en reels.`,
  });
});

// ===== HEALTH
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    gemini: !!process.env.GEMINI_API_KEY,
    whisper: !!process.env.OPENAI_API_KEY,
  });
});

// ===== FRONT
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== START
app.listen(PORT, () => {
  console.log("🚀 Server running on " + PORT);
});
