// =========================================
// RST EPOS Smart Chatbot API v12.1 ("Tappy Brain")
// ✅ Render-ready version (no 'window' reference)
// ✅ Uses process.env.PORT for hosting
// ✅ Adds root route + /test route to confirm POST works
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
const PORT = process.env.PORT || 3001; // ✅ Render assigns this dynamically
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
  res.send("✅ Tappy Chatbot API is running on Render!");
});

// ------------------------------------------------------
// ✅ Test POST endpoint to confirm API connection
// ------------------------------------------------------
app.post("/test", (req, res) => {
  console.log("✅ /test endpoint hit");
  res.json({ ok: true, msg: "Tappy test endpoint working on Render!" });
});

// ------------------------------------------------------
// 🧾 Utilities (unchanged)
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
// 💬 Chat route (keep your existing logic)
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
    // Existing chatbot logic continues here...
    res.json({ reply: `Echo test: ${message}` }); // temporary minimal reply for testing
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ------------------------------------------------------
// 🚀 Start server
// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Tappy Brain v12.1 running on port ${PORT}`);
});
