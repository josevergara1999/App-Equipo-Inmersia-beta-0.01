const express = require("express");
const path = require("path");
const multer = require("multer");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json());

// ===============================
// 📧 RESEND EMAIL
// ===============================
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log("RESEND_API_KEY no configurada, skip:", subject); return null; }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "INMERSIA <notificaciones@inmersiaperformance.cl>",
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      })
    });
    const data = await r.json();
    if (data.error) console.error("Resend error:", JSON.stringify(data.error));
    else console.log("Email enviado:", subject, "->", to);
    return data;
  } catch (err) {
    console.error("Error email:", err.message);
    return { error: err.message };
  }
}

// ===============================
// 📧 TEST EMAIL
// ===============================
app.get("/api/test-email", async (req, res) => {
  try {
    const testTo = process.env.EMAIL_USER || "inmersiatours@gmail.com";
    const result = await sendEmail(
      testTo,
      "🧪 Test INMERSIA - Email funcionando",
      `<div style="font-family:Arial;padding:20px;background:#12121f;color:#e8e6f0;border-radius:12px"><h2 style="color:#c9a0ff">INMERSIA</h2><p>Las notificaciones por email están funcionando correctamente ✅</p></div>`
    );
    res.json({ ok: true, msg: "Email enviado a " + testTo, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    if (!tpl) return res.json({ ok: false, msg: "Tipo no válido" });

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
// 🧪 TEST & HEALTH
// ===============================
app.get("/api/test", (req, res) => {
  res.json({ ok: true, msg: "INMERSIA server running" });
});

app.get("/api/health", (req, res) => {
  res.json({
    gemini: !!process.env.GEMINI_API_KEY,
    email: !!process.env.RESEND_API_KEY
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
          { text: `Eres un asistente profesional de reuniones. Escucha este audio y genera DOS cosas:\n\n1. TRANSCRIPCIÓN: La transcripción completa y fiel del audio.\n\n2. ACTA DE REUNIÓN con este formato:\n\n**ACTA DE REUNIÓN**   |   ${company}\n\n**Reunión ${company}**\n\n${fechaStr}\n\n| **Fecha** | ${fechaStr} |\n| --- | --- |\n| **Proyecto** | ${company} – [Tema principal] |\n| **Tipo de reunión** | [Tipo] |\n| **Participantes** | ${participants} |\n\nSecciones numeradas con bullets. Al final tabla de Próximos Pasos.\n\n*— Fin del acta —*\nDocumento confidencial  •  ${company}  •  ${fechaStr}\n\nResponde:\n===TRANSCRIPCION===\n[transcripción]\n===ACTA===\n[acta]` }
        ]
      }];
    } else {
      contents = [{
        parts: [{ text: `Genera un acta de reunión de ejemplo para ${company}, fecha ${fechaStr}, participantes: ${participants}. Formato profesional con tabla de fecha, secciones numeradas y tabla de Próximos Pasos.\n\n*— Fin del acta —*\nDocumento confidencial  •  ${company}  •  ${fechaStr}` }]
      }];
    }

    const result = await callGemini(contents);
    let transcript = "", acta = result;

    if (result.includes("===TRANSCRIPCION===") && result.includes("===ACTA===")) {
      const parts = result.split("===ACTA===");
      transcript = parts[0].replace("===TRANSCRIPCION===", "").trim();
      acta = parts[1].trim();
    }

    let tasks = [];
    try {
      const taskResult = await callGemini([{ parts: [{ text: `Extrae tareas del acta como JSON array con "title", "responsable" (string o null), "date" (YYYY-MM-DD o null). SOLO JSON, sin markdown.\n\n${acta}` }] }]);
      tasks = JSON.parse(taskResult.replace(/```json|```/g, "").trim());
    } catch (e) { console.log("No se extrajeron tareas:", e.message); }

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===============================
// 💳 LOYALTY PUSH
// ===============================
app.post("/api/loyalty/generate-push", async (req, res) => {
  try {
    const { company, topic } = req.body;
    const text = await callGemini([{ parts: [{ text: `Genera una notificación push de fidelización para ${company} sobre: ${topic}. Máximo 2 líneas, tono cercano y profesional.` }] }]);
    res.json({ text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===============================
// 📣 META ADS ADVISOR
// ===============================
app.post("/api/meta/advisor", async (req, res) => {
  try {
    const { company, campaigns, totalBudget, question } = req.body;
    const text = await callGemini([{ parts: [{ text: `Eres un experto en Meta Ads. Empresa: ${company}. Presupuesto: $${totalBudget}. Campañas: ${JSON.stringify(campaigns)}. Pregunta: ${question}. Responde conciso y accionable.` }] }]);
    res.json({ text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===============================
// 🔐 AUTH GOOGLE
// ===============================
app.get("/api/auth/google-login", (req, res) => {
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=openid email profile`);
});

app.get("/api/auth/google", (req, res) => {
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/calendar openid email profile&state=gcal&access_type=offline&prompt=consent`);
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

    if (state === "gcal") {
      // Store refresh_token in Supabase for persistent access
      if (tokenData.refresh_token) {
        try {
          const sbUrl = process.env.SUPABASE_URL || "https://cvytwyvaxccbcpfqezlr.supabase.co";
          const sbKey = process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
          // Load existing gcal tokens
          const loadRes = await fetch(`${sbUrl}/rest/v1/app_data?key=eq.gcal_tokens&select=value`, {
            headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` }
          });
          const loadData = await loadRes.json();
          const existing = loadData?.[0]?.value || {};
          existing[userData.email] = { refresh_token: tokenData.refresh_token, access_token: tokenData.access_token, email: userData.email };

          // Upsert
          await fetch(`${sbUrl}/rest/v1/app_data`, {
            method: "POST",
            headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify({ key: "gcal_tokens", value: existing, updated_at: new Date().toISOString() })
          });
          console.log("GCal refresh_token stored for:", userData.email);
        } catch (e) { console.error("Error storing gcal token:", e.message); }
      }
      return res.redirect(`/?gcal=success&gcal_token=${tokenData.access_token}&gcal_email=${userData.email}`);
    }

    return res.redirect(`/?login=success&email=${userData.email}`);
  } catch (err) {
    console.error(err);
    res.send("Error en callback Google");
  }
});

// ===============================
// 📅 GCAL SYNC - persistent
// ===============================
async function getGCalAccessToken(email) {
  const sbUrl = process.env.SUPABASE_URL || "https://cvytwyvaxccbcpfqezlr.supabase.co";
  const sbKey = process.env.SUPABASE_KEY || "sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";

  const loadRes = await fetch(`${sbUrl}/rest/v1/app_data?key=eq.gcal_tokens&select=value`, {
    headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` }
  });
  const loadData = await loadRes.json();
  const tokens = loadData?.[0]?.value || {};
  const userToken = tokens[email];
  if (!userToken?.refresh_token) return null;

  // Refresh the access token
  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: userToken.refresh_token,
      grant_type: "refresh_token"
    })
  });
  const refreshData = await refreshRes.json();
  if (!refreshData.access_token) { console.error("Refresh failed:", refreshData); return null; }
  return refreshData.access_token;
}

app.post("/api/gcal/sync", async (req, res) => {
  try {
    const { email, title, company, date } = req.body;
    if (!email || !date) return res.json({ ok: false, msg: "Faltan datos" });

    const accessToken = await getGCalAccessToken(email);
    if (!accessToken) return res.json({ ok: false, msg: "GCal no conectado para " + email });

    const event = {
      summary: title,
      description: "INMERSIA: " + (company || ""),
      start: { date },
      end: { date }
    };

    const calRes = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify(event)
    });
    const calData = await calRes.json();

    if (calData.error) {
      console.error("GCal sync error:", calData.error);
      return res.json({ ok: false, msg: calData.error.message });
    }

    console.log("GCal event created:", title, "->", email);
    res.json({ ok: true, eventId: calData.id });
  } catch (err) {
    console.error("Error gcal sync:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 📊 META / INSTAGRAM MÉTRICAS
// ===============================
app.get("/api/auth/meta",(req,res)=>{
  const appId=process.env.META_APP_ID;
  const redirectUri=process.env.META_REDIRECT_URI;
  const scopes="instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement";
  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code`);
});

app.get("/api/auth/callback/meta",async(req,res)=>{
  const{code}=req.query;
  if(!code)return res.send("No code recibido");
  try{
    const appId=process.env.META_APP_ID;
    const appSecret=process.env.META_APP_SECRET;
    const redirectUri=process.env.META_REDIRECT_URI;
    const shortRes=await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`);
    const shortData=await shortRes.json();
    if(!shortData.access_token)return res.send("Error token: "+JSON.stringify(shortData));
    const llRes=await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortData.access_token}`);
    const llData=await llRes.json();
    const token=llData.access_token||shortData.access_token;
    const sbUrl=process.env.SUPABASE_URL||"https://cvytwyvaxccbcpfqezlr.supabase.co";
    const sbKey=process.env.SUPABASE_KEY||"sb_publishable_qMN54n9jRGicBX81xsV5-g_3mxen2AT";
    await fetch(`${sbUrl}/rest/v1/app_data`,{
      method:"POST",
      headers:{"apikey":sbKey,"Authorization":`Bearer ${sbKey}`,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates"},
      body:JSON.stringify({key:"meta_token",value:{token,expires_at:Date.now()+(llData.expires_in||5183944)*1000},updated_at:new Date().toISOString()})
    });
    res.redirect("/?meta=connected");
  }catch(err){
    console.error("Meta OAuth callback error:",err);
    res.send("Error: "+err.message);
  }
});

async function getMetaToken(){
  if(process.env.META_ACCESS_TOKEN)return process.env.META_ACCESS_TOKEN;
  try{
    const sbUrl=process.env.SUPABASE_URL;
    const sbKey=process.env.SUPABASE_KEY;
    if(!sbUrl||!sbKey)return null;
    const r=await fetch(`${sbUrl}/rest/v1/app_data?key=eq.meta_token&select=value`,{headers:{"apikey":sbKey,"Authorization":`Bearer ${sbKey}`}});
    const d=await r.json();
    return d?.[0]?.value?.token||null;
  }catch{return null;}
}

app.get("/api/meta/status",async(req,res)=>{
  try{
    const token=await getMetaToken();
    if(!token)return res.json({connected:false});
    const r=await fetch(`https://graph.facebook.com/v19.0/me?fields=name&access_token=${token}`);
    const d=await r.json();
    if(d.error)return res.json({connected:false});
    res.json({connected:true,user:d.name});
  }catch{res.json({connected:false});}
});

app.get("/api/meta/token-info",async(req,res)=>{
  try{
    const token=await getMetaToken();
    if(!token)return res.json({connected:false});
    const appId=process.env.META_APP_ID;
    const appSecret=process.env.META_APP_SECRET;
    const r=await fetch(`https://graph.facebook.com/debug_token?input_token=${token}&access_token=${appId}|${appSecret}`);
    const d=await r.json();
    if(d.error||d.data?.error)return res.json({connected:false});
    res.json({connected:true,expires_at:d.data?.expires_at||null,is_valid:d.data?.is_valid||false});
  }catch(err){res.json({connected:false,error:err.message});}
});

app.get("/api/meta/exchange",async(req,res)=>{
  const{token}=req.query;
  if(!token)return res.json({error:"token requerido"});
  try{
    const appId=process.env.META_APP_ID;
    const appSecret=process.env.META_APP_SECRET;
    const llRes=await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`);
    const llData=await llRes.json();
    if(!llData.access_token)return res.json({error:"Exchange falló",details:llData});
    const dias=Math.floor((llData.expires_in||5183944)/86400);
    res.json({ok:true,dias,token:llData.access_token,instruccion:`Agrega META_ACCESS_TOKEN en Render con el valor del campo "token"`});
  }catch(err){res.status(500).json({error:err.message});}
});

// Fetch metrics broken down by 30-day windows → returns [{label,reach,total_interactions,...}, ...]
async function fetchMonthly(base,igId,tvMetrics,token,since,until){
  const CHUNK=30*24*60*60;
  const months=[];
  let s=since;
  while(s<until){const u=Math.min(s+CHUNK,until);months.push([s,u]);s=u;}
  const results=await Promise.all(months.map(async([cs,cu])=>{
    const date=new Date(cs*1000);
    const label=date.toLocaleDateString("es-CL",{month:"short",year:"2-digit"})
      .replace(".","").replace(/^(\w)/,c=>c.toUpperCase());
    const[tvR,rR]=await Promise.all([
      fetch(`${base}/${igId}/insights?metric=${tvMetrics}&metric_type=total_value&period=day&since=${cs}&until=${cu}&access_token=${token}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${base}/${igId}/insights?metric=reach&period=day&since=${cs}&until=${cu}&access_token=${token}`).then(r=>r.json()).catch(()=>({})),
    ]);
    const tv={};
    (tvR.data||[]).forEach(m=>{tv[m.name]=m.total_value?.value||0;});
    const reach=(rR.data||[]).find(m=>m.name==="reach")?.values?.reduce((s,v)=>s+(v.value||0),0)||0;
    return{label,reach,...tv};
  }));
  return results;// already oldest→newest (built from since→until)
}

app.get("/api/meta/insights-full",async(req,res)=>{
  try{
    const{igId}=req.query;
    if(!igId)return res.status(400).json({error:"igId requerido"});
    const token=await getMetaToken();
    if(!token)return res.json({error:"Meta no conectado",connected:false});
    const days=Math.min(parseInt(req.query.days)||30,180);
    const until=Math.floor(Date.now()/1000);
    const since=until-days*24*60*60;
    const prevSince=since-days*24*60*60;
    const B=`https://graph.facebook.com/v19.0`;
    const T=`access_token=${token}`;
    const TV_METRICS="profile_views,accounts_engaged,total_interactions";
    const[profileR,reachR,prevReachR,followerR,prevFollowerR,demoAgeR,demoCityR,mediaR]=await Promise.all([
      fetch(`${B}/${igId}?fields=followers_count,media_count,name,username,profile_picture_url&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=reach&period=day&since=${since}&until=${until}&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=reach&period=day&since=${prevSince}&until=${since}&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=follower_count&period=day&since=${since}&until=${until}&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/insights?metric=follower_count&period=day&since=${prevSince}&until=${since}&${T}`).then(r=>r.json()).catch(()=>({})),
      fetch(`${B}/${igId}/insights?metric=follower_demographics&metric_type=total_value&period=lifetime&breakdown=age,gender&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/insights?metric=follower_demographics&metric_type=total_value&period=lifetime&breakdown=city&${T}`).then(r=>r.json()),
      fetch(`${B}/${igId}/media?fields=id,caption,media_type,timestamp,like_count,comments_count,media_url,thumbnail_url&limit=24&${T}`).then(r=>r.json()),
    ]);
    if(profileR.error)return res.json({error:profileR.error.message,connected:false});
    // monthly breakdown for bar charts + aggregate totals
    const[monthly,prevMonthly]=await Promise.all([
      fetchMonthly(B,igId,TV_METRICS,token,since,until),
      fetchMonthly(B,igId,TV_METRICS,token,prevSince,since),
    ]);
    const TV_KEYS=["reach","profile_views","accounts_engaged","total_interactions"];
    const totals={},prevTotals={};
    monthly.forEach(m=>{TV_KEYS.forEach(k=>{totals[k]=(totals[k]||0)+(m[k]||0);});});
    prevMonthly.forEach(m=>{TV_KEYS.forEach(k=>{prevTotals[k]=(prevTotals[k]||0)+(m[k]||0);});});
    const mediaPosts=mediaR.data||[];
    const postInsights=await Promise.all(mediaPosts.map(async post=>{
      try{
        const m=post.media_type==="VIDEO"?"reach,likes,comments,shares,saved,plays":"reach,likes,comments,shares,saved";
        const ins=await fetch(`${B}/${post.id}/insights?metric=${m}&${T}`).then(r=>r.json());
        const map={};
        (ins.data||[]).forEach(m=>{map[m.name]=m.values?.[0]?.value||0;});
        return{...post,ins:map};
      }catch{return{...post,ins:{}};}
    }));
    const followerVals=(followerR.data||[]).find(m=>m.name==="follower_count")?.values||[];
    const prevFollowerVals=(prevFollowerR.data||[]).find(m=>m.name==="follower_count")?.values||[];
    const followerGrowth=followerVals.length>=2?followerVals[followerVals.length-1].value-followerVals[0].value:null;
    const prevFollowerGrowth=prevFollowerVals.length>=2?prevFollowerVals[prevFollowerVals.length-1].value-prevFollowerVals[0].value:null;
    const demoAge=demoAgeR.data?.[0]?.total_value?.breakdowns?.[0]?.results||[];
    const demoCity=demoCityR.data?.[0]?.total_value?.breakdowns?.[0]?.results||[];
    res.json({connected:true,profile:profileR,insights:reachR.data||[],prevInsights:prevReachR.data||[],totals,prevTotals,monthly,followerGrowth,prevFollowerGrowth,followerTrend:followerVals,demoAge,demoCity,media:postInsights});
  }catch(err){
    console.error("Meta insights-full error:",err);
    res.status(500).json({error:err.message});
  }
});

app.get("/api/meta/insights",async(req,res)=>{
  try{
    const{igId}=req.query;
    if(!igId)return res.status(400).json({error:"igId requerido"});
    const token=await getMetaToken();
    if(!token)return res.json({error:"Meta no conectado",connected:false});
    const until=Math.floor(Date.now()/1000);
    const since=until-30*24*60*60;
    const prevSince=since-30*24*60*60;
    const profileRes=await fetch(`https://graph.facebook.com/v19.0/${igId}?fields=followers_count,media_count,name,username,profile_picture_url&access_token=${token}`);
    const profile=await profileRes.json();
    if(profile.error)return res.json({error:profile.error.message,connected:false});
    // Reach: serie diaria para gráfico
    const reachRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=reach&period=day&since=${since}&until=${until}&access_token=${token}`);
    const reachData=await reachRes.json();
    const prevReachRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=reach&period=day&since=${prevSince}&until=${since}&access_token=${token}`);
    const prevReachData=await prevReachRes.json();
    // Métricas de valor total
    const tvRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=profile_views,accounts_engaged,total_interactions&metric_type=total_value&period=day&since=${since}&until=${until}&access_token=${token}`);
    const tvData=await tvRes.json();
    const prevTvRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=profile_views,accounts_engaged,total_interactions&metric_type=total_value&period=day&since=${prevSince}&until=${since}&access_token=${token}`);
    const prevTvData=await prevTvRes.json();
    const mediaRes=await fetch(`https://graph.facebook.com/v19.0/${igId}/media?fields=id,caption,media_type,timestamp,like_count,comments_count,media_url,thumbnail_url&limit=9&access_token=${token}`);
    const media=await mediaRes.json();
    const totals={};const prevTotals={};
    (tvData.data||[]).forEach(m=>{totals[m.name]=m.total_value?.value||0;});
    (prevTvData.data||[]).forEach(m=>{prevTotals[m.name]=m.total_value?.value||0;});
    res.json({connected:true,profile,insights:reachData.data||[],prevInsights:prevReachData.data||[],totals,prevTotals,media:media.data||[]});
  }catch(err){
    console.error("Meta insights error:",err);
    res.status(500).json({error:err.message});
  }
});

// ===============================
// 🟢 SERVIR FRONTEND
// ===============================
app.use(express.static(path.join(__dirname, "public")));
app.get("/guion", (req, res) => { res.sendFile(path.join(__dirname, "public", "inm_guion_definitivo.html")); });
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => { console.log("Server INMERSIA v3.3 corriendo en puerto", PORT); });
