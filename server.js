const express = require("express");
const fetch = (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 10000;

// 🔥 LOGIN GOOGLE
app.get("/api/auth/google-login", (req, res) => {
  const redirect = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid email profile`;
  res.redirect(redirect);
});

// 🔥 GCAL + LOGIN CALLBACK
app.get("/api/auth/callback/google", async (req, res) => {
  const code = req.query.code;

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

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    });

    const userData = await userRes.json();

    const email = userData.email;

    // 🔥 diferencia entre login y gcal
    if (req.query.state === "gcal") {
      res.redirect(`/?gcal=success`);
    } else {
      res.redirect(`/?login=success&email=${email}`);
    }

  } catch (err) {
    console.error(err);
    res.send("Error en Google");
  }
});

// 🔥 GCAL BOTÓN
app.get("/api/auth/google", (req, res) => {
  const redirect = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/calendar&state=gcal`;
  res.redirect(redirect);
});

app.get("/", (req, res) => {
  res.send("Servidor funcionando 🚀");
});

app.listen(PORT, () => {
  console.log("Server corriendo en", PORT);
});
