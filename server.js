// =========================================
// RST EPOS Smart Chatbot API v12.1 ("Tappy Brain")
// ✅ Sales intent → Lead capture (Name → Company → Email → Comments)
// ✅ FAQ → Cache → OpenAI fallback order
// ✅ Displays answer source (FAQ / Cache / OpenAI)
// ✅ Working Yes/No + Start New Question / End Chat
// ✅ Cleans 404 text before OpenAI context
// ✅ Fixes false sales trigger on support queries
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
const PORT = 3001;
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
    ],
  })
);
app.use(rateLimit({ windowMs: 60 * 1000, max: 40 }));

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
// 🔍 Sitemap loader + fallback (manual HTML list for staging)
// ------------------------------------------------------
async function getSitemapUrls(sitemapUrl = "https://staging.rstepos.com/sitemap.xml") {
  try {
    const res = await fetch(sitemapUrl);
    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml);
    if (parsed.urlset?.url)
      return parsed.urlset.url.map((u) => u.loc?.[0]).filter(Boolean);
  } catch {}

  // Manual fallback (staging URLs)
  return [
    "https://staging.rstepos.com/",
    "https://staging.rstepos.com/index.html",
    "https://staging.rstepos.com/tapapos.html",
    "https://staging.rstepos.com/tapapay.html",
    "https://staging.rstepos.com/tapaoffice.html",
    "https://staging.rstepos.com/iwantfed-online-ordering.html",
    "https://staging.rstepos.com/giveavoucher.html",
    "https://staging.rstepos.com/tapatable.html",
    "https://staging.rstepos.com/back-office-software.html",
    "https://staging.rstepos.com/pos-software.html",
    "https://staging.rstepos.com/integrated-payments.html",
    "https://staging.rstepos.com/hospitality-pos.html",
    "https://staging.rstepos.com/retail-pos.html",
    "https://staging.rstepos.com/restaurant-pos.html",
    "https://staging.rstepos.com/bar-pos.html",
    "https://staging.rstepos.com/cafe-coffee-shop-pos.html",
    "https://staging.rstepos.com/bakery-pos.html",
    "https://staging.rstepos.com/fastfood-pizza-pos.html",
    "https://staging.rstepos.com/convenience-store-pos.html",
    "https://staging.rstepos.com/farm-shop-pos.html",
    "https://staging.rstepos.com/food-truck-pos.html",
    "https://staging.rstepos.com/festival-events-pos.html",
    "https://staging.rstepos.com/hotel-pos.html",
    "https://staging.rstepos.com/protel-pms-hotel-software.html",
    "https://staging.rstepos.com/hospital-clinic-pos.html",
    "https://staging.rstepos.com/members-clubs-pos.html",
    "https://staging.rstepos.com/school-education-university-pos.html",
    "https://staging.rstepos.com/mobile-pos.html",
    "https://staging.rstepos.com/off-sales-pos.html",
    "https://staging.rstepos.com/stadium-pos.html",
    "https://staging.rstepos.com/gift-shop-pos.html",
    "https://staging.rstepos.com/book-a-demo.html",
    "https://staging.rstepos.com/case-studies.html",
    "https://staging.rstepos.com/resources.html",
    "https://staging.rstepos.com/support.html",
    "https://staging.rstepos.com/help.html",
    "https://staging.rstepos.com/privacy-policy.html",
    "https://staging.rstepos.com/cookie-policy.html",
    "https://staging.rstepos.com/terms.html",
    "https://staging.rstepos.com/pci.html",
    "https://staging.rstepos.com/contact-us.html",
    "https://staging.rstepos.com/hardware.html",
    "https://staging.rstepos.com/kitchen-display-system.html",
    "https://staging.rstepos.com/table-reservations-software.html",
    "https://staging.rstepos.com/membership-app.html",
    "https://staging.rstepos.com/at-table-ordering.html",
    "https://staging.rstepos.com/stock-control-software.html",
    "https://staging.rstepos.com/digital-gift-vouchers.html"
  ];
}

async function fetchSiteText(url) {
  const safe = url.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const cacheFile = path.join(cacheDir, safe + ".txt");
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 86400000) {
    const cached = fs.readFileSync(cacheFile, "utf8");
    if (cached.length > 50 && !cached.toLowerCase().includes("404")) return cached;
  }

  let text = "";
  try {
    const res = await fetch(url);
    if (!res.ok || res.status !== 200) return "";
    const html = await res.text();
    if (html.toLowerCase().includes("404 not found") || html.toLowerCase().includes("error 404"))
      return "";
    const $ = cheerio.load(html);
    $("script,style,nav,footer,header").remove();
    text = $("body").text().replace(/\s+/g, " ").trim();
    if (text.length < 50) return "";
    fs.writeFileSync(cacheFile, text);
  } catch {}
  return text;
}

// ------------------------------------------------------
// 💬 Chat route
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
    // ------------------------------------------------------
    // 🔁 Follow-up button handling
    // ------------------------------------------------------
    if (["start new question", "new question", "restart"].includes(lower)) {
      s.step = "none";
      return res.json({ reply: "✅ No problem — please type your new question below." });
    }

    if (["end chat", "close", "exit"].includes(lower)) {
      sessions[ip] = { step: "none", module: "General", lead: {} };
      return res.json({ reply: "👋 Thanks for chatting! Talk soon." });
    }

    // ------------------------------------------------------
    // 💰 Smart Sales Intent Detection (runs BEFORE FAQ/Cache)
    // ------------------------------------------------------
    const salesKeywords =
      /\b(price|cost|quote|quotation|pricing|rate|fee|buy|purchase|demo|package|plan|monthly|hardware|how much|what'?s the price|subscribe|subscription|order|get started|sign up|trial|tapapay rates?|processing fees?)\b/i;
    const supportKeywords =
      /\b(error|issue|problem|not working|failed|cannot|won'?t|stopped|help|support|troubleshoot|fix|repair|connect|login|setup|install|configure|update|vein|finger|scanner|printer|display|reader|ped|terminal|card machine|device|screen)\b/i;

    const isSalesIntent = salesKeywords.test(message) && !supportKeywords.test(message);
    const isSupportIntent = supportKeywords.test(message);

    if (isSupportIntent && supportCache[message]) {
      delete supportCache[message]; // clear wrong pricing responses
      saveSupportCache();
    }

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

    // --- Handle user clicking Yes / No on quote offer ---
    if (s.step === "sales_offer" && lower === "yes") {
      s.step = "sales_name";
      return res.json({
        reply:
          "Great! Let’s get a few quick details to prepare your quote.<br><br>" +
          "What’s your <strong>name</strong> so we can include it on the quotation?",
      });
    }
    if (s.step === "sales_offer" && lower === "no") {
      s.step = "none";
      return res.json({
        reply:
          "👍 No problem! You can ask me anytime if you’d like a quote or demo.<br>" +
          "Is there anything else I can help you with?",
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
        reply: "Great — and what’s your <strong>email address</strong>? (we’ll send your quote there)",
      });
    }
    if (s.step === "sales_email") {
      if (!isValidEmail(message)) {
        return res.json({
          reply: "⚠️ That doesn’t look like a valid email address. Could you double-check it?",
        });
      }
      s.lead.email = message;
      s.step = "sales_comments";
      return res.json({
        reply: "Perfect — lastly, any <strong>comments or requirements</strong> for your quote?",
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
          `Our team will contact you shortly at <strong>${s.lead.email}</strong>.<br><br>` +
          "Would you like to ask about anything else?",
      });
    }

    // ------------------------------------------------------
    // 🧠 Support follow-up answers (Yes / No)
    // ------------------------------------------------------
    if (s.step === "support_followup" && (lower === "yes" || lower === "no")) {
      if (lower === "yes") {
        s.step = "none";
        return res.json({
          reply:
            "✅ Great! I'm glad that helped.<br>If you need anything else, just ask — I'm here to help with RST EPOS, TapaPOS or TapaPay anytime.",
        });
      }
      s.step = "support_done";
      return res.json({
        reply:
          "⚙️ Sorry that didn’t solve it. You can reach our support team directly here:<br>" +
          `<div class='cb-yesno'>
             <a href='/contacts.html' target='_blank'>
               <button class='cb-btn-yes'>📞 Contact Support</button>
             </a>
           </div><br>` +
          "Would you like to start a new question?<br>" +
          `<div class='cb-yesno'>
             <button data-action='new-question' class='cb-btn-yes'>Start New Question</button>
             <button data-action='end-chat' class='cb-btn-no'>End Chat</button>
           </div>`,
      });
    }

    // ------------------------------------------------------
    // 💬 Local FAQ → Cache → OpenAI
    // ------------------------------------------------------
    let reply = "";
    let source = "";

    const localFAQ = findSupportFAQ(message);
    if (localFAQ) {
      reply = formatReplyText(localFAQ);
      source = "FAQs";
      s.step = "support_followup";
    } else {
      const cached = findCachedSupport(message);
      if (cached && !cached.toLowerCase().includes("pricing")) {
        reply = formatReplyText(cached);
        source = "Cache";
        s.step = "support_followup";
      } else {
        const urls = await getSitemapUrls();
        const manual = `
TapaPOS — till and hardware system for RST EPOS.
TapaOffice — cloud back office for setup, reporting and stock management.
TapaPay — integrated payment service with next-day payouts and unified support.
GiveaVoucher — sell and manage digital gift vouchers online.
iWantFed — online ordering platform linked directly to TapaPOS.
TapaTable — manage table bookings and reservations from the POS.`;

        const siteTexts = await Promise.all(urls.map(fetchSiteText));
        let combined = (manual + "\n\n" + siteTexts.join("\n\n---\n\n"))
          .replace(/\b404\b/gi, "")
          .replace(/error\s*404/gi, "")
          .replace(/page not found/gi, "")
          .replace(/not\s*found/gi, "")
          .replace(/\s{2,}/g, " ")
          .trim()
          .slice(0, 24000);

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.5,
          max_tokens: 250,
          messages: [
            {
              role: "system",
              content:
                "You are Tappy, the helpful RST EPOS assistant. Respond conversationally and clearly. Offer troubleshooting or explanations where possible.",
            },
            { role: "user", content: `Context:\n${combined}\n\nUser:\n${message}` },
          ],
        });

        reply = formatReplyText(completion.choices[0].message.content.trim());
        supportCache[message] = reply;
        saveSupportCache();
        source = "OpenAI";
        s.step = "support_followup";
      }
    }

    reply +=
      `<br><br><small>📘 Source: ${source}</small><br><br>` +
      "Did that resolve your issue?<br>" +
      `<div class='cb-yesno'><button class='cb-btn-yes'>Yes</button>` +
      `<button class='cb-btn-no'>No</button></div>`;

    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 Tappy Brain v12.1 (Sales + FAQ + Cache + Source Labels) → http://localhost:${PORT}`)
);
