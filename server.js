const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// 🔐 CONFIG
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const REDIRECT_URI = "https://app-equipo-inmersia-beta-0-01.onrender.com/api/auth/callback/google";

// 👉 EMAILS AUTORIZADOS
const allowedUsers = [
  "clementeignacio19@gmail.com",
  "gcastilloaguirre@gmail.com",
  "contifellenberg@gmail.com",
  "j.agutoledo@gmail.com",
  "inmersiatours@gmail.com",
  "jose.vergara.diaz.vr@gmail.com"
];

// 🚀 LOGIN GOOGLE
app.get("/api/auth/google-login", (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent"
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// 🔁 CALLBACK GOOGLE
app.get("/api/auth/callback/google", async (req, res) => {
  const code = req.query.code;

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

    const access_token = tokenData.access_token;

    // 👤 obtener usuario
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });

    const user = await userRes.json();

    console.log("USER:", user);

    // 🚫 validar acceso
    if (!allowedUsers.includes(user.email)) {
      return res.send("❌ Usuario no autorizado");
    }

    // ✅ login OK → redirige al front
    res.redirect(`/?login=success&email=${user.email}`);

  } catch (err) {
    console.error(err);
    res.send("❌ Error en autenticación");
  }
});

// 🟢 TEST
app.get("/", (req, res) => {
  res.send("Servidor funcionando 🚀");
});

// 🚀 START
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
