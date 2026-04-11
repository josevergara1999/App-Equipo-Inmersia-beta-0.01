import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ===== CONFIG =====
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT;

// ===== USERS (memoria simple) =====
const users = {};

// ===== LOGIN GOOGLE =====
app.get("/api/auth/google-login", (req, res) => {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${CLIENT_ID}` +
    `&redirect_uri=${REDIRECT_URI}` +
    `&response_type=code` +
    `&scope=https://www.googleapis.com/auth/calendar` +
    `&access_type=offline` +
    `&prompt=consent`;

  res.redirect(url);
});

// ===== CALLBACK GOOGLE =====
app.get("/api/auth/callback/google", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.send("❌ No code");
  }

  try {
    // 🔁 intercambiar code por token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });

    const tokenData = await tokenRes.json();

    // 👤 obtener info usuario
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    });

    const userData = await userRes.json();
    const email = userData.email;

    // ===== AQUÍ ESTABA EL ERROR =====
    // ahora crea usuario automáticamente
    if (!users[email]) {
      users[email] = {
        password: null,
        googleTokens: null
      };
    }

    // guardar tokens
    users[email].googleTokens = tokenData;

    // guardar sesión simple
    const sessionId = email;

    // redirigir al frontend
    res.redirect(`/?sessionId=${sessionId}`);

  } catch (err) {
    console.error(err);
    res.send("❌ Error en login Google");
  }
});

// ===== OBTENER TOKENS =====
app.get("/api/google-tokens", (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId || !users[sessionId]) {
    return res.json({});
  }

  res.json(users[sessionId].googleTokens || {});
});

// ===== SERVIR FRONT =====
app.use(express.static("public"));

// ===== START =====
app.listen(PORT, () => {
  console.log("🚀 Server corriendo en puerto " + PORT);
});
