// =========================================
// RST EPOS Smart Chatbot API v14.3
// "Tappy Brain – Sales FAQs Only (Full JSON Matching)"
// ✅ Render-safe CORS (fixes 502 preflight)
// ✅ Loads faq_sales.json only
// ✅ Searches title, intro, and steps (no keywords needed)
// ✅ Supports branching logic ("next" → yes/no)
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
const faqSalesPath = path.join(__dirname, "faq_sales.json");
const cacheDir = path.join(__dirname, "cache");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// ------------------------------------------------------
// 🌐 Middleware (Render-safe CORS + Preflight Fix)
// ------------------------------------------------------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Allowed origins
const allowedOrigins = [
  "https://staging.rstepos.com",
  "https://www.rstepos.com",
  "https://tappy-chat.onrender.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

// 1️⃣ — Early Preflight Response
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    return res.status(200).end();
  }
  next();
});

// 2️⃣ — Standard CORS
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    optionsSuccessStatus: 200
  })
);

// 3️⃣ — Debug Log
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.path} from ${req.headers.origin || "unknown"}`);
  next();
});

// 4️⃣ — Rate Limiter
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    message: { error: "Rate limit exceeded — please wait a moment." }
  })
);

// ------------------------------------------------------
// 🧾 Hardcoded Site Pages (for future AI use)
// ------------------------------------------------------
const sitePages = [
  "https://staging.rstepos.com/back-office-software.html",
  "https://staging.rstepos.com/bar-pos.html",
  "https://staging.rstepos.com/bakery-pos.html",
  "https://staging.rstepos.com/restaurant-pos.html",
  "https://staging.rstepos.com/cafe-coffee-shop-pos.html",
  "https://staging.rstepos.com/hotel-pos.html",
  "https://staging.rstepos.com/retail-pos.html",
  "https://staging.rstepos.com/members-clubs-pos.html",
  "https://staging.rstepos.com/school-education-university-pos.html",
  "https://staging.rstepos.com/hospital-clinic-pos.html",
  "https://staging.rstepos.com/hardware.html",
  "https://staging.rstepos.com/book-a-demo.html",
  "https://staging.rstepos.com/contact-us.html"
];

// ------------------------------------------------------
// 📚 Load Sales FAQs
// ------------------------------------------------------
let faqSales = [];
try {
  if (fs.existsSync(faqSalesPath)) {
    const raw = JSON.parse(fs.readFileSync(faqSalesPath, "utf8"));
    faqSales = raw.filter(
      (f) => f && f.title && (Array.isArray(f.steps) || f.intro)
    );
    console.log(`✅ Loaded ${faqSales.length} Sales FAQ entries`);
  } else console.warn("⚠️ faq_sales.json not found");
} catch (err) {
  console.error("❌ Failed to load faq_sales.json:", err);
}

// ------------------------------------------------------
// 🧠 Helper: Find FAQ Matches (by title, intro, steps)
// ------------------------------------------------------
function findSalesMatches(message) {
  const lower = (message || "").toLowerCase();

  return faqSales.filter((faq) => {
    const blob = [
      faq.title || "",
      faq.intro || "",
      ...(Array.isArray(faq.steps) ? faq.steps : [])
    ]
      .join(" ")
      .toLowerCase();

    // Broad fuzzy match: entire phrase or any word
    return (
      blob.includes(lower) ||
      lower.split(" ").some((word) => blob.includes(word))
    );
  });
}

// ------------------------------------------------------
// 📘 Render FAQ Response
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
// 🧩 Sales FAQ Handler
// ------------------------------------------------------
const sessions = {};

async function handleSalesFAQ(message, sessionId) {
  if (!sessions[sessionId]) sessions[sessionId] = {};
  const s = sessions[sessionId];
  const lower = (message || "").toLowerCase().trim();

  // 1️⃣ — Handle branching “Yes/No” logic
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

  // 2️⃣ — Find matching FAQs
  const matches = findSalesMatches(message);

  if (matches.length === 1) {
    const entry = matches[0];
    s.currentId = entry.id;
    return showFAQ(entry);
  }

  if (matches.length > 1) {
    s.awaitingChoice = true;
    s.lastFaqList = matches;
    const numbered = matches
      .map((m, i) => `${i + 1}. ${m.title || "FAQ"}`)
      .join("<br>");
    return `🔍 I found several possible matches:<br><br>${numbered}<br><br>Please reply with the number you'd like to view.`;
  }

  return `🙁 I couldn’t find an exact match.<br><br>Would you like to <a href="/contact-us.html">contact sales</a> or <a href="/faqs.html">browse FAQs</a>?`;
}

// ------------------------------------------------------
// 💬 Chat Endpoint (Sales FAQ Only)
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
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ------------------------------------------------------
// 🌐 Root Check
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: "14.3",
    mode: "Sales FAQ Only",
    faqs: faqSales.length,
    pages: sitePages.length,
    message: "Tappy Brain: Sales FAQ JSON only (full matching)",
    time: new Date().toISOString()
  });
});

// ------------------------------------------------------
// 🚀 Start Server
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v14.3 (Sales FAQ Only) running on port ${PORT}`)
);
