// =========================================
// RST EPOS Smart Chatbot API v14.0
// "Tappy Brain + Local HTML Index + FAQ + AI Fallback"
// ✅ Reads local HTML files from /pages/
// ✅ Full FAQ + AI fallback
// ✅ All links stay in same tab
// =========================================

import express from "express";
import OpenAI from "openai";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { fileURLToPath } from "url";

dotenv.config();
const PORT = process.env.PORT || 3001;
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------------------------------------------
// 📁 Paths
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pagesDir = path.join(__dirname, "pages"); // where all your .html files live
const faqsSupportPath = path.join(__dirname, "faqs_support.json");

// ------------------------------------------------------
// 🌐 Middleware
// ------------------------------------------------------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(
  cors({
    origin: [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "https://staging.rstepos.com",
      "https://www.rstepos.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  })
);
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    message: { error: "Rate limit exceeded — please wait a moment." },
  })
);

// ------------------------------------------------------
// 🧾 Load all local HTML pages
// ------------------------------------------------------
const sitePages = fs
  .readdirSync(pagesDir)
  .filter((f) => f.endsWith(".html"))
  .map((f) => path.join(pagesDir, f));

console.log(`✅ Loaded ${sitePages.length} local pages from /pages`);

// ------------------------------------------------------
// 📚 Load Support FAQs
// ------------------------------------------------------
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
    console.log(`✅ Loaded ${faqsSupport.length} FAQ entries`);
  } else {
    console.warn("⚠️ faqs_support.json not found");
  }
} catch (err) {
  console.error("❌ Failed to load faqs_support.json:", err);
}

// ------------------------------------------------------
// 🧠 Helper: Find FAQ Matches
// ------------------------------------------------------
function findSupportMatches(message) {
  const lower = (message || "").toLowerCase();
  return faqsSupport.filter((faq) => {
    const list = faq.questions || faq.keywords || [];
    return list.some((q) => q.toLowerCase().includes(lower) || lower.includes(q.toLowerCase()));
  });
}

// ------------------------------------------------------
// 🧠 Analyze Local HTML Page with OpenAI
// ------------------------------------------------------
async function analyzeLocalPage(filePath, query) {
  try {
    const html = fs.readFileSync(filePath, "utf8");
    const $ = cheerio.load(html);
    $("script,style,nav,footer,header").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);

    const prompt = `
You are a helpful assistant for RST EPOS.
A user asked about: "${query}"

Here is the page content:

${text}

Determine if this page answers the user's query.
If yes, summarise it in 2–3 short sentences.
If not relevant, reply "NO_MATCH".
`;

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.2,
    });

    const reply = ai.choices[0]?.message?.content?.trim() || "";
    if (/NO_MATCH/i.test(reply)) return null;

    const filename = path.basename(filePath);
    const url = "/" + filename.replace(".html", "");
    return `💡 I found a page that might help:<br><a href="${url}">${url}</a><br><br>${reply}`;
  } catch (err) {
    console.error("❌ analyzeLocalPage failed:", err);
    return null;
  }
}

// ------------------------------------------------------
// 🤖 AI Site Search (Local Only)
// ------------------------------------------------------
async function aiSearchLocal(message) {
  for (const filePath of sitePages) {
    const result = await analyzeLocalPage(filePath, message);
    if (result) return result;
  }
  return null;
}

// ------------------------------------------------------
// 🧩 Support Agent
// ------------------------------------------------------
async function handleSupportAgent(message, sessionId) {
  if (!sessions[sessionId]) sessions[sessionId] = {};
  const s = sessions[sessionId];
  const matches = findSupportMatches(message);
  const lowerMsg = (message || "").toLowerCase().trim();

  if (s.awaitingFaqChoice && /^\d+$/.test(lowerMsg)) {
    const idx = parseInt(lowerMsg, 10) - 1;
    const list = s.lastFaqList || [];
    if (list[idx]) {
      const entry = list[idx];
      s.awaitingFaqChoice = false;
      s.lastFaqList = null;
      const title = entry.title || entry.questions?.[0] || "Help Article";
      return `📘 <strong>${title}</strong><br>${entry.answers.join("<br>")}<br><br>Did that resolve your issue?`;
    }
    return "⚠️ Please enter a valid number from the list above.";
  }

  if (matches.length === 1) {
    const m = matches[0];
    const title = m.title || m.questions?.[0] || "Help Article";
    return `📘 <strong>${title}</strong><br>${m.answers.join("<br>")}<br><br>Did that resolve your issue?`;
  }

  if (matches.length > 1) {
    s.awaitingFaqChoice = true;
    s.lastFaqList = matches;
    const numbered = matches
      .map((m, i) => `${i + 1}. ${m.title || m.questions?.[0] || "Help Article"}`)
      .join("<br>");
    return `🔍 I found several possible matches:<br><br>${numbered}<br><br>Please reply with the number of the article you'd like to view.`;
  }

  const aiResult = await aiSearchLocal(message);
  if (aiResult) return aiResult;

  return `🙁 I couldn’t find an exact match.<br><br>
Would you like to:<br>
👉 <a href="/contact-us.html">Contact Support</a><br>
💡 or <a href="/support.html">Browse the FAQ Library</a>?`;
}

// ------------------------------------------------------
// 🛍️ Sales Agent
// ------------------------------------------------------
async function handleSalesAgent(message) {
  const lower = message.toLowerCase();

  if (/(price|quote|cost|subscription|how much|pricing)/i.test(lower)) {
    return `💬 We offer flexible low-monthly plans depending on your setup and card fees.<br><br>
📅 You can <a href="/book-a-demo.html">book a demo</a> and one of our team will show you detailed pricing and features.`;
  }

  const quick = [
    { k: ["bar"], url: "/bar-pos.html", label: "Bar POS Systems" },
    { k: ["bakery"], url: "/bakery-pos.html", label: "Bakery POS Systems" },
    { k: ["restaurant"], url: "/restaurant-pos.html", label: "Restaurant POS Systems" },
    { k: ["cafe", "coffee"], url: "/cafe-coffee-shop-pos.html", label: "Café POS Systems" },
    { k: ["hotel"], url: "/hotel-pos.html", label: "Hotel POS Systems" },
    { k: ["retail", "shop"], url: "/retail-pos.html", label: "Retail POS Systems" },
    { k: ["member"], url: "/members-clubs-pos.html", label: "Members’ Club POS Systems" },
    { k: ["school", "education"], url: "/school-education-university-pos.html", label: "Education POS Systems" },
    { k: ["hospital"], url: "/hospital-clinic-pos.html", label: "Hospital POS Systems" },
  ];

  for (const q of quick) {
    if (q.k.some((kw) => lower.includes(kw))) {
      return `💡 You might like our <a href="${q.url}">${q.label}</a> page — it covers that topic in more detail.`;
    }
  }

  const aiResult = await aiSearchLocal(message);
  if (aiResult) return aiResult;

  return "💬 Tell me what type of business you run (e.g. café, bar, retail), and I’ll show you the best solution.";
}

// ------------------------------------------------------
// 💬 Chat Route
// ------------------------------------------------------
const sessions = {};

app.post("/api/chat", async (req, res) => {
  const { message, context } = req.body;
  let sessionId = req.cookies.sessionId || Math.random().toString(36).substring(2, 10);
  res.cookie("sessionId", sessionId, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 1000 * 60 * 30,
  });

  try {
    let reply = "";
    if (context === "sales") reply = await handleSalesAgent(message);
    else if (context === "support") reply = await handleSupportAgent(message, sessionId);
    else
      reply =
        "🤔 I couldn’t find that — would you like to <a href='/contact-us.html'>contact support</a> or <a href='/support.html'>browse FAQs</a>?";
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ------------------------------------------------------
// 🌐 Health
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: "14.0",
    pages: sitePages.length,
    message: "Reads local HTML pages for AI context.",
    time: new Date().toISOString(),
  });
});

// ------------------------------------------------------
// 🚀 Start
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v14.0 running — using local /pages HTML files`)
);
