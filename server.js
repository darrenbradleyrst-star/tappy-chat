// =========================================
// RST EPOS Smart Chatbot API v14.4 (Enhanced UI Options)
// "Tappy Brain – Sales FAQs Only (Render-safe CORS + Pill Buttons)"
// ✅ Keeps all v14.3c logic intact
// ✅ Adds support for clickable pill options instead of numeric replies
// =========================================

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();
const PORT = process.env.PORT || 3001;
const app = express();

// ------------------------------------------------------
// 📁 Paths
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const faqSalesPath = path.join(__dirname, "faqs_sales.json");
const cacheDir = path.join(__dirname, "cache");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// ------------------------------------------------------
// 🌐 Middleware (Render-safe CORS)
// ------------------------------------------------------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const allowedOrigins = [
  "https://staging.rstepos.com",
  "https://www.rstepos.com",
  "https://tappy-chat.onrender.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Origin",
      allowedOrigins.includes(origin) ? origin : "*"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    return res.status(200).end();
  }
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ------------------------------------------------------
// 🧠 Load FAQs
// ------------------------------------------------------
let faqSales = [];
try {
  if (fs.existsSync(faqSalesPath)) {
    const raw = JSON.parse(fs.readFileSync(faqSalesPath, "utf8"));
    faqSales = raw.filter(
      (f) => f && f.title && (Array.isArray(f.steps) || f.intro)
    );
    console.log(`✅ Loaded ${faqSales.length} Sales FAQ entries`);
  } else {
    console.warn("⚠️ faqs_sales.json not found");
  }
} catch (err) {
  console.error("❌ Failed to load faqs_sales.json:", err);
}

// ------------------------------------------------------
// 🔍 Search helper
// ------------------------------------------------------
function findSalesMatches(message) {
  const lower = (message || "").toLowerCase().trim();
  if (!lower) return [];
  return faqSales.filter((faq) => {
    const text = [
      faq.title || "",
      faq.intro || "",
      ...(Array.isArray(faq.steps) ? faq.steps : [])
    ]
      .join(" ")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ");
    return (
      text.includes(lower) ||
      lower.split(" ").some((w) => w.length > 2 && text.includes(w))
    );
  });
}

// ------------------------------------------------------
// 📘 Render FAQ
// ------------------------------------------------------
function showFAQ(entry) {
  const steps = Array.isArray(entry.steps)
    ? entry.steps.map((s, i) => `${i + 1}. ${s}`).join("<br>")
    : entry.steps;
  const nextPrompt = entry.next
    ? `<br><br>${entry.next.question} (Yes or No)`
    : `<br><br>👉 <a href="${entry.link || "#"}">Learn more</a>`;
  return `📘 <strong>${entry.title}</strong><br>${entry.intro || ""}<br><br>${steps || ""}${nextPrompt}`;
}

// ------------------------------------------------------
// 💬 Chat Handler (Enhanced for Pill Buttons)
// ------------------------------------------------------
const sessions = {};

async function handleSalesFAQ(message, sessionId) {
  if (!sessions[sessionId]) sessions[sessionId] = {};
  const s = sessions[sessionId];
  const lower = (message || "").toLowerCase().trim();

  // ✅ Handle branching yes/no
  if (s.currentId) {
    const currentFAQ = faqSales.find((f) => f.id === s.currentId);
    if (currentFAQ?.next?.options) {
      if (lower.includes("yes")) {
        const nextId = currentFAQ.next.options.yes;
        s.currentId = nextId;
        return showFAQ(faqSales.find((f) => f.id === nextId));
      } else if (lower.includes("no")) {
        const nextId = currentFAQ.next.options.no;
        s.currentId = nextId;
        return showFAQ(faqSales.find((f) => f.id === nextId));
      } else {
        return `${currentFAQ.next.question} (Yes or No)`;
      }
    }
  }

  // ✅ Try to match by exact title first (for pill selections)
  const exactMatch = faqSales.find(
    (f) => f.title && f.title.toLowerCase() === lower
  );
  if (exactMatch) {
    s.currentId = exactMatch.id;
    return showFAQ(exactMatch);
  }

  // ✅ Broader fuzzy search
  const matches = findSalesMatches(message);

  // If fuzzy search returns just one, show it
  if (matches.length === 1) {
    const entry = matches[0];
    s.currentId = entry.id;
    return showFAQ(entry);
  }

  // If too many matches, only show top 8 most relevant (shorten noise)
  if (matches.length > 1) {
    s.awaitingChoice = true;
    s.lastFaqList = matches;

    const trimmed = matches.slice(0, 8);
    const options = trimmed.map((m, i) => ({
      label: m.title,
      index: i + 1
    }));

    return {
      type: "options",
      intro: "🔍 I found several possible matches:",
      options
    };
  }

  // No matches at all
  return `🙁 I couldn’t find an exact match.<br><br>Would you like to <a href="/contact-us.html">contact sales</a> or <a href="/faqs.html">browse FAQs</a>?`;
}


// ------------------------------------------------------
// 🔗 Endpoints
// ------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  let sessionId =
    req.cookies.sessionId || Math.random().toString(36).substring(2, 10);
  res.cookie("sessionId", sessionId, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 1000 * 60 * 30
  });

  try {
    const reply = await handleSalesFAQ(message, sessionId);

    // ✅ Send structured response safely
    if (typeof reply === "object" && reply.type === "options") {
      res.json({ reply });
    } else {
      res.json({ reply });
    }
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

app.get("/test", (req, res) => {
  const q = req.query.q || "hardware";
  const result = findSalesMatches(q);
  res.json({
    query: q,
    matches: result.map((f) => f.title),
    count: result.length
  });
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: "14.4",
    mode: "Sales FAQ Only + Pill Buttons",
    faqs: faqSales.length,
    time: new Date().toISOString()
  });
});

// ------------------------------------------------------
// 🚀 Start Server
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v14.4 (Sales FAQ Only + Pill Buttons) running on port ${PORT}`)
);
