// =========================================
// RST EPOS Smart Chatbot API v14.3c (Stable)
// "Tappy Brain – Sales FAQs Only (Render-safe CORS)"
// ✅ Keeps all prior working logic
// ✅ Uses faqs_sales.json
// ✅ Fixes 502 preflight via fallback wildcard
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
const faqSalesPath = path.join(__dirname, "faqs_sales.json"); // ✅ updated filename
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

// ✅ Universal preflight handler (Render-safe)
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

// ✅ Add CORS middleware as a second layer
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, true); // fallback wildcard for Render
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
// 💬 Chat Handler
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

  // ✅ Match search
  const matches = findSalesMatches(message);
  if (matches.length === 1) {
    const entry = matches[0];
    s.currentId = entry.id;
    return showFAQ(entry);
  }
  if (matches.length > 1) {
    s.awaitingChoice = true;
    s.lastFaqList = matches;
    const numbered = matches.map((m, i) => `${i + 1}. ${m.title}`).join("<br>");
    return `🔍 I found several matches:<br><br>${numbered}<br><br>Reply with a number.`;
  }

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
    res.json({ reply });
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
    version: "14.3c",
    mode: "Sales FAQ Only",
    faqs: faqSales.length,
    time: new Date().toISOString()
  });
});

// ------------------------------------------------------
// 🚀 Start Server
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v14.3c (Sales FAQ Only) running on port ${PORT}`)
);
