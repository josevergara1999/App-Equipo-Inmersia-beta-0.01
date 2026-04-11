const express = require("express");
const path = require("path");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// 🧪 TEST
// ===============================
app.get("/api/test", (req, res) => {
  res.json({ ok: true, msg: "INMERSIA server running" });
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

  if (!code) {
    return res.send("No code recibido");
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code,
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
// 🟢 SERVIR FRONTEND DESDE /public
// ===============================
app.use(express.static(path.join(__dirname, "public")));

// Catch-all: si no matchea nada, servir index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===============================
app.listen(PORT, () => {
  console.log("Server corriendo en puerto", PORT);
});
