// =========================================
// RST EPOS Smart Chatbot API v13.6
// "Tappy Brain + FAQ Search + AI HTML Fallback"
// ✅ Searches faqs_support.json for direct matches
// ✅ If no FAQ match → uses OpenAI to analyse cached HTML pages
// ✅ If still no result → suggests Contact Support / Browse FAQs
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
// 📁 Paths
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, "cache");
const salesLeadsPath = path.join(__dirname, "sales_leads.jsonl");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// ------------------------------------------------------
// 🌐 Middleware
// ------------------------------------------------------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  cors({
    origin: [
      "https://www.rstepos.com",
      "https://staging.rstepos.com",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
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
// 🧾 Utilities
// ------------------------------------------------------
const logJSON = (file, data) =>
  fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...data }) + "\n");

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

// ------------------------------------------------------
// 📚 Load Support FAQs
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
    console.log(`✅ Loaded ${faqsSupport.length} FAQ entries`);
  } else console.warn("⚠️ faqs_support.json not found");
} catch (err) {
  console.error("❌ Failed to load faqs_support.json:", err);
}

// ------------------------------------------------------
// 🧠 Find FAQ Matches
// ------------------------------------------------------
function findSupportMatches(message) {
  const lower = (message || "").toLowerCase();
  return faqsSupport.filter((faq) => {
    const list = faq.questions || faq.keywords || [];
    return list.some((q) => q.toLowerCase().includes(lower) || lower.includes(q.toLowerCase()));
  });
}

// ------------------------------------------------------
// 🌍 Cache + Fetch Site Text
// ------------------------------------------------------
async function getSitemapUrls(sitemapUrl = "https://www.rstepos.com/sitemap.xml") {
  try {
    const res = await fetch(sitemapUrl);
    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml);
    if (parsed.urlset?.url) return parsed.urlset.url.map((u) => u.loc?.[0]).filter(Boolean);
  } catch (e) {
    console.warn("⚠️ Could not fetch sitemap:", e);
  }
  return [];
}

async function fetchSiteText(url) {
  const safe = url.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const cacheFile = path.join(cacheDir, safe + ".txt");
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, "utf8");
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
  } catch (e) {
    console.warn("⚠️ Could not fetch:", url);
  }
  return "";
}

// ------------------------------------------------------
// 🤖 OpenAI Fallback: Search Site Content for Context
// ------------------------------------------------------
async function aiSearchSite(message) {
  try {
    const urls = await getSitemapUrls();
    const subset = urls.slice(0, 10); // limit for performance
    const pages = [];

    for (const url of subset) {
      const text = await fetchSiteText(url);
      if (text) pages.push({ url, text: text.slice(0, 2000) });
    }

    const prompt = `
You are a support assistant for RST EPOS.
User asked: "${message}"

Given the following HTML text excerpts from website pages, identify if any seem relevant.
If relevant, return the best-matching page URL and a short explanation.
If none match, respond with "NO_MATCH".

${pages.map((p, i) => `Page ${i + 1}: ${p.url}\n${p.text}`).join("\n\n")}
    `;

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.2,
    });

    const result = ai.choices[0]?.message?.content || "";
    if (result.includes("NO_MATCH")) return null;
    const urlMatch = result.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      return `💡 I found a page that might help:<br><a href="${urlMatch[0]}" target="_blank">${urlMatch[0]}</a><br><br>${result}`;
    }
    return result;
  } catch (err) {
    console.error("❌ AI site search failed:", err);
    return null;
  }
}

// ------------------------------------------------------
// 🧩 Support Logic
// ------------------------------------------------------
async function handleSupportAgent(message, sessionId) {
  const s = sessions[sessionId] || {};
  const matches = findSupportMatches(message);

  // Select a numbered FAQ
  if (s.awaitingFaqChoice && /^\d+$/.test(message.trim())) {
    const idx = parseInt(message.trim(), 10) - 1;
    const list = s.lastFaqList || [];
    if (list[idx]) {
      const entry = list[idx];
      s.awaitingFaqChoice = false;
      s.lastFaqList = null;
      const title = entry.title || entry.questions?.[0] || "Help Article";
      return `📘 <strong>${title}</strong><br>${entry.answers.join("<br>")}<br><br>Did that resolve your issue?`;
    }
  }

  // Single match
  if (matches.length === 1) {
    const m = matches[0];
    const title = m.title || m.questions?.[0] || "Help Article";
    return `📘 <strong>${title}</strong><br>${m.answers.join("<br>")}<br><br>Did that resolve your issue?`;
  }

  // Multiple matches
  if (matches.length > 1) {
    s.awaitingFaqChoice = true;
    s.lastFaqList = matches;
    const numbered = matches
      .map((m, i) => `${i + 1}. ${m.title || m.questions?.[0] || "Help Article"}`)
      .join("<br>");
    return `🔍 I found several possible matches:<br><br>${numbered}<br><br>Please reply with the number of the article you'd like to view.`;
  }

  // No match — use OpenAI site search fallback
  const aiResult = await aiSearchSite(message);
  if (aiResult) return aiResult;

  // Still nothing
  return `🙁 I couldn’t find an exact match.<br><br>
Would you like to:<br>
👉 <a href="/contact-us.html" target="_blank">Contact Support</a><br>
💡 or <a href="/support.html" target="_blank">Browse the FAQ Library</a>?`;
}

// ------------------------------------------------------
// 🛍️ Sales Agent (price intent)
// ------------------------------------------------------
async function handleSalesAgent(message) {
  const lower = message.toLowerCase();
  const priceIntent = /(price|quote|cost|subscription|how much|pricing)/i.test(lower);
  if (priceIntent) {
    return `💬 We offer flexible low-monthly plans depending on your setup and card fees.<br><br>
📅 You can <a href="/book-a-demo.html" target="_blank">book a demo</a> and one of our team will show you detailed pricing and features.`;
  }

  return "💬 Tell me what type of business you run (e.g. café, bar, retail), and I’ll show you the best solution.";
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

  const s = sessions[sessionId] || (sessions[sessionId] = { step: "none", lead: {} });
  if (!message) return res.status(400).json({ error: "No message provided" });

  try {
    if (["restart", "new question"].includes(message.toLowerCase()))
      return res.json({ reply: "✅ No problem — please type your new question below." });

    if (["end", "exit", "close"].includes(message.toLowerCase()))
      return res.json({ reply: "👋 Thanks for chatting! Talk soon." });

    if (context === "sales") {
      const reply = await handleSalesAgent(message);
      return res.json({ reply });
    }

    if (context === "support") {
      const reply = await handleSupportAgent(message, sessionId);
      return res.json({ reply });
    }

    return res.json({
      reply:
        "🤔 I couldn’t find that in our help articles — would you like to <a href='/contact-us.html'>contact support</a> or <a href='/support.html'>browse FAQs</a>?",
    });
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
    version: "13.6",
    message: "Uses OpenAI to search cached HTML pages if FAQ not found.",
    time: new Date().toISOString(),
  });
});

// ------------------------------------------------------
// 🚀 Start Server
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v13.6 listening on port ${PORT}`)
);
