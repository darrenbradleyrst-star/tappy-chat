// =========================================
// RST EPOS Smart Chatbot API v12.6 ("Tappy Brain + Inline Support")
// ✅ Support mode now shows FAQ suggestions inline
// ✅ User can choose a matching question (1–5 or by name)
// ✅ Displays step-by-step solution directly in chat
// ✅ Then asks if issue was resolved
// ✅ Sales mode: keeps lead capture + smart routing
// =========================================

import express from "express";
import OpenAI from "openai";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();
const PORT = process.env.PORT || 3001;
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------------------------------------------
// 📁 Paths & Setup
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const salesLeadsPath = path.join(__dirname, "sales_leads.jsonl");

const faqsSupportPath = path.join(__dirname, "faqs_support.json");
let faqsSupport = [];

if (fs.existsSync(faqsSupportPath)) {
  try {
    faqsSupport = JSON.parse(fs.readFileSync(faqsSupportPath, "utf8"));
    console.log(`✅ Loaded ${faqsSupport.length} support FAQ entries`);
  } catch (err) {
    console.error("❌ Failed to parse faqs_support.json:", err);
  }
} else {
  console.warn("⚠️ faqs_support.json not found");
}

// ------------------------------------------------------
// 🌐 Express Config
// ------------------------------------------------------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "https://staging.rstepos.com",
      "https://www.rstepos.com",
      "https://tappy-chat.onrender.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    message: { error: "Rate limit exceeded — please wait a moment." },
  })
);

// ------------------------------------------------------
// 🧾 Utilities
// ------------------------------------------------------
const logJSON = (file, data) =>
  fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...data }) + "\n");
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

// ------------------------------------------------------
// 💬 Sessions & Chat Route
// ------------------------------------------------------
const sessions = {};

app.post("/api/chat", async (req, res) => {
  const { message, context, reset } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  if (reset) {
    sessions[ip] = { step: "none", mode: "general", lead: {}, supportList: [] };
    return res.json({ reply: "Session reset OK." });
  }

  if (!message) return res.status(400).json({ error: "No message provided" });
  if (!sessions[ip])
    sessions[ip] = { step: "none", mode: context || "general", lead: {}, supportList: [] };

  const s = sessions[ip];
  const lower = message.toLowerCase().trim();

  try {
    // ✅ Universal resets
    if (["restart", "new question", "start over"].includes(lower)) {
      s.step = "none";
      s.supportList = [];
      return res.json({ reply: "✅ No problem — please type your new question below." });
    }

    // ✅ Follow-up logic after FAQ shown
    if (s.step === "support_followup") {
      if (["yes", "yep", "yeah", "sorted"].includes(lower)) {
        s.step = "none";
        s.supportList = [];
        return res.json({ reply: "✅ Glad to hear that!" });
      }
      if (["no", "nope", "not yet", "still broken"].includes(lower)) {
        s.step = "none";
        s.supportList = [];
        return res.json({
          reply: "😕 No problem — please describe what’s still not working and I’ll try to help.",
        });
      }
    }

    // ✅ Handle Support Mode
    if (context === "support" || context === "general") {
      // If waiting for a numbered selection
      if (s.step === "support_select") {
        const choice = parseInt(lower);
        let chosen = null;

        if (!isNaN(choice) && s.supportList[choice - 1])
          chosen = s.supportList[choice - 1];
        else
          chosen = s.supportList.find((f) =>
            f.title.toLowerCase().includes(lower)
          );

        if (chosen) {
          s.step = "support_followup";
          s.supportList = [];
          const answer =
            chosen.answers?.map((a, i) => `Step ${i + 1}: ${a}`).join("<br>") ||
            "No detailed steps found.";
          return res.json({
            reply: `💡 *${chosen.title}*<br>${answer}<br><br>Did this resolve your issue?`,
          });
        } else {
          return res.json({
            reply:
              "⚠️ I didn’t recognise that choice — please reply with the number or part of the question title.",
          });
        }
      }

      // First lookup
      const matches = findSupportMatches(message);
      if (matches.length === 0)
        return res.json({
          reply:
            "🤔 I couldn’t find anything matching that yet — can you describe the issue in more detail?",
        });

      if (matches.length === 1) {
        s.step = "support_followup";
        const m = matches[0];
        const answer = m.answers.map((a, i) => `Step ${i + 1}: ${a}`).join("<br>");
        return res.json({
          reply: `💡 *${m.title}*<br>${answer}<br><br>Did this resolve your issue?`,
        });
      }

      // Multiple possible matches
      s.step = "support_select";
      s.supportList = matches.slice(0, 5);
      const list = s.supportList
        .map((m, i) => `${i + 1}) ${m.title}`)
        .join("<br>");
      return res.json({
        reply: `🔍 I found a few articles that might help:<br>${list}<br><br>Reply with the number or part of the title to see the steps.`,
      });
    }

    // ✅ Sales Mode
    if (context === "sales") {
      if (s.step && s.step !== "none") {
        const reply = continueLeadCapture(s, message);
        if (reply.complete) {
          logJSON(salesLeadsPath, s.lead);
          s.step = "none";
          return res.json({
            reply:
              "✅ Thanks — your details have been sent to our sales team. We’ll be in touch shortly!",
          });
        }
        return res.json({ reply: reply.text });
      }

      if (lower.includes("price") || lower.includes("quote")) {
        s.step = "name";
        s.lead = {};
        return res.json({
          reply: "💬 Sure — I can help with a quote. What’s your *name* please?",
        });
      }

      const reply = await handleSalesRouting(message);
      return res.json({ reply });
    }

    // ✅ Default
    return res.json({
      reply: "💬 I’m here to help with RST EPOS, TapaPOS or TapaPay — what would you like to know?",
    });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ------------------------------------------------------
// 🔎 Support Finder
// ------------------------------------------------------
function findSupportMatches(message) {
  const lower = message.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  const results = [];

  for (const entry of faqsSupport) {
    if (!entry.questions || !entry.answers) continue;
    const allQ = entry.questions.map((q) => q.toLowerCase());
    const score = allQ.reduce((sum, q) => {
      const overlap = q.split(/\s+/).filter((w) => words.includes(w)).length;
      return sum + (overlap > 0 ? 1 : 0);
    }, 0);
    if (score > 0)
      results.push({
        title: entry.title || entry.questions[0],
        answers: entry.answers,
      });
  }
  return results;
}

// ------------------------------------------------------
// 🧩 Lead Capture
// ------------------------------------------------------
function continueLeadCapture(s, message) {
  switch (s.step) {
    case "name":
      s.lead.name = message.trim();
      s.step = "company";
      return { text: "🏢 Thanks! What’s your *company name*?" };
    case "company":
      s.lead.company = message.trim();
      s.step = "email";
      return { text: "📧 And what’s the best *email address* to send details to?" };
    case "email":
      if (!isValidEmail(message))
        return { text: "⚠️ That doesn’t look like a valid email — could you re-enter it?" };
      s.lead.email = message.trim();
      s.step = "comments";
      return { text: "📝 Great — any specific notes or requirements for your quote?" };
    case "comments":
      s.lead.comments = message.trim();
      return { complete: true };
  }
  return { text: "💬 Please continue…" };
}

// ------------------------------------------------------
// 🛍️ Sales Routing
// ------------------------------------------------------
async function handleSalesRouting(message) {
  const lower = message.toLowerCase();

  const routes = [
    { k: ["bar", "pub", "nightclub"], url: "/bar-epos.html", label: "Bar EPOS" },
    { k: ["restaurant"], url: "/hospitality-pos.html", label: "Restaurant EPOS" },
    { k: ["cafe", "coffee"], url: "/cafe-epos.html", label: "Café EPOS" },
    { k: ["hotel"], url: "/hotel-epos.html", label: "Hotel EPOS" },
    { k: ["member", "club"], url: "/members-club-epos.html", label: "Members’ Club EPOS" },
    { k: ["hospital", "health"], url: "/hospital-epos.html", label: "Hospital & Healthcare EPOS" },
    { k: ["retail", "shop", "store"], url: "/retail-pos.html", label: "Retail POS" },
    { k: ["voucher", "gift"], url: "/digital-gift-vouchers.html", label: "GiveaVoucher" },
    { k: ["payment", "tapapay", "card"], url: "/integrated-payments.html", label: "TapaPay Payments" },
    { k: ["hardware", "terminal", "till"], url: "/hardware.html", label: "POS Hardware" },
  ];

  for (const r of routes)
    if (r.k.some((kw) => lower.includes(kw)))
      return `🔗 You might like our <a href='${r.url}' target='_blank'>${r.label}</a> page — it covers that topic in more detail.`;

  return (
    "💬 I can help you find the right solution — just tell me your business type (e.g. café, bar, hotel, retail, hospital).<br><br>" +
    "Or browse all <a href='/products.html' target='_blank'>RST EPOS Products</a> to explore."
  );
}

// ------------------------------------------------------
// 🌐 Root
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`<h1>🚀 Tappy Brain v12.6 is Live</h1><p>Inline Support + Lead Capture Ready</p>`);
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v12.6 (Inline Support + Sales Routing) listening on port ${PORT}`)
);
