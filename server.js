// =========================================
// RST EPOS Smart Chatbot API v15.1c
// "Tappy Brain – Sales FAQs Only (Ranked Search + Yes/No Pills + Reliable Branching)"
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
// 🌐 Render-safe CORS
// ------------------------------------------------------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const allowedOrigins = [
  "https://www.rstepos.com",
  "https://staging.rstepos.com",
  "https://tappy-chat.onrender.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
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
  next();
});

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, true);
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
    faqSales = raw
      .filter((f) => f && f.title && (Array.isArray(f.steps) || f.intro))
      .map((f) => ({ ...f, id: String(f.id) }));
    console.log(`✅ Loaded ${faqSales.length} Sales FAQ entries`);
  } else console.warn("⚠️ faqs_sales.json not found");
} catch (err) {
  console.error("❌ Failed to load faqs_sales.json:", err);
}

// ------------------------------------------------------
// 🔍 Weighted search
// ------------------------------------------------------
function findSalesMatches(message) {
  const query = (message || "").toLowerCase().trim();
  if (!query) return [];

  const scored = faqSales
    .map((faq) => {
      const text = [
        faq.title || "",
        faq.intro || "",
        ...(Array.isArray(faq.steps) ? faq.steps : []),
      ]
        .join(" ")
        .toLowerCase();

      let score = 0;
      if (faq.title.toLowerCase() === query) score += 10;
      if (text.includes(query)) score += 6;
      const words = query.split(/\s+/).filter((w) => w.length > 2);
      words.forEach((w) => {
        const count = (text.match(new RegExp(`\\b${w}\\b`, "g")) || []).length;
        score += count * 2;
      });
      return { faq, score };
    })
    .filter((r) => r.score >= 6)
    .sort((a, b) => b.score - a.score);

  return scored.map((r) => ({ ...r.faq, score: r.score }));
}

// ------------------------------------------------------
// 📘 Render FAQ
// ------------------------------------------------------
function showFAQ(entry) {
  const steps = Array.isArray(entry.steps)
    ? entry.steps.map((s, i) => `${i + 1}. ${s}`).join("<br>")
    : entry.steps || "";

  if (entry.next?.question) {
    return {
      type: "yesno",
      title: entry.title,
      intro: entry.intro || "",
      steps,
      question: entry.next.question,
    };
  }

  const nextPrompt = entry.next
    ? `<br><br>${entry.next.question} (Yes or No)`
    : `<br><br>👉 <a href="${entry.link || "#"}">Learn more</a>`;
  return `📘 <strong>${entry.title}</strong><br>${entry.intro || ""}<br><br>${steps}${nextPrompt}`;
}

// ------------------------------------------------------
// 💬 Chat Handler (Reliable Branch + 90% Confidence)
// ------------------------------------------------------
const sessions = {};

async function handleSalesFAQ(message, sessionId) {
  if (!sessions[sessionId]) sessions[sessionId] = {};
  const s = sessions[sessionId];
  const lower = (message || "").toLowerCase().trim();

  // ✅ 1. Handle Yes/No branching
  if (s.currentId) {
    const currentFAQ = faqSales.find((f) => f.id === String(s.currentId));
    if (currentFAQ?.next?.options) {
      let nextTarget = null;
      if (lower.includes("yes")) nextTarget = currentFAQ.next.options.yes;
      else if (lower.includes("no")) nextTarget = currentFAQ.next.options.no;

      console.log(`🧭 Branch from ${s.currentId} (${currentFAQ.title}) → ${lower.toUpperCase()} → ${nextTarget}`);

      if (nextTarget) {
        const targetId = String(nextTarget).trim();

        // Try ID match first
        let nextFAQ = faqSales.find((f) => f.id === targetId);

        // Fallback: match by title if the nextTarget is a string title
        if (!nextFAQ) {
          nextFAQ = faqSales.find(
            (f) => f.title.toLowerCase().trim() === targetId.toLowerCase()
          );
        }

        // Fallback: external URL
        if (!nextFAQ && targetId.includes(".html")) {
          console.log(`🌐 Branch external → ${targetId}`);
          return `👉 <a href="${targetId}" target="_blank">View related page</a>`;
        }

        if (nextFAQ) {
          s.currentId = nextFAQ.id;
          console.log(`✅ Branch success → ${nextFAQ.id}: ${nextFAQ.title}`);
          return showFAQ(nextFAQ);
        }

        console.warn(`⚠️ Branch target "${targetId}" not found`);
        return `${currentFAQ.next.question} (Yes or No)`;
      }
    }
  }

  // ✅ 2. Exact title match
  const normalise = (t) => (t || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
  const exact = faqSales.find((f) => normalise(f.title) === normalise(lower));
  if (exact) {
    s.currentId = exact.id;
    console.log(`🎯 Exact match: ${exact.title}`);
    return showFAQ(exact);
  }

  // ✅ 3. Weighted search
  const scored = findSalesMatches(message);
  if (!scored.length) {
    console.log(`🙁 No matches for "${message}"`);
    return `🙁 I couldn’t find an exact match.<br><br>Would you like to <a href="/contact-us.html">contact sales</a> or <a href="/faqs.html">browse FAQs</a>?`;
  }

  // ✅ 4. High-confidence (≥90%)
  if (scored.length > 1) {
    const top = scored[0].score;
    const next = scored[1]?.score || 0;
    const confidence = next ? top / next : 1;
    if (confidence >= 1.9 || top >= 12) {
      const entry = scored[0];
      s.currentId = entry.id;
      console.log(`🤖 Auto-selected high-confidence: ${entry.title}`);
      return showFAQ(entry);
    }
  }

  // ✅ 5. Single strong match
  if (scored.length === 1) {
    const entry = scored[0];
    s.currentId = entry.id;
    console.log(`🎯 Single match: ${entry.title}`);
    return showFAQ(entry);
  }

  // ✅ 6. Multi-match → pill options
  const trimmed = scored.slice(0, 8);
  const options = trimmed.map((m, i) => ({ label: m.title, index: i + 1 }));
  console.log(`🧩 Multiple matches (${scored.length})`);
  return { type: "options", intro: "🔍 I found several possible matches:", options };
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
    maxAge: 1000 * 60 * 30,
  });

  try {
    const reply = await handleSalesFAQ(message, sessionId);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

app.get("/", (req, res) =>
  res.json({
    status: "ok",
    version: "15.1c",
    mode: "Sales FAQ + Ranked + Branching + 90% Confidence",
    faqs: faqSales.length,
    time: new Date().toISOString(),
  })
);

// ------------------------------------------------------
// 🚀 Start Server
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v15.1c running on port ${PORT}`)
);
