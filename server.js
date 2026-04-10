require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fetch = require("node-fetch");
const FormData = require("form-data");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ===== UPLOAD =====
const upload = multer({
  dest: "/tmp/inmersia-uploads/",
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ===== ENV =====
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// ===== GOOGLE AUTH =====
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

let googleTokens = null;

// ===== LOGIN GOOGLE =====
app.get("/api/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });

  res.redirect(url);
});

// ===== CALLBACK =====
app.get("/api/auth/callback/google", async (req, res) => {
  const code = req.query.code;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    googleTokens = tokens;

    res.send(`
      <h2>✅ Google Calendar conectado</h2>
      <script>
        window.location.href = "/";
      </script>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error conectando Google");
  }
});

// ===== TEST CALENDAR =====
app.get("/api/calendar/test", async (req, res) => {
  if (!googleTokens) {
    return res.status(400).json({ error: "No conectado a Google" });
  }

  oauth2Client.setCredentials(googleTokens);
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

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

// ===== CREAR EVENTO 🔥 =====
app.post("/api/calendar/create", async (req, res) => {
  if (!googleTokens) {
    return res.status(400).json({ error: "No conectado a Google" });
  }

  const { summary, description, start, end } = req.body;

  oauth2Client.setCredentials(googleTokens);
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  try {
    const event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description,
        start: {
          dateTime: start,
          timeZone: "America/Santiago",
        },
        end: {
          dateTime: end,
          timeZone: "America/Santiago",
        },
      },
    });

    res.json({ ok: true, event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== HEALTH =====
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    gemini: !!GEMINI_KEY,
    whisper: !!OPENAI_KEY,
    google: !!googleTokens,
  });
});

// ===== WHISPER =====
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!OPENAI_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY missing" });
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(req.file.path));
  form.append("model", "whisper-1");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: form,
    }
  );

  const data = await response.json();
  fs.unlink(req.file.path, () => {});

  res.json({ transcript: data.text });
});

// ===== GEMINI =====
app.post("/api/ai/generate", async (req, res) => {
  const { prompt } = req.body;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await response.json();

  res.json({
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || "Sin respuesta",
  });
});

// ===== FRONTEND =====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
