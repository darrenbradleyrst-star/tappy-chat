// =========================================
// RST EPOS Smart Chatbot API v15.2
// "Tappy Brain – Persistent Sessions + Reliable Branching + 90% Confidence"
// =========================================

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();
const PORT = process.env.PORT || 3001;
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const faqSalesPath = path.join(__dirname, "faqs_sales.json");
const cacheDir = path.join(__dirname, "cache");
const sessionFile = path.join(cacheDir, "sessions.json");

if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "{}");

// ------------------------------------------------------
// 🌐 Render-safe CORS
// ------------------------------------------------------
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.set("trust proxy", 1);

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
  })
);

// ------------------------------------------------------
// 🧠 Load FAQs
// ------------------------------------------------------
let faqSales = [];
if (fs.existsSync(faqSalesPath)) {
  faqSales = JSON.parse(fs.readFileSync(faqSalesPath, "utf8"))
    .filter((f) => f && f.title)
    .map((f) => ({ ...f, id: String(f.id) }));
  console.log(`✅ Loaded ${faqSales.length} Sales FAQ entries`);
}

// ------------------------------------------------------
// 🧠 Simple persistent session cache
// ------------------------------------------------------
function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(sessionFile, JSON.stringify(sessions, null, 2));
}

function getSession(id) {
  const sessions = loadSessions();
  return sessions[id] || {};
}

function updateSession(id, data) {
  const sessions = loadSessions();
  sessions[id] = { ...(sessions[id] || {}), ...data };
  saveSessions(sessions);
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
  return `📘 <strong>${entry.title}</strong><br>${entry.intro ||
    ""}<br><br>${steps}<br><br>👉 <a href="${entry.link || "#"}">Learn more</a>`;
}

// ------------------------------------------------------
// 💬 Chat Handler (Persistent Branch Fix)
// ------------------------------------------------------
async function handleSalesFAQ(message, sessionId) {
  const session = getSession(sessionId);
  const lower = (message || "").toLowerCase().trim();

  // ✅ 1. Handle Yes/No branch with persistent memory
  if (session.currentId) {
    const currentFAQ = faqSales.find((f) => f.id === String(session.currentId));
    if (currentFAQ?.next?.options) {
      let nextTarget = null;
      if (lower.includes("yes")) nextTarget = currentFAQ.next.options.yes;
      else if (lower.includes("no")) nextTarget = currentFAQ.next.options.no;

      if (nextTarget) {
        const nextFAQ = faqSales.find(
          (f) => String(f.id) === String(nextTarget)
        );
        if (nextFAQ) {
          updateSession(sessionId, { currentId: nextFAQ.id });
          console.log(`✅ Branch success: ${lower.toUpperCase()} → ${nextFAQ.title}`);
          return showFAQ(nextFAQ);
        }

        if (typeof nextTarget === "string" && nextTarget.includes(".html")) {
          return `👉 <a href="${nextTarget}" target="_blank">View related page</a>`;
        }
      }
    }
  }

  // ✅ 2. Exact title match
  const normalise = (t) =>
    (t || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
  const exact = faqSales.find((f) => normalise(f.title) === normalise(lower));
  if (exact) {
    updateSession(sessionId, { currentId: exact.id });
    return showFAQ(exact);
  }

  // ✅ 3. Weighted search
  const scored = faqSales
    .map((f) => {
      const text = [
        f.title,
        f.intro,
        ...(Array.isArray(f.steps) ? f.steps : []),
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      if (f.title.toLowerCase() === lower) score += 10;
      if (text.includes(lower)) score += 6;
      const words = lower.split(/\s+/).filter((w) => w.length > 2);
      words.forEach((w) => {
        const count = (text.match(new RegExp(`\\b${w}\\b`, "g")) || []).length;
        score += count * 2;
      });
      return { f, score };
    })
    .filter((r) => r.score >= 6)
    .sort((a, b) => b.score - a.score);

  if (!scored.length)
    return `🙁 I couldn’t find an exact match.<br><br>Would you like to <a href="/contact-us.html">contact sales</a> or <a href="/faqs.html">browse FAQs</a>?`;

  // ✅ 4. Auto-select 90% confidence
  if (scored.length > 1) {
    const top = scored[0].score;
    const next = scored[1]?.score || 0;
    const confidence = next ? top / next : 1;
    if (confidence >= 1.9 || top >= 12) {
      const entry = scored[0].f;
      updateSession(sessionId, { currentId: entry.id });
      return showFAQ(entry);
    }
  }

  // ✅ 5. Single match
  if (scored.length === 1) {
    const entry = scored[0].f;
    updateSession(sessionId, { currentId: entry.id });
    return showFAQ(entry);
  }

  // ✅ 6. Multi-match → pill options
  const trimmed = scored.slice(0, 8);
  const options = trimmed.map((m) => ({ label: m.f.title }));
  return { type: "options", intro: "🔍 I found several possible matches:", options };
}

// ------------------------------------------------------
// 🔗 Endpoint
// ------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  const sessionId =
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
    res.status(500).json({ error: "Chat unavailable" });
  }
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v15.2 running on port ${PORT}`)
);
