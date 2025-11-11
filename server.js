// =========================================
// RST EPOS Smart Chatbot API v13.0
// "Tappy Brain + Hybrid Context Router + Lead Capture"
// ✅  General mode now auto-checks Sales and Support flows
// ✅  Sales mode: HTML page search + pricing intents + lead capture
// ✅  Support mode: multi-match FAQ links + inline answers
// ✅  Unified session and logging structure
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
// 📁  Paths + Cache Setup
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, "cache");
const salesLeadsPath = path.join(__dirname, "sales_leads.jsonl");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// ------------------------------------------------------
// 🌐  Express / CORS / Rate Limit
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
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ------------------------------------------------------
// 🧾  Utilities
// ------------------------------------------------------
const logJSON = (file, data) =>
  fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...data }) + "\n");
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

// ------------------------------------------------------
// 📚  Load Support FAQs
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
// 🔍  Sitemap + Page Fetch
// ------------------------------------------------------
async function getSitemapUrls(sitemapUrl = "https://www.rstepos.com/sitemap.xml") {
  try {
    const res = await fetch(sitemapUrl);
    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml);
    if (parsed.urlset?.url)
      return parsed.urlset.url.map((u) => u.loc?.[0]).filter(Boolean);
  } catch {}
  return [];
}

async function fetchSiteText(url) {
  const safe = url.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const cacheFile = path.join(cacheDir, safe + ".txt");
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 86400000)
    return fs.readFileSync(cacheFile, "utf8");

  try {
    const res = await fetch(url);
    if (!res.ok) return "";
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script,style,nav,footer,header").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    if (text.length > 50) {
      fs.writeFileSync(cacheFile, text);
      return text;
    }
  } catch {}
  return "";
}

// ------------------------------------------------------
// 💬  Chat Route (Sales + Support + General)
// ------------------------------------------------------
const sessions = {};

app.post("/api/chat", async (req, res) => {
  const { message, context, reset } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (reset) {
    sessions[ip] = { step: "none", module: "General", lead: {} };
    return res.json({ reply: "Session reset OK." });
  }
  if (!message) return res.status(400).json({ error: "No message provided" });
  if (!sessions[ip]) sessions[ip] = { step: "none", module: "General", lead: {} };
  const s = sessions[ip];
  const lower = message.toLowerCase().trim();

  try {
    // Common exits
    if (["restart", "new question"].includes(lower))
      return res.json({ reply: "✅ No problem — please type your new question below." });
    if (["end", "exit", "close"].includes(lower))
      return res.json({ reply: "👋 Thanks for chatting! Talk soon." });

   // --------------------------
// SALES MODE (v13.2 — fixed pricing flow / no Thinking delay)
// --------------------------
if (context === "sales") {
  // Handle active lead capture sequence first
  if (s.step && s.step !== "none") {
    const reply = continueLeadCapture(s, message);
    if (reply.complete) {
      logJSON(salesLeadsPath, s.lead);
      s.step = "none";
      s.awaitingPriceConfirm = false;
      return res.json({
        reply:
          "✅ Thanks — your details have been sent to our sales team. We’ll be in touch shortly!",
      });
    }
    return res.json({ reply: reply.text });
  }

  // 🏷️ Price / quote / subscription intent handling
  const priceIntent = /(price|quote|cost|subscription|how much|pricing)/.test(lower);

  // Step 1 — User mentions price for the first time
  if (priceIntent && !s.awaitingPriceConfirm && !s.stepStarted) {
    s.awaitingPriceConfirm = true;
    return res.json({
      reply:
        "💬 We offer flexible low-monthly plans depending on setup and card fees. I can take your details so someone can give you accurate pricing — would you like that?",
    });
  }

  // Step 2 — User confirms yes
  if (s.awaitingPriceConfirm && /^(yes|ok|sure|please|yeah|yep|y|sounds good|why not)$/i.test(lower)) {
    s.awaitingPriceConfirm = false;
    s.step = "name";
    s.lead = {};
    s.stepStarted = true;
    return res.json({ reply: "🙂 Great! What’s your *name*, please?" });
  }

  // Step 3 — User declines
  if (s.awaitingPriceConfirm && /^(no|not now|later|maybe|n|nah)$/i.test(lower)) {
    s.awaitingPriceConfirm = false;
    return res.json({
      reply:
        "👍 No problem — you can also check our <a href='/products.html'>Products</a> pages for more details, or ask me about a specific feature.",
    });
  }

  // Step 4 — Awaiting explicit yes/no
  if (s.awaitingPriceConfirm) {
    return res.json({
      reply:
        "🤔 Just to confirm — would you like me to take your details so someone can send you pricing information?",
    });
  }

  // Normal sales lookups (non-pricing queries)
  const reply = await handleSalesAgent(message, s);
  return res.json({ reply });
}
  // --------------------------
  // SUPPORT MODE
  // --------------------------
  if (context === "support") {
    const reply = await handleSupportAgent(message);
    return res.json({ reply });
  }

  // --------------------------
  // GENERAL MODE (Hybrid Router)
  // --------------------------
  if (context === "general") {
    // 1️⃣ Check Sales pages first
    const salesResult = await quickSalesLookup(message);
    if (salesResult) return res.json({ reply: salesResult });

    // 2️⃣ Then check Support FAQs
    const supportResult = await quickSupportLookup(message);
    if (supportResult) return res.json({ reply: supportResult });

    // 3️⃣ Nothing found → ask for clarification
    return res.json({
      reply:
        "🤔 I couldn’t find that in our site or help articles — could you tell me a bit more? If it’s urgent, you can reach us at <a href='/contact-us.html'>Contact Us</a>.",
    });
  }

  // ✅ Close the main try
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
}); // ✅ closes app.post("/api/chat")

// ------------------------------------------------------
// 🧠 Support Search + Interactive Selection
// ------------------------------------------------------
async function handleSupportAgent(message) {
  const s = sessions[Object.keys(sessions)[0]]; // basic per-IP session reference
  const matches = findSupportMatches(message);

  // 🧩 If user previously chose an article number
  if (s.awaitingFaqChoice && /^\d+$/.test(message.trim())) {
    const idx = parseInt(message.trim(), 10) - 1;
    const list = s.lastFaqList || [];
    if (list[idx]) {
      const entry = list[idx];
      s.awaitingFaqChoice = false;
      s.lastFaqList = null;
      return (
        `📘 *${entry.title}*<br>` +
        entry.answers.join("<br>") +
        "<br><br>Did that resolve your issue?"
      );
    }
  }

  // 🎯 One clear match → show steps
  if (matches.length === 1) {
    s.awaitingFaqChoice = false;
    return (
      `📘 *${matches[0].title}*<br>` +
      matches[0].answers.join("<br>") +
      "<br><br>Did that resolve your issue?"
    );
  }

  // 📋 Multiple possible matches → show numbered list
  if (matches.length > 1) {
    s.awaitingFaqChoice = true;
    s.lastFaqList = matches;
    const numbered = matches.map((m, i) => `${i + 1}. ${m.title}`).join("<br>");
    return (
      "🔍 I found several possible matches:<br><br>" +
      numbered +
      "<br><br>Please reply with the number of the article you'd like to view."
    );
  }

  // ❌ No matches
  return "🤔 I’m not sure about that one — can you describe the issue in more detail?";
}

async function quickSupportLookup(message) {
  const s = sessions[Object.keys(sessions)[0]];
  const matches = findSupportMatches(message);

  if (!matches.length) return null;

  // Single match: show steps
  if (matches.length === 1) {
    return (
      `🧩 This might help:<br><strong>${matches[0].title}</strong><br>` +
      matches[0].answers.join("<br>") +
      "<br><br>Did that fix it?"
    );
  }

  // Multiple matches: show as numbered list (not links)
  s.awaitingFaqChoice = true;
  s.lastFaqList = matches;
  const numbered = matches.map((m, i) => `${i + 1}. ${m.title}`).join("<br>");
  return (
    "💡 I found some support articles that might match:<br><br>" +
    numbered +
    "<br><br>Please reply with the number of the article you'd like to view."
  );
}

// ------------------------------------------------------
// 🛍️ Sales Search Helpers
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

  try {
    const urls = await getSitemapUrls("https://www.rstepos.com/sitemap.xml");
    const scores = [];
    for (const url of urls) {
      const text = await fetchSiteText(url);
      if (!text) continue;
      const matches = lower
        .split(/\s+/)
        .map((w) => (text.toLowerCase().includes(w) ? 1 : 0))
        .reduce((a, b) => a + b, 0);
      if (matches > 0) scores.push({ url, matches });
    }
    scores.sort((a, b) => b.matches - a.matches);
    if (!scores.length)
      return "💬 I can help you find the right solution — tell me your business type (e.g. café, bar, retail).";

    if (scores.length === 1) {
      const title = path.basename(scores[0].url).replace(/[-_]/g, " ").replace(".html", "");
      return `🔎 I think you mean our <a href='${scores[0].url}' target='_blank'>${title}</a> page.`;
    }

    const links = scores
      .slice(0, 5)
      .map(
        (s) =>
          `<a href='${s.url}' target='_blank' style='display:block;margin:4px 0;color:#0b79b7;'>${path
            .basename(s.url)
            .replace(/[-_]/g, " ")
            .replace(".html", "")}</a>`
      )
      .join("");
    return `💡 I found a few pages mentioning that:<br>${links}`;
  } catch {
    return "💬 Sorry — I couldn’t search the site right now. Try again or see <a href='/products.html'>all products</a>.";
  }
}

async function quickSalesLookup(message) {
  const lower = message.toLowerCase();
  if (/(buy|system|epos|pos|quote|price|payment|restaurant|retail)/.test(lower)) {
    const reply = await handleSalesAgent(message);
    return reply;
  }
  return null;
}

// ------------------------------------------------------
// 🌐 Root + Static
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 Tappy Brain v13.2 Live</h1>
    <p>Hybrid General Flow (Sales + Support Routing) enabled.</p>
  `);
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v13.2 listening on port ${PORT}`)
);


app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v13.0 listening on port ${PORT}`)
);
