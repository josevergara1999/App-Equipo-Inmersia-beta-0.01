require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== USERS
const users = {
  "clementeignacio19@gmail.com": { password: "1234", googleTokens: null },
  "gcastilloaguirre@gmail.com": { password: "1234", googleTokens: null },
  "contifellenberg@gmail.com": { password: "1234", googleTokens: null },
  "j.agutoledo@gmail.com": { password: "1234", googleTokens: null },
  "inmersiatours@gmail.com": { password: "1234", googleTokens: null },
};

const sessions = {};

// ===== GOOGLE CONFIG
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ===== LOGIN NORMAL
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

// ===== GOOGLE LOGIN (NUEVO 🔥)
app.get("/api/auth/google-login", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["profile", "email"],
  });

  res.redirect(url);
});

// ===== CALLBACK LOGIN GOOGLE
app.get("/api/auth/google-login/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: "v2",
    });

    const { data } = await oauth2.userinfo.get();
    const email = data.email;

    if (!users[email]) {
      return res.send("❌ No autorizado");
    }

    const sessionId = Math.random().toString(36).substring(2);
    sessions[sessionId] = email;

    res.send(`
      <script>
        localStorage.setItem("sessionId", "${sessionId}");
        window.location.href = "/";
      </script>
    `);

  } catch (err) {
    console.error(err);
    res.send("❌ Error login Google");
  }
});

// ===== GOOGLE CALENDAR
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

// ===== CALLBACK CALENDAR
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

// ===== CHANGE PASSWORD
app.post("/api/change-password", (req, res) => {
  const user = getUser(req);
  const { newPassword } = req.body;

  if (!user) {
    return res.status(401).json({ error: "No autorizado" });
  }

  user.password = newPassword;

  res.json({ ok: true });
});

// ===== HEALTH
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// ===== FRONT
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== START
app.listen(PORT, () => {
  console.log("🚀 Server running on " + PORT);
});
