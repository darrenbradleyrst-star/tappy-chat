// =========================================
// RST EPOS Smart Chatbot API v12.2 ("Tappy Brain")
// ✅ Render-ready (uses process.env.PORT)
// ✅ Includes working /test route
// ✅ Full FAQ + Sales + OpenAI logic restored
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
const app = express();
const PORT = process.env.PORT || 3001;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, "cache");
const supportLogPath = path.join(__dirname, "support_log.jsonl");
const salesLeadsPath = path.join(__dirname, "sales_leads.jsonl");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

app.use(express.json());
app.use(
  cors({
    origin: [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "https://staging.rstepos.com",
      "https://rstepos.com",
      "https://tappy-chat.onrender.com"
    ],
  })
);
app.use(rateLimit({ windowMs: 60 * 1000, max: 40 }));

// ------------------------------------------------------
// ✅ Root route for Render test
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("✅ Tappy Chatbot API v12.2 is running on Render! (full logic active)");
});

// ------------------------------------------------------
// ✅ Test POST endpoint
// ------------------------------------------------------
app.post("/test", (req, res) => {
  console.log("✅ /test endpoint hit from:", req.ip);
  res.json({ ok: true, msg: "Tappy test endpoint working on Render!" });
});

// ------------------------------------------------------
// 🧾 Utilities
// ------------------------------------------------------
const logJSON = (file, data) =>
  fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...data }) + "\n");
const randomChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];
function formatReplyText(text) {
  if (!text) return "";
  return text
    .replace(/(\bStep\s*\d+[:.)]?)/gi, "<br><strong>$1</strong> ")
    .replace(/(\d+\.)\s*/g, "<br>$1 ")
    .replace(/([•\-])\s*/g, "<br>$1 ")
    .replace(/(<br>\s*){2,}/g, "<br>")
    .trim();
}
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

// ------------------------------------------------------
// 📚 Load Support FAQs + Cache
// ------------------------------------------------------
const faqsSupportPath = path.join(__dirname, "faqs_support.json");
let faqsSupport = [];
try {
  if (fs.existsSync(faqsSupportPath)) {
    faqsSupport = JSON.parse(fs.readFileSync(faqsSupportPath, "utf8"));
    console.log(`✅ Loaded ${faqsSupport.length} support FAQ entries`);
  } else console.warn("⚠️ faqs_support.json not found");
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
// 🔍 Hybrid FAQ matcher
// ------------------------------------------------------
function findSupportFAQ(message) {
  const lower = message.toLowerCase().trim();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  let bestMatch = null;
  let bestScore = 0;

  for (const entry of faqsSupport) {
    if (!entry.questions || !entry.answers) continue;
    for (const q of entry.questions) {
      const qWords = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const overlap = qWords.filter((w) => words.includes(w)).length;
      const score = overlap / Math.max(qWords.length, 1);
      if (score > bestScore && overlap >= 2 && score >= 0.5) {
        bestScore = score;
        bestMatch = entry;
      }
    }
  }

  if (!bestMatch) {
    for (const entry of faqsSupport) {
      if (!entry.questions || !entry.answers) continue;
      for (const q of entry.questions) {
        const qLower = q.toLowerCase();
        if (
          qLower.includes(lower) ||
          lower.includes(qLower) ||
          (lower.includes("printer") && qLower.includes("printer")) ||
          (lower.includes("voucher") && qLower.includes("voucher"))
        ) {
          bestMatch = entry;
          break;
        }
      }
      if (bestMatch) break;
    }
  }

  return bestMatch ? bestMatch.answers.join("<br>") : null;
}

function findCachedSupport(message) {
  const lower = message.toLowerCase();
  let bestKey = null,
    bestScore = 0;
  for (const key of Object.keys(supportCache)) {
    const keyLower = key.toLowerCase();
    const overlap = keyLower.split(" ").filter((w) => lower.includes(w)).length;
    const score = overlap / keyLower.split(" ").length;
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestKey ? supportCache[bestKey] : null;
}

// ------------------------------------------------------
// 💬 Chat route (full logic restored)
// ------------------------------------------------------
const sessions = {};
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!message) return res.status(400).json({ error: "No message provided" });
  if (!sessions[ip]) sessions[ip] = { step: "none", module: "General", lead: {} };
  const s = sessions[ip];
  const lower = message.toLowerCase().trim();

  try {
    // 💰 Detect sales intent
    const salesKeywords =
      /\b(price|cost|quote|quotation|pricing|rate|fee|buy|purchase|demo|package|plan|monthly|hardware|how much|what'?s the price|subscribe|subscription|order|get started|sign up|trial|tapapay rates?|processing fees?)\b/i;
    const supportKeywords =
      /\b(error|issue|problem|not working|failed|cannot|won'?t|stopped|help|support|troubleshoot|fix|repair|connect|login|setup|install|configure|update|vein|finger|scanner|printer|display|reader|ped|terminal|card machine|device|screen)\b/i;

    const isSalesIntent = salesKeywords.test(message) && !supportKeywords.test(message);
    if (isSalesIntent) {
      s.step = "sales_offer";
      return res.json({
        reply:
          "💡 The pricing for our RST EPOS products can vary depending on your setup and business type.<br><br>" +
          "Would you like to provide your details so we can prepare a tailored quote?<br>" +
          `<div class='cb-yesno'>
             <button class='cb-btn-yes'>Yes</button>
             <button class='cb-btn-no'>No</button>
           </div>`,
      });
    }

    // --- Sales data capture flow ---
    if (s.step === "sales_offer" && lower === "yes") {
      s.step = "sales_name";
      return res.json({
        reply:
          "Great! Let’s get a few quick details to prepare your quote.<br><br>" +
          "What’s your <strong>name</strong>?",
      });
    }
    if (s.step === "sales_offer" && lower === "no") {
      s.step = "none";
      return res.json({
        reply: "👍 No problem! You can ask me anytime if you’d like a quote or demo.",
      });
    }
    if (s.step === "sales_name") {
      s.lead.name = message;
      s.step = "sales_company";
      return res.json({ reply: `Thanks ${message}! What’s your <strong>company name</strong>?` });
    }
    if (s.step === "sales_company") {
      s.lead.company = message;
      s.step = "sales_email";
      return res.json({
        reply: "Great — what’s your <strong>email address</strong>? (we’ll send your quote there)",
      });
    }
    if (s.step === "sales_email") {
      if (!isValidEmail(message))
        return res.json({ reply: "⚠️ That doesn’t look like a valid email address. Try again?" });
      s.lead.email = message;
      s.step = "sales_comments";
      return res.json({
        reply: "Perfect — any <strong>comments or requirements</strong> for your quote?",
      });
    }
    if (s.step === "sales_comments") {
      s.lead.comments = message;
      fs.appendFileSync(
        salesLeadsPath,
        JSON.stringify({ time: new Date().toISOString(), ...s.lead }) + "\n"
      );
      s.step = "none";
      return res.json({
        reply:
          `✅ Thanks ${s.lead.name}! Your quote request has been logged.<br>` +
          `Our team will contact you at <strong>${s.lead.email}</strong> soon.`,
      });
    }

    // ------------------------------------------------------
    // 🧠 FAQ + Cache + OpenAI fallback
    // ------------------------------------------------------
    let reply = "";
    let source = "";

    const localFAQ = findSupportFAQ(message);
    if (localFAQ) {
      reply = formatReplyText(localFAQ);
      source = "FAQs";
    } else {
      const cached = findCachedSupport(message);
      if (cached) {
        reply = formatReplyText(cached);
        source = "Cache";
      } else {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.5,
          max_tokens: 250,
          messages: [
            {
              role: "system",
              content:
                "You are Tappy, the helpful RST EPOS assistant. Respond conversationally and clearly.",
            },
            { role: "user", content: message },
          ],
        });

        reply = formatReplyText(completion.choices[0].message.content.trim());
        supportCache[message] = reply;
        saveSupportCache();
        source = "OpenAI";
      }
    }

    reply += `<br><br><small>📘 Source: ${source}</small>`;
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ------------------------------------------------------
// 🚀 Start server
// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Tappy Brain v12.2 running on port ${PORT}`);
});
