// =========================================
// RST EPOS Smart Chatbot API v14.9
// "Tappy Brain – Sales FAQs Only (Ranked Search + Yes/No Pills + Branching)"
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
  } else console.warn("⚠️ faqs_sales.json not found");
} catch (err) {
  console.error("❌ Failed to load faqs_sales.json:", err);
}

// ------------------------------------------------------
// 🔍 Weighted search (≥6) + debug logging
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

  if (scored.length) {
    console.log(
      `🔍 "${query}" → ${scored.length} matches:`,
      scored
        .slice(0, 5)
        .map((r) => `${r.faq.title} (${r.score})`)
        .join(", ")
    );
  } else console.log(`🔍 "${query}" → no strong matches`);

  return scored.map((r) => r.faq);
}

// ------------------------------------------------------
// 📘 Render FAQ (returns HTML or structured yes/no)
// ------------------------------------------------------
function showFAQ(entry) {
  const steps = Array.isArray(entry.steps)
    ? entry.steps.map((s, i) => `${i + 1}. ${s}`).join("<br>")
    : entry.steps || "";

  if (entry.next?.question) {
    // Structured yes/no for pills
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
// 💬 Chat handler (exact match + ranked search + branching)
// ------------------------------------------------------
const sessions = {};

async function handleSalesFAQ(message, sessionId) {
  if (!sessions[sessionId]) sessions[sessionId] = {};
  const s = sessions[sessionId];
  const lower = (message || "").toLowerCase().trim();

  // ✅ yes/no branching
  if (s.currentId) {
    const currentFAQ = faqSales.find((f) => f.id === s.currentId);
    if (currentFAQ?.next?.options) {
      let nextTarget = null;
      if (lower.includes("yes")) nextTarget = currentFAQ.next.options.yes;
      else if (lower.includes("no")) nextTarget = currentFAQ.next.options.no;

      if (nextTarget) {
        // numeric id
        if (typeof nextTarget === "number") {
          const nextFAQ = faqSales.find((f) => f.id === nextTarget);
          if (nextFAQ) {
            s.currentId = nextFAQ.id;
            console.log(`↪️ Branch → FAQ ${nextFAQ.id}: ${nextFAQ.title}`);
            return showFAQ(nextFAQ);
          }
        }

        // string id/title/url
        if (typeof nextTarget === "string") {
          const nextFAQ =
            faqSales.find((f) => f.id === nextTarget) ||
            faqSales.find(
              (f) =>
                f.title?.toLowerCase() === nextTarget.toLowerCase() ||
                String(f.id) === nextTarget
            );
          if (nextFAQ) {
            s.currentId = nextFAQ.id;
            console.log(`↪️ Branch → FAQ: ${nextFAQ.title}`);
            return showFAQ(nextFAQ);
          }

          if (/^https?:\/\//.test(nextTarget) || nextTarget.endsWith(".html")) {
            console.log(`🌐 Branch → external: ${nextTarget}`);
            return `👉 <a href="${nextTarget}" target="_blank">Open related page</a>`;
          }
        }
      }
      return `${currentFAQ.next.question} (Yes or No)`;
    }
  }

  // ✅ exact title
  const normalise = (t) =>
    (t || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
  const exact = faqSales.find((f) => normalise(f.title) === normalise(lower));
  if (exact) {
    s.currentId = exact.id;
    console.log(`🎯 Exact: ${exact.title}`);
    return showFAQ(exact);
  }

  // ✅ weighted search
  const matches = findSalesMatches(message);
  if (matches.length === 1) {
    const m = matches[0];
    s.currentId = m.id;
    console.log(`🎯 Single: ${m.title}`);
    return showFAQ(m);
  }

  if (matches.length > 1) {
    s.awaitingChoice = true;
    s.lastFaqList = matches;
    const trimmed = matches.slice(0, 8);
    const options = trimmed.map((m, i) => ({
      label: m.title,
      index: i + 1,
    }));
    console.log(`🧩 ${matches.length} matches → showing ${options.length}`);
    return { type: "options", intro: "🔍 I found several possible matches:", options };
  }

  console.log(`🙁 No match for "${message}"`);
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
    maxAge: 1000 * 60 * 30,
  });

  try {
    const reply = await handleSalesFAQ(message, sessionId);
    if (typeof reply === "object" && (reply.type === "options" || reply.type === "yesno"))
      res.json({ reply });
    else res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

app.get("/test", (req, res) => {
  const q = req.query.q || "hardware";
  const result = findSalesMatches(q);
  res.json({ query: q, matches: result.map((f) => f.title), count: result.length });
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: "14.9",
    mode: "Sales FAQ + Ranked Search + Yes/No Pills + Branching",
    faqs: faqSales.length,
    time: new Date().toISOString(),
  });
});

// ------------------------------------------------------
// 🚀 Start server
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v14.9 running on port ${PORT}`)
);
