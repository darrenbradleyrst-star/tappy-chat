// =========================================
// RST EPOS Smart Chatbot API v12.5 ("Tappy Brain + Agentic Context + Lead Capture + Follow-up")
// ✅ Support mode: clickable FAQ links + follow-up question
// ✅ Sales mode: improved keyword routing (bar, cafe, hotel, members, etc.)
// ✅ Lead capture (Name → Company → Email → Comments)
// =========================================

import express from "express";
import OpenAI from "openai";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import xml2js from "xml2js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();
const PORT = process.env.PORT || 3001;
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------------------------------------------
// 📁 Setup
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, "cache");
const salesLeadsPath = path.join(__dirname, "sales_leads.jsonl");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// ------------------------------------------------------
// 🌐 Middleware
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
// 📚 Load FAQs
// ------------------------------------------------------
const faqsSupportPath = path.join(__dirname, "faqs_support.json");
let faqsSupport = [];
try {
  if (fs.existsSync(faqsSupportPath))
    faqsSupport = JSON.parse(fs.readFileSync(faqsSupportPath, "utf8"));
  console.log(`✅ Loaded ${faqsSupport.length} support FAQ entries`);
} catch (err) {
  console.error("❌ Failed to load faqs_support.json:", err);
}

// ------------------------------------------------------
// 🧾 Utility
// ------------------------------------------------------
const logJSON = (file, data) =>
  fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...data }) + "\n");
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

// ------------------------------------------------------
// 💬 Chat Route
// ------------------------------------------------------
const sessions = {};

app.post("/api/chat", async (req, res) => {
  const { message, context, reset } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  if (reset) {
    sessions[ip] = { step: "none", mode: "general", lead: {} };
    return res.json({ reply: "Session reset OK." });
  }

  if (!message) return res.status(400).json({ error: "No message provided" });
  if (!sessions[ip]) sessions[ip] = { step: "none", mode: context || "general", lead: {} };
  const s = sessions[ip];
  const lower = message.toLowerCase().trim();

  try {
    // ✅ Handle universal commands
    if (["restart", "new question", "start over"].includes(lower)) {
      s.step = "none";
      return res.json({ reply: "✅ No problem — please type your new question below." });
    }

    // ✅ Support mode follow-up
    if (s.step === "support_followup") {
      if (["yes", "yep", "yeah", "sorted"].includes(lower)) {
        s.step = "none";
        return res.json({ reply: "✅ Glad to hear that!" });
      }
      if (["no", "nope", "not yet", "still broken"].includes(lower)) {
        s.step = "none";
        return res.json({
          reply: "😕 No problem — please describe what’s still not working, and I’ll try to help.",
        });
      }
    }

    // 🟣 Support / General Mode
    if (context === "support" || context === "general") {
      const matches = findSupportMatches(message);
      if (matches.length === 1) {
        s.step = "support_followup";
        const url =
          matches[0].url ||
          `https://support.rstepos.com/article/${encodeURIComponent(
            matches[0].title.toLowerCase().replace(/\s+/g, "-")
          )}`;
        return res.json({
          reply: `🔗 I think this article might help:<br><a href="${url}" target="_blank" style="color:#0b79b7;">${matches[0].title}</a><br><br>Did this resolve your issue or is there something else I can help with?`,
        });
      }

      if (matches.length > 1) {
        const links = matches
          .map(
            (m) =>
              `<a href="${
                m.url ||
                `https://support.rstepos.com/article/${encodeURIComponent(
                  m.title.toLowerCase().replace(/\s+/g, "-")
                )}`
              }" target="_blank" style="display:block;margin:4px 0;color:#0b79b7;">${m.title}</a>`
          )
          .join("");
        s.step = "support_followup";
        return res.json({
          reply: `🔍 I found several articles that might help:<br>${links}<br>Did one of these resolve your issue?`,
        });
      }

      return res.json({
        reply:
          "🤔 I’m not sure about that one yet — can you describe the issue in more detail? I’ll pass it to support if needed.",
      });
    }

    // 🟢 Sales Mode (with lead capture)
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

      const reply = await handleSalesAgent(message);
      return res.json({ reply });
    }
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ------------------------------------------------------
// 🧩 Lead Capture Helper
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
// 🧠 Support FAQ Finder
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
        url: entry.url || null,
        answers: entry.answers,
      });
  }
  return results.slice(0, 5);
}

// ------------------------------------------------------
// 🛍️ Improved Sales Routing
// ------------------------------------------------------
async function handleSalesAgent(message) {
  const lower = message.toLowerCase();

  // Strong keyword routing
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
      return `🔗 You might like our <a href='${r.url}'>${r.label}</a> page — it covers that topic in more detail.`;

  return (
    "💬 I can help you find the right solution — just tell me your business type (e.g. café, bar, hotel, retail, hospital).<br><br>" +
    "Or browse all <a href='/products.html'>RST EPOS Products</a> to explore."
  );
}

// ------------------------------------------------------
// 🌐 Root
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`<h1>🚀 Tappy Brain v12.5 Live</h1><p>Support follow-up + Sales routing active.</p>`);
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v12.5 listening on port ${PORT}`)
);
