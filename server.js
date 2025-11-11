// =========================================
// RST EPOS Smart Chatbot API v14.1
// "Tappy Brain + Full Hardcoded HTML Page List + FAQ + AI Fallback"
// ✅ Uses your exact HTML filenames (from screenshots)
// ✅ Keeps all FAQ, AI fallback, and sales logic
// =========================================

import express from "express";
import OpenAI from "openai";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
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
const faqsSupportPath = path.join(__dirname, "faqs_support.json");
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
      "https://staging.rstepos.com",
      "https://www.rstepos.com",
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
// 🧾 Hardcoded HTML Pages from your screenshots
// ------------------------------------------------------
const sitePages = [
  "https://staging.rstepos.com/back-office-software.html",
  "https://staging.rstepos.com/bakery-pos.html",
  "https://staging.rstepos.com/bar-pos.html",
  "https://staging.rstepos.com/book-a-demo.html",
  "https://staging.rstepos.com/cafe-coffee-shop-pos.html",
  "https://staging.rstepos.com/case-studies.html",
  "https://staging.rstepos.com/contact-us.html",
  "https://staging.rstepos.com/convenience-store-pos.html",
  "https://staging.rstepos.com/cookie-consent.html",
  "https://staging.rstepos.com/cookie-policy.html",
  "https://staging.rstepos.com/digital-gift-vouchers.html",
  "https://staging.rstepos.com/faqs.html",
  "https://staging.rstepos.com/farm-shop-pos.html",
  "https://staging.rstepos.com/fastfood-pizza-pos.html",
  "https://staging.rstepos.com/festival-events-pos.html",
  "https://staging.rstepos.com/food-truck-pos.html",
  "https://staging.rstepos.com/gift-shop-pos.html",
  "https://staging.rstepos.com/hardware.html",
  "https://staging.rstepos.com/help.html",
  "https://staging.rstepos.com/hospital-clinic-pos.html",
  "https://staging.rstepos.com/hospitality-pos.html",
  "https://staging.rstepos.com/hotel-pos.html",
  "https://staging.rstepos.com/index.html",
  "https://staging.rstepos.com/integrated-credit-cards.html",
  "https://staging.rstepos.com/iwantfed-online-ordering.html",
  "https://staging.rstepos.com/kitchen-display-system.html",
  "https://staging.rstepos.com/members-clubs-pos.html",
  "https://staging.rstepos.com/membership-app.html",
  "https://staging.rstepos.com/mobile-pos.html",
  "https://staging.rstepos.com/off-sales-pos.html",
  "https://staging.rstepos.com/pci.html",
  "https://staging.rstepos.com/pos-integrations.html",
  "https://staging.rstepos.com/pos-software.html",
  "https://staging.rstepos.com/privacy-policy.html",
  "https://staging.rstepos.com/protel-pms-hotel-software.html",
  "https://staging.rstepos.com/resources.html",
  "https://staging.rstepos.com/restaurant-pos.html",
  "https://staging.rstepos.com/retail-pos.html",
  "https://staging.rstepos.com/school-education-university-pos.html",
  "https://staging.rstepos.com/stadium-pos.html",
  "https://staging.rstepos.com/standalone-credit-cards.html",
  "https://staging.rstepos.com/stock-control-software.html",
  "https://staging.rstepos.com/support.html",
  "https://staging.rstepos.com/table-reservations-software.html",
  "https://staging.rstepos.com/tapapay-credit-cards.html",
  "https://staging.rstepos.com/terms.html",
  "https://staging.rstepos.com/waiter-ordering-system.html",
];

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
  } else console.warn("⚠️ faqs_support.json not found");
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
// 🧠 OpenAI Page Analyzer
// ------------------------------------------------------
async function analyzePageWithAI(url, query) {
  try {
    const cacheFile = path.join(cacheDir, url.replace(/[^a-z0-9]/gi, "_") + ".txt");
    let html = "";
    if (fs.existsSync(cacheFile)) {
      html = fs.readFileSync(cacheFile, "utf8");
    } else {
      const res = await fetch(url);
      html = await res.text();
      fs.writeFileSync(cacheFile, html);
    }

    const $ = cheerio.load(html);
    $("script,style,nav,footer,header").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);

    const prompt = `
You are a helpful RST EPOS assistant.
A user asked about: "${query}"

Here is the page content from ${url}:

${text}

If this page answers the user's query, summarise it in 2–3 short sentences.
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
    return `💡 I found a page that might help:<br><a href="${url}">${url}</a><br><br>${reply}`;
  } catch (err) {
    console.error("❌ analyzePageWithAI failed:", err.message);
    return null;
  }
}

// ------------------------------------------------------
// 🤖 AI Fallback Search (Iterates all hardcoded pages)
// ------------------------------------------------------
async function aiSearchSite(message) {
  for (const url of sitePages) {
    const result = await analyzePageWithAI(url, message);
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
  const lowerMsg = (message || "").toLowerCase().trim();

  // User selecting from previous FAQ list
  if (s.awaitingFaqChoice && /^\d+$/.test(lowerMsg)) {
    const idx = parseInt(lowerMsg, 10) - 1;
    const list = s.lastFaqList || [];

    if (list[idx]) {
      const entry = list[idx];
      s.awaitingFaqChoice = false;
      s.lastFaqList = null;
      sessions[sessionId] = s;

      const title = entry.title || entry.questions?.[0] || "Help Article";
      const steps = Array.isArray(entry.answers)
        ? entry.answers.join("<br>")
        : entry.answers;
      return `📘 <strong>${title}</strong><br>${steps}<br><br>Did that resolve your issue?`;
    }

    // If invalid number entered
    return `⚠️ Please reply with a valid number from the list above.`;
  }

  // Try direct FAQ match
  const matches = findSupportMatches(message);
  if (matches.length === 1) {
    const m = matches[0];
    const title = m.title || m.questions?.[0] || "Help Article";
    const steps = Array.isArray(m.answers)
      ? m.answers.join("<br>")
      : m.answers;
    return `📘 <strong>${title}</strong><br>${steps}<br><br>Did that resolve your issue?`;
  }

  // Multiple FAQ matches
  if (matches.length > 1) {
    s.awaitingFaqChoice = true;
    s.lastFaqList = matches;
    sessions[sessionId] = s;

    const numbered = matches
      .map((m, i) => `${i + 1}. ${m.title || m.questions?.[0] || "Help Article"}`)
      .join("<br>");
    return `🔍 I found several possible matches:<br><br>${numbered}<br><br>Please reply with the number of the article you'd like to view.`;
  }

  // No FAQ match → AI site content search
  const aiResult = await aiSearchSite(message);
  if (aiResult) return aiResult;

  // Fallback if nothing found
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
  { k: ["bar", "pub", "nightclub"], url: "/bar-pos.html", label: "Bar POS Systems" },
  { k: ["bakery", "patisserie"], url: "/bakery-pos.html", label: "Bakery POS Systems" },
  { k: ["restaurant", "bistro", "dining"], url: "/restaurant-pos.html", label: "Restaurant POS Systems" },
  { k: ["cafe", "coffee", "coffee shop"], url: "/cafe-coffee-shop-pos.html", label: "Café & Coffee Shop POS Systems" },
  { k: ["hotel", "guestline", "protel", "mews", "accommodation"], url: "/hotel-pos.html", label: "Hotel & Hospitality POS Systems" },
  { k: ["retail", "shop", "store", "boutique"], url: "/retail-pos.html", label: "Retail POS Systems" },
  { k: ["member", "membership", "club", "golf"], url: "/members-clubs-pos.html", label: "Members’ Club POS Systems" },
  { k: ["education", "school", "college", "university", "canteen"], url: "/school-education-university-pos.html", label: "Education & Canteen POS Systems" },
  { k: ["hospital", "clinic", "healthcare"], url: "/hospital-clinic-pos.html", label: "Hospital & Healthcare POS Systems" },
  { k: ["farm", "farm shop", "deli"], url: "/farm-shop-pos.html", label: "Farm Shop POS Systems" },
  { k: ["fast food", "pizza", "takeaway"], url: "/fastfood-pizza-pos.html", label: "Fast Food & Pizza POS Systems" },
  { k: ["festival", "event", "mobile event"], url: "/festival-events-pos.html", label: "Festival & Events POS Systems" },
  { k: ["food truck", "street food", "van"], url: "/food-truck-pos.html", label: "Food Truck POS Systems" },
  { k: ["gift shop", "souvenir"], url: "/gift-shop-pos.html", label: "Gift Shop POS Systems" },
  { k: ["convenience", "corner shop", "newsagent"], url: "/convenience-store-pos.html", label: "Convenience Store POS Systems" },
  { k: ["stadium", "arena", "sports"], url: "/stadium-pos.html", label: "Stadium & Venue POS Systems" },
  { k: ["off licence", "off sales", "wine shop"], url: "/off-sales-pos.html", label: "Off-Sales & Off-Licence POS Systems" },
  { k: ["mobile", "portable", "pop up"], url: "/mobile-pos.html", label: "Mobile POS Systems" },
  { k: ["hospitality", "restaurant", "bar", "cafe"], url: "/hospitality-pos.html", label: "Hospitality POS Overview" },
];


  for (const q of quick) {
    if (q.k.some((kw) => lower.includes(kw))) {
      return `💡 You might like our <a href="${q.url}">${q.label}</a> page — it covers that topic in more detail.`;
    }
  }

  const aiResult = await aiSearchSite(message);
  if (aiResult) return aiResult;

  return "💬 Tell me what type of business you run (e.g. café, bar, retail), and I’ll show you the best solution.";
}

// ------------------------------------------------------
// 💬 Chat
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
// 🌐 Root Check
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: "14.1",
    pages: sitePages.length,
    message: "Using full hardcoded staging HTML pages list.",
    time: new Date().toISOString(),
  });
});

// ------------------------------------------------------
// 🚀 Start Server
// ------------------------------------------------------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v14.1 listening on port ${PORT}`)
);
