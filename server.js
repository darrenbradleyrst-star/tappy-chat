// =========================================
// RST EPOS Smart Chatbot API v12.3 ("Tappy Brain + Agentic Context + Multi-match")
// ✅ Support mode: shows multiple matching FAQs as clickable links
// ✅ Sales mode: shows multiple matching pages as HTML links
// ✅ Clean structure, Render-ready
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
// 📁 Paths and setup
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, "cache");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// ------------------------------------------------------
// 🌐 Express / CORS / Rate Limiting Setup
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
// 📚 Load Support FAQs + Cache
// ------------------------------------------------------
const faqsSupportPath = path.join(__dirname, "faqs_support.json");
let faqsSupport = [];
try {
  if (fs.existsSync(faqsSupportPath)) {
    faqsSupport = JSON.parse(fs.readFileSync(faqsSupportPath, "utf8"));
    console.log(`✅ Loaded ${faqsSupport.length} support FAQ entries`);
  } else {
    console.warn("⚠️ faqs_support.json not found");
  }
} catch (err) {
  console.error("❌ Failed to load faqs_support.json:", err);
}

const supportCachePath = path.join(__dirname, "support_cache.json");
let supportCache = {};
try {
  if (fs.existsSync(supportCachePath)) {
    supportCache = JSON.parse(fs.readFileSync(supportCachePath, "utf8"));
    console.log(`✅ Loaded ${Object.keys(supportCache).length} cached replies`);
  }
} catch (err) {
  console.error("❌ Failed to load support_cache.json:", err);
}
function saveSupportCache() {
  fs.writeFileSync(supportCachePath, JSON.stringify(supportCache, null, 2));
}

// ------------------------------------------------------
// 🔍 Sitemap + Page Fetch
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
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 86400000) {
    const cached = fs.readFileSync(cacheFile, "utf8");
    if (cached.length > 50 && !cached.toLowerCase().includes("404")) return cached;
  }

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
// 💬 Chat Route with Multi-Match Links
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
    if (["start new question", "new question", "restart"].includes(lower))
      return res.json({ reply: "✅ No problem — please type your new question below." });
    if (["end chat", "close", "exit"].includes(lower))
      return res.json({ reply: "👋 Thanks for chatting! Talk soon." });

    // 🟢 SALES MODE
    if (context === "sales") {
      const reply = await handleSalesAgent(message, s);
      return res.json({ reply });
    }

    // 🟣 SUPPORT / GENERAL MODE
    if (context === "support" || context === "general") {
      const matches = findMultipleSupportFAQs(message);

      // One match → show full answer
      if (matches.length === 1) {
        const reply = matches[0].answers.join("<br>");
        supportCache[message] = reply;
        saveSupportCache();
        return res.json({ reply });
      }

      // Multiple matches → show article links
      if (matches.length > 1) {
        const links = matches
          .slice(0, 5)
          .map((m, i) => {
            const title = m.title || m.questions?.[0] || `Article ${i + 1}`;
            const url =
              m.url ||
              `https://support.rstepos.com/article/${encodeURIComponent(
                title.toLowerCase().replace(/\s+/g, "-")
              )}`;
            return `<a href="${url}" target="_blank" style="display:block;margin:4px 0;color:#0b79b7;">${title}</a>`;
          })
          .join("");
        return res.json({
          reply: `🔍 I found several articles that might help:<br>${links}`,
        });
      }

      return res.json({
        reply:
          "🤔 I’m not sure about that one yet — can you describe the issue in more detail? I’ll pass it to support if needed.",
      });
    }
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ------------------------------------------------------
// 🧠 Support Multi-Match Finder (with title + URL)
// ------------------------------------------------------
function findMultipleSupportFAQs(message) {
  const lower = message.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  const results = [];

  for (const entry of faqsSupport) {
    if (!entry.questions || !entry.answers) continue;
    const allQ = entry.questions.map((q) => q.toLowerCase());
    const score = allQ.reduce((sum, q) => {
      const qWords = q.split(/\s+/);
      const overlap = qWords.filter((w) => words.includes(w)).length;
      return sum + (overlap > 0 ? 1 : 0);
    }, 0);
    if (score > 0) {
      results.push({
        title: entry.title || entry.questions[0],
        url: entry.url || null,
        answers: entry.answers,
      });
    }
  }

  return results.slice(0, 5);
}

// ------------------------------------------------------
// 🛍️ Agentic Sales Assistant (Links instead of buttons)
// ------------------------------------------------------
async function handleSalesAgent(message, s) {
  const lower = message.toLowerCase();

  // Quick known routes
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

  // Sitemap contextual search
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

    if (scores.length === 1) {
      const title = path.basename(scores[0].url).replace(/[-_]/g, " ").replace(".html", "");
      return `🔎 I think you mean our <a href='${scores[0].url}' target='_blank'>${title}</a> page.`;
    }

    if (scores.length > 1) {
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
    }
  } catch (err) {
    console.warn("⚠️ Sitemap search failed:", err);
  }

  return (
    "💬 I can help you find the right solution — just tell me your business type (e.g. café, bar, retail, hotel, hospital).<br><br>" +
    "Or browse all <a href='/products.html'>RST EPOS Products</a> to explore."
  );
}

// ------------------------------------------------------
// 🌐 Root + Static Route
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 Tappy Brain v12.3 is Live</h1>
    <p>Your chatbot API is running successfully on Render.</p>
    <p>Try POST /api/chat with {"message":"hello"}</p>
  `);
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Tappy Brain v12.3 listening on port ${PORT}`)
);
