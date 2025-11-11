// =========================================
// RST EPOS Smart Chatbot API v13.4c
// "Tappy Brain + Hybrid Context Router + Lead Capture"
// ✅ Supports 'questions' or 'keywords' FAQ JSON formats
// ✅ Safe fallback for missing titles
// ✅ Maintains all features of v13.4a
// =========================================

import express from "express";
import OpenAI from "openai";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
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
// 📁 Paths + Cache Setup
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, "cache");
const salesLeadsPath = path.join(__dirname, "sales_leads.jsonl");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// ------------------------------------------------------
// 🌐 Express / CORS / Cookies / Rate Limit
// ------------------------------------------------------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  cors({
    origin: [
      "https://www.rstepos.com",
      "https://staging.rstepos.com",
      "https://tappy-chat.onrender.com",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  })
);

// ✅ Explicit CORS Preflight Handler
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Credentials", "true");
  return res.sendStatus(200);
});

// Log requests (optional)
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.path} from ${req.headers.origin || "unknown origin"}`);
  next();
});

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    message: { error: "Rate limit exceeded — please wait a moment." },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ------------------------------------------------------
// 🧾 Utilities
// ------------------------------------------------------
const logJSON = (file, data) =>
  fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...data }) + "\n");

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

// ------------------------------------------------------
// 📚 Load Support FAQs (supports 'questions' and 'keywords')
// ------------------------------------------------------
const faqsSupportPath = path.join(__dirname, "faqs_support.json");
let faqsSupport = [];
try {
  if (fs.existsSync(faqsSupportPath)) {
    const raw = JSON.parse(fs.readFileSync(faqsSupportPath, "utf8"));
    faqsSupport = raw.filter(
      (f) =>
        f &&
        (Array.isArray(f.questions) || Array.isArray(f.keywords)) &&
        Array.isArray(f.answers) &&
        f.answers.length
    );
    const invalidCount = raw.length - faqsSupport.length;
    console.log(
      `✅ Loaded ${faqsSupport.length} valid FAQ entries${
        invalidCount > 0 ? ` (${invalidCount} invalid skipped)` : ""
      }`
    );
  } else {
    console.warn("⚠️ faqs_support.json not found");
  }
} catch (err) {
  console.error("❌ Failed to load faqs_support.json:", err);
}

// ------------------------------------------------------
// 🧠 Support Search + Selection
// ------------------------------------------------------
function findSupportMatches(message) {
  const lower = (message || "").toLowerCase();
  return faqsSupport.filter((faq) => {
    if (!faq) return false;
    const title = faq.title ? faq.title.toLowerCase() : "";
    const keywords = Array.isArray(faq.keywords)
      ? faq.keywords
      : Array.isArray(faq.questions)
      ? faq.questions
      : [];
    return (
      title.includes(lower) ||
      keywords.some((k) => typeof k === "string" && lower.includes(k.toLowerCase()))
    );
  });
}

async function handleSupportAgent(message, sessionId) {
  const s = sessions[sessionId] || {};
  const matches = findSupportMatches(message);

  if (s.awaitingFaqChoice && /^\d+$/.test(message.trim())) {
    const idx = parseInt(message.trim(), 10) - 1;
    const list = s.lastFaqList || [];
    if (list[idx]) {
      const entry = list[idx];
      s.awaitingFaqChoice = false;
      s.lastFaqList = null;
      const title = entry.title || entry.questions?.[0] || "Help Article";
      return `📘 *${title}*<br>${entry.answers.join("<br>")}<br><br>Did that resolve your issue?`;
    }
  }

  if (matches.length === 1) {
    const m = matches[0];
    const title = m.title || m.questions?.[0] || "Help Article";
    return `📘 *${title}*<br>${m.answers.join("<br>")}<br><br>Did that resolve your issue?`;
  }

  if (matches.length > 1) {
    s.awaitingFaqChoice = true;
    s.lastFaqList = matches;
    const numbered = matches
      .map((m, i) => `${i + 1}. ${m.title || m.questions?.[0] || "Help Article"}`)
      .join("<br>");
    return `🔍 I found several possible matches:<br><br>${numbered}<br><br>Please reply with the number of the article you'd like to view.`;
  }

  return "🤔 I’m not sure about that one — can you describe the issue in more detail?";
}

// ------------------------------------------------------
// 🛍️ Sales Mode
// ------------------------------------------------------
async function handleSalesAgent(message) {
  const lower = message.toLowerCase();
  const quick = [
    { k: ["restaurant", "bar", "cafe"], r: "/hospitality-pos.html", l: "Hospitality EPOS" },
    { k: ["retail", "shop", "store"], r: "/retail-pos.html", l: "Retail POS" },
    { k: ["voucher", "gift"], r: "/digital-gift-vouchers.html", l: "GiveaVoucher" },
    { k: ["payment", "tapapay", "card"], r: "/integrated-payments.html", l: "TapaPay Payments" },
    { k: ["hardware", "terminal", "till"], r: "/hardware.html", l: "POS Hardware" },
  ];

  for (const q of quick)
    if (q.k.some((kw) => lower.includes(kw)))
      return `🔗 You might like our <a href='${q.r}'>${q.l}</a> page — it covers that topic in more detail.`;

  return "💬 Tell me what type of business you run (e.g. café, bar, retail), and I’ll show you the best solution.";
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
        return { text: "⚠️ That email doesn’t look right — please re-enter it." };
      s.lead.email = message.trim();
      s.step = "comments";
      return {
        text: "📝 Great — any specific notes or requirements for your quote? e.g. number of terminals, printers, or card machines?",
      };
    case "comments":
      s.lead.comments = message.trim();
      return { complete: true };
    default:
      return { text: "💬 Please continue…" };
  }
}

// ------------------------------------------------------
// 💬 Chat Route
// ------------------------------------------------------
const sessions = {};

app.post("/api/chat", async (req, res) => {
  const { message, context, reset } = req.body;
  let sessionId = req.cookies.sessionId;

  if (!sessionId) {
    sessionId = Math.random().toString(36).substring(2, 10);
    res.cookie("sessionId", sessionId, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 30,
    });
  }

  if (reset) {
    sessions[sessionId] = { step: "none", module: "General", lead: {} };
    return res.json({ reply: "Session reset OK." });
  }

  if (!message) return res.status(400).json({ error: "No message provided" });
  if (!sessions[sessionId]) sessions[sessionId] = { step: "none", module: "General", lead: {} };

  const s = sessions[sessionId];
  const lower = (message || "").toLowerCase().trim();

  try {
    if (["restart", "new question"].includes(lower))
      return res.json({ reply: "✅ No problem — please type your new question below." });

    if (["end", "exit", "close"].includes(lower))
      return res.json({ reply: "👋 Thanks for chatting! Talk soon." });

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
      const reply = await handleSalesAgent(message);
      return res.json({ reply });
    }

    if (context === "support") {
      const reply = await handleSupportAgent(message, sessionId);
      return res.json({ reply });
    }

    return res.json({
      reply:
        "🤔 I couldn’t find that in our site or help articles — could you tell me a bit more? If it’s urgent, you can reach us at <a href='/contact-us.html'>Contact Us</a>.",
    });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ------------------------------------------------------
// 🌐 Root + Health Check
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: "13.4c",
    name: "Tappy Brain API",
    message: "Now supports 'questions' or 'keywords' in FAQ JSON files.",
    time: new Date().toISOString(),
  });
});

// ------------------------------------------------------
// 🚀 Start Server
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v13.4c listening on port ${PORT}`)
);
