// =========================================
// RST EPOS Smart Chatbot API v9.25 ("Tappy Brain")
// ✅ Context-aware informational modules
// ✅ Remembers conversation topics (payments, vouchers, ordering, reservations)
// ✅ Handles "yes" follow-ups for GiveaVoucher & iWantFed
// ✅ Only triggers sales flow on explicit pricing intent
// ✅ Keeps quote/demo, support, and follow-up logic
// ✅ Handles { reset:true } safely & auto-expires sessions
// =========================================

import express from "express";
import OpenAI from "openai";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const PORT = 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const salesLeadsPath = path.join(__dirname, "sales_leads.jsonl");
const sessionStorePath = path.join(__dirname, "sessions.json");

// --- Load FAQ files ---
function loadFAQ(file) {
  const full = path.join(__dirname, file);
  return fs.existsSync(full)
    ? JSON.parse(fs.readFileSync(full, "utf8"))
    : [];
}
const faqs = {
  support: loadFAQ("faqs_support.json"),
  sales: loadFAQ("faqs_sales.json"),
  general: loadFAQ("faqs_general.json"),
};

// --- Load / Save Sessions ---
function loadSessions() {
  if (fs.existsSync(sessionStorePath)) {
    try {
      return JSON.parse(fs.readFileSync(sessionStorePath, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}
function saveSessions() {
  fs.writeFileSync(sessionStorePath, JSON.stringify(sessions, null, 2));
}
let sessions = loadSessions();

// --- 🧹 Auto-expire sessions older than 12 hours ---
function cleanupSessions() {
  const now = Date.now();
  const cutoff = 12 * 60 * 60 * 1000;
  let removed = 0;
  for (const [ip, s] of Object.entries(sessions)) {
    if (!s.timestamp || now - s.timestamp > cutoff) {
      delete sessions[ip];
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`🧹 Cleaned up ${removed} expired sessions`);
    saveSessions();
  }
}
cleanupSessions();

app.use(express.json());
app.use(
  cors({
    origin: [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
    ],
    methods: ["GET", "POST"],
  })
);
app.use(rateLimit({ windowMs: 60 * 1000, max: 40 }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------- Helpers ----------------
const getSession = (ip) => {
  if (!sessions[ip]) {
    sessions[ip] = {
      step: "none",
      context: "general",
      topic: null, // ✅ new topic memory
      awaitingQuoteDecision: false,
      pendingTypo: null,
      salesLead: {},
      lastMessage: "",
      timestamp: Date.now(),
    };
    saveSessions();
  }
  sessions[ip].timestamp = Date.now();
  saveSessions();
  return sessions[ip];
};
const resetSession = (ip) => {
  delete sessions[ip];
  saveSessions();
};

const formatSteps = (t) =>
  t
    .replace(/\n+/g, "<br>")
    .replace(/(Step\s?\d+[:.)])/gi, "<br><strong>$1</strong> ")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/<br><br>/g, "<br>");

const logJSON = (file, data) =>
  fs.appendFileSync(
    file,
    JSON.stringify({ time: new Date().toISOString(), ...data }) + "\n"
  );

const validDomains = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com"];
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

function detectEmailTypo(email) {
  const lower = email.toLowerCase().trim();
  const domain = lower.split("@")[1];
  if (!domain) return null;
  const corrections = {
    "gamil.com": "gmail.com",
    "gmal.com": "gmail.com",
    "gnail.com": "gmail.com",
    "gmail.con": "gmail.com",
    "outlok.com": "outlook.com",
    "outlook.cmo": "outlook.com",
    "hotmial.com": "hotmail.com",
    "yahho.com": "yahoo.com",
    "yahoo.con": "yahoo.com",
    "iclod.com": "icloud.com",
    "icloud.cmo": "icloud.com",
  };
  if (corrections[domain]) return lower.replace(domain, corrections[domain]);
  for (const valid of validDomains) {
    const short = valid.replace(".com", "");
    if (domain === short) return lower.replace(domain, valid);
  }
  return null;
}

// ---------------- Intent Detection ----------------
function isSalesIntent(message) {
  if (!message) return false;
  const text = message.toLowerCase();
  const patterns = [
    /\b(price|cost|quote|quotation|pricing|rate|fees?|charge|charges?)\b/,
    /\b(how much|what('?s| is) the price|pricing|how many)\b/,
    /\b(buy|purchase|order|get started|sign up|setup cost|install cost)\b/,
    /\b(demo|trial|presentation|walkthrough|quote request)\b/,
    /\b(plan|plans|package|bundle|subscription|monthly|yearly)\b/,
  ];
  return patterns.some((p) => p.test(text));
}

// ---------------- Topic Detection ----------------
function detectTopic(text) {
  if (/\b(card|tapapay|payment|terminal|epos|ped|merchant|reader|stripe|worldpay|trustpayments|dojo|globalpayments)\b/i.test(text))
    return "payments";
  if (/\bvoucher|giveavoucher|gift\b/i.test(text))
    return "vouchers";
  if (/\biwantfed|order online|online ordering|menu\b/i.test(text))
    return "onlineordering";
  if (/\bbooking|resdiary|table|reservation|guestline|mews|protel\b/i.test(text))
    return "reservations";
  return null;
}

// ---------------- findFaqMatch ----------------
function findFaqMatch(message, context = "general", topic = null) {
  const msg = message.toLowerCase().trim();
  if (!msg) return null;

  const stopWords = new Set([
    "the","is","a","an","and","of","for","on","at","to","in","it","no","not","please","help",
    "my","our","we","issue","problem","showing","stopped","working","doesn’t","doesnt",
    "won’t","wont","turn","on","off","up","down","any","can","you","i","me"
  ]);

  const msgWords = msg.split(/\s+/).filter((w) => w && !stopWords.has(w));

  const topics = {
    payments: ["payment","card","terminal","tapapay","stripe","worldpay","trustpayments","dojo","globalpayments","integrated"],
    vouchers: ["voucher","giveavoucher","gift"],
    onlineordering: ["order","iwantfed","delivery","pickup","menu","online"],
    reservations: ["booking","resdiary","table","guestline","mews","protel"],
  };

  let searchOrder;
  if (context === "sales") searchOrder = [faqs.sales, faqs.support, faqs.general];
  else if (context === "support") searchOrder = [faqs.support, faqs.sales, faqs.general];
  else searchOrder = [faqs.sales, faqs.support, faqs.general];

  let best = null;
  let highest = 0;

  for (const set of searchOrder) {
    for (const faq of set) {
      for (const q of faq.questions) {
        const qWords = q.toLowerCase().split(/\s+/).filter((w) => w && !stopWords.has(w));
        const shared = msgWords.filter((w) => qWords.includes(w));
        if (shared.length === 0) continue;

        // topic bias
        let topicBoost = 0;
        if (topic && topics[topic]) {
          const topicHits = qWords.filter((w) => topics[topic].includes(w));
          if (topicHits.length >= 2) topicBoost = 0.25;
        }

        const ratio = shared.length / Math.max(msgWords.length, qWords.length);
        if (shared.length === 1 && msgWords.length > 2) continue;

        const score = ratio + topicBoost;
        if (score > highest) {
          highest = score;
          best = faq;
        }
      }
    }
    if (highest >= 0.65) break;
  }

  if (highest >= 0.45 && best) {
    return {
      icon: best.icon || "💬",
      category: best.category || context,
      result: best.answers.join("<br>"),
    };
  }
  return null;
}

// ---------------- Main Route ----------------
app.post("/api/chat", async (req, res) => {
  cleanupSessions();

  const { message, context = "general", reset = false } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  if (reset === true) {
    resetSession(ip);
    console.log(`♻️ Session reset (${ip})`);
    return res.json({
      reply: "👋 Hi there! I’m Tappy, your RST EPOS assistant.<br>How can I help today?",
    });
  }

  if (!message || typeof message !== "string")
    return res.status(400).json({ error: "Missing or invalid message" });

  const lower = message.toLowerCase().trim();
  const session = getSession(ip);
  session.timestamp = Date.now();
  session.lastMessage = message;

  // detect and store topic context
  const detectedTopic = detectTopic(lower);
  if (detectedTopic) session.topic = detectedTopic;
  saveSessions();

  try {
    // ===== YES RESPONSES FOR MODULE FOLLOW-UPS =====
    if (lower === "yes" && session.context === "support") {
      if (session.lastMessage === "GiveaVoucherIntro") {
        session.lastMessage = "GiveaVoucherFollowup";
        saveSessions();
        return res.json({
          reply:
            "📲 Customers can buy vouchers directly from your GiveaVoucher page or QR code.<br><br>" +
            "Purchases are processed online and emailed instantly. When redeemed, staff scan or enter the code in TapaPOS — balances update automatically.<br><br>" +
            "Would you like to see how to create a new voucher template in Tapa Office?<br>" +
            `<div class='cb-yesno'><button class='cb-btn-yes'>Yes</button>` +
            `<button class='cb-btn-no'>No</button></div>`,
        });
      }

      if (session.lastMessage === "iWantFedIntro") {
        session.lastMessage = "iWantFedFollowup";
        saveSessions();
        return res.json({
          reply:
            "🛍️ With <strong>iWantFed</strong>, customers browse your menu, order, and pay online.<br><br>" +
            "Orders appear instantly on your TapaPOS and Kitchen Display Screens so prep starts right away.<br><br>" +
            "Would you like to see how menus link from Tapa Office to iWantFed?<br>" +
            `<div class='cb-yesno'><button class='cb-btn-yes'>Yes</button>` +
            `<button class='cb-btn-no'>No</button></div>`,
        });
      }
    }

    // ===== GREETING =====
    if (/^(hi|hello|hey|good\s(morning|afternoon|evening))\b/i.test(lower)) {
      return res.json({
        reply:
          "👋 Hi there! I’m Tappy, your RST EPOS assistant.<br>How can I help today — for example *‘set up vouchers’* or *‘online ordering setup’*?",
      });
    }

    // ===== 🎁 GIVEAVOUCHER SHORTCUT =====
    if (/\bgiveavoucher|vouchers?|gift voucher\b/i.test(lower)) {
      session.context = "support";
      session.lastMessage = "GiveaVoucherIntro";
      session.topic = "vouchers";
      saveSessions();
      return res.json({
        reply:
          "🎁 <strong>GiveaVoucher</strong> lets you sell and manage digital gift vouchers online.<br><br>" +
          "To set it up, open <strong>Tapa Office → Gift Vouchers → GiveaVoucher Setup Assistant</strong>.<br><br>" +
          "📌 Design templates, create promotions, and track voucher sales automatically.<br><br>" +
          "Would you like to see how customers buy and redeem vouchers online?<br>" +
          `<div class='cb-yesno'><button class='cb-btn-yes'>Yes</button>` +
          `<button class='cb-btn-no'>No</button></div>`,
      });
    }

    // ===== 🍽️ IWANTFED SHORTCUT =====
    if (/\biwantfed|online ordering|order online\b/i.test(lower)) {
      session.context = "support";
      session.lastMessage = "iWantFedIntro";
      session.topic = "onlineordering";
      saveSessions();
      return res.json({
        reply:
          "🍽️ <strong>iWantFed</strong> lets your customers place online orders from your branded menu.<br><br>" +
          "To enable it, go to <strong>Tapa Office → Online Ordering → iWantFed Setup</strong>.<br><br>" +
          "📌 Publish menus, manage pickup & delivery slots, and link payments via TapaPay.<br><br>" +
          "Would you like an example of how orders flow from iWantFed into TapaPOS?<br>" +
          `<div class='cb-yesno'><button class='cb-btn-yes'>Yes</button>` +
          `<button class='cb-btn-no'>No</button></div>`,
      });
    }

    // ===== 💰 DIRECT SALES INTENT =====
    if (isSalesIntent(message)) {
      console.log(`🎯 Sales intent detected from: "${message}"`);
      session.awaitingQuoteDecision = true;
      session.context = "sales";
      session.step = "none";
      saveSessions();
      return res.json({
        reply:
          "💡 It sounds like you’re interested in pricing, a quote, or a demo.<br>" +
          "Would you like to start a personalised quote or arrange a demo with our sales team?<br><br>" +
          `<div class='cb-yesno'><button class='cb-btn-yes'>Yes</button>` +
          `<button class='cb-btn-no'>No</button></div>`,
      });
    }

    // ===== FAQ SEARCH (with topic) =====
    const faq = findFaqMatch(message, context, session.topic);
    if (faq) {
      const isSalesCategory =
        faq.category?.toLowerCase().includes("sales") ||
        isSalesIntent(message) ||
        /(price|cost|quote|demo|install|package|monthly|hardware|buy|setup|rate)/i.test(faq.result);

      if (isSalesCategory) {
        session.awaitingQuoteDecision = true;
        session.step = "none";
        session.context = "sales";
        saveSessions();
        return res.json({
          reply:
            `${faq.icon} <strong>${faq.category}</strong><br>${formatSteps(faq.result)}<br><br>` +
            `<small style='color:#888;'>(📘 SALES FAQ)</small><br><br>` +
            `Would you like a personalised quote or demo?<br>` +
            `<div class='cb-yesno'><button class='cb-btn-yes'>Yes</button>` +
            `<button class='cb-btn-no'>No</button></div>`,
        });
      }

      session.step = "followup";
      session.context = "support";
      saveSessions();
      return res.json({
        reply:
          `${faq.icon} <strong>${faq.category}</strong><br>${formatSteps(faq.result)}<br><br>` +
          `<small style='color:#888;'>(📘 ${context.toUpperCase()} FAQ)</small><br><br>` +
          `Did that resolve your issue?<br>` +
          `<div class='cb-yesno'><button class='cb-btn-yes'>Yes</button>` +
          `<button class='cb-btn-no'>No</button></div>`,
      });
    }

    // ===== FALLBACK (OpenAI with topic bias) =====
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are Tappy, the RST EPOS assistant. 
Respond only about RST EPOS, TapaPOS, TapaPay, TapaOffice, GiveaVoucher, iWantFed, and TapaTable.
Current topic: ${session.topic || "general"}.
Keep responses concise and relevant.`,
        },
        { role: "user", content: message },
      ],
      temperature: 0.4,
      max_tokens: 180,
    });

    const reply =
      formatSteps(completion.choices[0].message.content) +
      `<br><br><small style='color:#888;'>(🤖 Generated from OpenAI)</small>`;
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 Tappy Brain v9.25 (Topic Memory) running on http://localhost:${PORT}`)
);
