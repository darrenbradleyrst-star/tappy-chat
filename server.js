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
    // SALES MODE
    // --------------------------
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

      if (/(price|quote|cost|subscription)/.test(lower)) {
        s.step = "name";
        s.lead = {};
        return res.json({
          reply:
            "💬 Sure — we offer low monthly plans depending on setup and card fees. What’s your *name*, please?",
        });
      }

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
        return { text: "⚠️ That email doesn’t look right — please re-enter it." };
      s.lead.email = message.trim();
      s.step = "comments";
      return { text: "📝 Great — any specific notes or requirements for your quote?" };
    case "comments":
      s.lead.comments = message.trim();
      return { complete: true };
    default:
      return { text: "💬 Please continue…" };
  }
}

// ------------------------------------------------------
// 🧠 Support Search Helpers
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

async function handleSupportAgent(message) {
  const matches = findSupportMatches(message);
  if (matches.length === 1)
    return matches[0].answers.join("<br>") + "<br><br>Did that resolve your issue?";
  if (matches.length > 1) {
    const links = matches
      .map(
        (m, i) =>
          `<a href='${m.url ||
            "#"}' target='_blank' style='display:block;margin:4px 0;color:#0b79b7;'>${m.title}</a>`
      )
      .join("");
    return `🔍 I found several articles that might help:<br>${links}`;
  }
  return "🤔 I’m not sure about that one — can you describe the issue in more detail?";
}

async function quickSupportLookup(message) {
  const matches = findSupportMatches(message);
  if (!matches.length) return null;
  if (matches.length === 1)
    return `🧩 This might help:<br>${matches[0].answers.join("<br>")}<br><br>Did that fix it?`;
  const links = matches
    .map(
      (m) =>
        `<a href='${m.url ||
          "#"}' target='_blank' style='display:block;margin:4px 0;color:#0b79b7;'>${m.title}</a>`
    )
    .join("");
  return `💡 I found some support articles that might match:<br>${links}`;
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
    <h1>🚀 Tappy Brain v13.0 Live</h1>
    <p>Hybrid General Flow (Sales + Support Routing) enabled.</p>
  `);
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v13.0 listening on port ${PORT}`)
);
