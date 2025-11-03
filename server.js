// =========================================
// RST EPOS Smart Chatbot v13.25 ("Tappy")
// ✅ Auto-detects environment (local vs live)
// ✅ Connects to Render API when deployed
// ✅ Handles send button + Enter key
// ✅ Appends user + bot messages with styling
// =========================================

console.log("🚀 Tappy Chatbot v13.25 Loaded:", new Date().toISOString());

// --- Detect environment + API base ---
const apiBase =
  window.location.hostname.includes("localhost") ||
  window.location.hostname.includes("127.0.0.1")
    ? "http://localhost:3001"
    : "https://tappy-chat.onrender.com"; // ✅ Render live API endpoint

console.log("🌐 Using API base:", apiBase);

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("cb-text");
  const send = document.getElementById("cb-send");
  const body = document.getElementById("cb-body");
  const fab = document.getElementById("cb-fab");
  const wrap = document.getElementById("cb-wrap");
  const close = document.getElementById("cb-close");

  // --- Toggle open/close ---
  fab?.addEventListener("click", () => {
    wrap.style.display = "flex";
    fab.style.display = "none";
    input.focus();
  });

  close?.addEventListener("click", () => {
    wrap.style.display = "none";
    fab.style.display = "flex";
  });

  // --- Send message ---
  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    appendMessage("user", text);
    input.value = "";

    try {
      const res = await fetch(`${apiBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      appendMessage("bot", data.reply || "⚠️ No reply from server.");
    } catch (err) {
      console.error("Chat error:", err);
      appendMessage("bot", "⚠️ Couldn’t reach chat service — please try again later.");
    }
  }

  // --- Append message to chat window ---
  function appendMessage(sender, text) {
    const div = document.createElement("div");
    div.className = `cb-msg ${sender}`;
    div.innerHTML = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  send?.addEventListener("click", sendMessage);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });
});
