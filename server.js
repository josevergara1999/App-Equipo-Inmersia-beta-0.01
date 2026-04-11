// ===== GOOGLE LOGIN SIMPLE (NO ROMPE NADA)
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

    // 🔥 PERMITIDOS
    const allowedUsers = [
      "clementeignacio19@gmail.com",
      "gcastilloaguirre@gmail.com",
      "contifellenberg@gmail.com",
      "j.agutoledo@gmail.com",
      "inmersiatours@gmail.com"
    ];

    if (!allowedUsers.includes(email)) {
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
