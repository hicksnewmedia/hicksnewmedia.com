/* ════════════════════════════════════════════════════════════════════════
   HNM Chatbot — Ask James widget
   ════════════════════════════════════════════════════════════════════════
   Self-contained widget. Drop <script src="/hnm-chatbot.js" defer></script>
   on any HNM page and the floating button appears bottom-right.

   Special mode: if the page has a <div id="hnm-chatbot-fullscreen"></div>
   element (used on /ask), the widget renders inline + fullscreen there
   instead of floating.

   Features:
   • Floating bottom-right button
   • Slide-up chat panel
   • Persistent session ID (localStorage)
   • Message history in current session
   • Streaming-like UX via "thinking" indicator
   • Tool result rendering: booking CTA card + lead capture confirmation
   • GA4 event firing (chatbot_open, chatbot_message_sent, chatbot_booking_surfaced, chatbot_lead_captured)
   ════════════════════════════════════════════════════════════════════════ */

(function HnmChatbot() {
  "use strict";

  var ENDPOINT = "/.netlify/functions/ask-james";
  var STORAGE_SESSION_KEY = "hnm_chat_session_v1";
  var STORAGE_HISTORY_KEY = "hnm_chat_history_v1";
  var MAX_HISTORY_TURNS = 20; // keep last 20 turns to control payload size

  // ──── Inject styles ────
  var styles = document.createElement("style");
  styles.textContent = [
    "#hnm-chat-toggle{position:fixed;bottom:24px;right:24px;z-index:9998;width:56px;height:56px;border-radius:50%;background:var(--signal,#f48022);border:none;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;transition:transform 0.2s,background 0.2s;color:#0a0a0a;}",
    "#hnm-chat-toggle:hover{transform:scale(1.05);background:var(--signal-deep,#d96a14);}",
    "#hnm-chat-toggle svg{width:26px;height:26px;}",
    "#hnm-chat-toggle .badge{position:absolute;top:-4px;right:-4px;background:#0a0a0a;color:#f5f1eb;border-radius:12px;padding:2px 8px;font-size:0.7rem;font-family:'JetBrains Mono',monospace;letter-spacing:0.05em;text-transform:uppercase;border:1px solid #f48022;}",
    "#hnm-chat-panel{position:fixed;bottom:24px;right:24px;z-index:9999;width:min(440px,calc(100vw - 32px));height:min(640px,calc(100vh - 80px));background:#131313;border:1px solid rgba(245,241,235,0.22);box-shadow:0 24px 64px rgba(0,0,0,0.5);display:flex;flex-direction:column;transform:translateY(20px) scale(0.96);opacity:0;pointer-events:none;transition:transform 0.25s,opacity 0.25s;font-family:'Geist',-apple-system,sans-serif;}",
    "#hnm-chat-panel.open{transform:translateY(0) scale(1);opacity:1;pointer-events:auto;}",
    "#hnm-chatbot-fullscreen #hnm-chat-panel{position:relative;bottom:auto;right:auto;width:100%;max-width:880px;height:75vh;min-height:560px;margin:0 auto;transform:none;opacity:1;pointer-events:auto;}",
    "#hnm-chatbot-fullscreen #hnm-chat-toggle{display:none;}",
    ".hnm-chat-header{padding:16px 20px;border-bottom:1px solid rgba(245,241,235,0.1);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}",
    ".hnm-chat-header-title{font-family:'Fraunces',serif;font-size:1.05rem;font-weight:400;letter-spacing:-0.01em;color:#f5f1eb;display:flex;align-items:center;gap:10px;}",
    ".hnm-chat-header-title .pulse{width:8px;height:8px;border-radius:50%;background:#f48022;animation:hnmPulse 2s infinite;}",
    "@keyframes hnmPulse{0%,100%{opacity:1;}50%{opacity:0.4;}}",
    ".hnm-chat-header-meta{font-family:'JetBrains Mono',monospace;font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;color:rgba(245,241,235,0.45);}",
    ".hnm-chat-close{background:none;border:none;color:rgba(245,241,235,0.6);cursor:pointer;padding:4px 8px;font-size:1.4rem;line-height:1;transition:color 0.15s;}",
    ".hnm-chat-close:hover{color:#f5f1eb;}",
    ".hnm-chat-intro{padding:16px 20px;font-size:0.88rem;line-height:1.55;color:rgba(245,241,235,0.7);border-bottom:1px solid rgba(245,241,235,0.06);flex-shrink:0;}",
    ".hnm-chat-intro strong{color:#f48022;font-weight:500;}",
    ".hnm-chat-messages{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px;-webkit-overflow-scrolling:touch;}",
    ".hnm-chat-msg{max-width:88%;padding:11px 14px;font-size:0.92rem;line-height:1.5;color:#f5f1eb;border-radius:2px;}",
    ".hnm-chat-msg.user{align-self:flex-end;background:#232323;}",
    ".hnm-chat-msg.assistant{align-self:flex-start;background:transparent;padding-left:0;padding-right:0;color:rgba(245,241,235,0.92);}",
    ".hnm-chat-msg.assistant p{margin:0 0 10px;}",
    ".hnm-chat-msg.assistant p:last-child{margin-bottom:0;}",
    ".hnm-chat-msg.error{align-self:center;background:rgba(255,107,107,0.1);border:1px solid rgba(255,107,107,0.3);color:#ff9b9b;font-size:0.85rem;}",
    ".hnm-chat-typing{align-self:flex-start;display:flex;gap:4px;padding:11px 0;}",
    ".hnm-chat-typing span{width:6px;height:6px;border-radius:50%;background:#f48022;animation:hnmTypingDot 1.4s infinite both;}",
    ".hnm-chat-typing span:nth-child(2){animation-delay:0.2s;}",
    ".hnm-chat-typing span:nth-child(3){animation-delay:0.4s;}",
    "@keyframes hnmTypingDot{0%,80%,100%{opacity:0.3;transform:scale(0.8);}40%{opacity:1;transform:scale(1.1);}}",
    ".hnm-chat-card{align-self:stretch;background:#1a1a1a;border:1px solid rgba(244,128,34,0.4);padding:16px;border-radius:2px;}",
    ".hnm-chat-card-eyebrow{font-family:'JetBrains Mono',monospace;font-size:0.7rem;letter-spacing:0.1em;text-transform:uppercase;color:#f48022;margin-bottom:8px;}",
    ".hnm-chat-card-title{font-family:'Fraunces',serif;font-size:1.1rem;font-weight:400;letter-spacing:-0.01em;color:#f5f1eb;margin:0 0 6px;line-height:1.2;}",
    ".hnm-chat-card-body{font-size:0.85rem;line-height:1.5;color:rgba(245,241,235,0.7);margin:0 0 12px;}",
    ".hnm-chat-card-btn{display:inline-block;background:#f48022;color:#0a0a0a;padding:9px 16px;font-size:0.85rem;font-weight:600;text-decoration:none;font-family:inherit;border:none;cursor:pointer;}",
    ".hnm-chat-card-btn:hover{background:#d96a14;}",
    ".hnm-chat-card.lead{border-color:rgba(245,241,235,0.22);}",
    ".hnm-chat-card.lead .hnm-chat-card-eyebrow{color:#f5f1eb;}",
    ".hnm-chat-form{display:flex;gap:0;border-top:1px solid rgba(245,241,235,0.1);flex-shrink:0;}",
    ".hnm-chat-form input{flex:1;background:transparent;border:none;padding:16px 18px;font-family:inherit;font-size:0.92rem;color:#f5f1eb;outline:none;min-width:0;}",
    ".hnm-chat-form input::placeholder{color:rgba(245,241,235,0.35);}",
    ".hnm-chat-form button{background:#f48022;color:#0a0a0a;border:none;padding:0 22px;font-family:inherit;font-size:1.1rem;cursor:pointer;font-weight:600;transition:background 0.15s;}",
    ".hnm-chat-form button:hover{background:#d96a14;}",
    ".hnm-chat-form button:disabled{opacity:0.5;cursor:not-allowed;}",
    ".hnm-chat-footer{padding:8px 20px 12px;font-family:'JetBrains Mono',monospace;font-size:0.66rem;letter-spacing:0.06em;text-transform:uppercase;color:rgba(245,241,235,0.35);text-align:center;flex-shrink:0;}",
    "@media (max-width:540px){#hnm-chat-panel{bottom:0;right:0;left:0;width:100%;height:100%;max-height:100vh;}#hnm-chat-toggle{bottom:16px;right:16px;}}",
  ].join("\n");
  document.head.appendChild(styles);

  // ──── Persistent session ID ────
  var sessionId;
  try {
    sessionId = localStorage.getItem(STORAGE_SESSION_KEY);
    if (!sessionId) {
      sessionId = "hnm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(STORAGE_SESSION_KEY, sessionId);
    }
  } catch (e) {
    sessionId = "hnm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  // ──── In-memory message history (per session) ────
  var history = [];
  try {
    var saved = sessionStorage.getItem(STORAGE_HISTORY_KEY);
    if (saved) history = JSON.parse(saved);
  } catch (e) {}

  function saveHistory() {
    try {
      var trimmed = history.slice(-MAX_HISTORY_TURNS * 2);
      sessionStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(trimmed));
    } catch (e) {}
  }

  // ──── GA4 helper ────
  function track(name, params) {
    if (typeof window.hnmTrack === "function") {
      window.hnmTrack(name, params || {});
    }
  }

  // ──── Build the panel HTML ────
  function buildPanel() {
    var panel = document.createElement("div");
    panel.id = "hnm-chat-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Ask James AI assistant");
    panel.innerHTML = [
      '<div class="hnm-chat-header">',
      '  <div class="hnm-chat-header-title"><span class="pulse"></span>Ask James</div>',
      '  <div style="display:flex;align-items:center;gap:12px;">',
      '    <span class="hnm-chat-header-meta">AI · Beta</span>',
      '    <button class="hnm-chat-close" aria-label="Close chat">×</button>',
      "  </div>",
      "</div>",
      '<div class="hnm-chat-intro">',
      '  Hi, I\'m an <strong>AI version of James</strong>, trained on his work and editorial voice. Ask about partnerships, case studies, the network, or anything on this site.',
      "</div>",
      '<div class="hnm-chat-messages" id="hnm-chat-messages"></div>',
      '<form class="hnm-chat-form" id="hnm-chat-form" autocomplete="off">',
      '  <input type="text" name="msg" placeholder="Ask anything..." aria-label="Type your message" maxlength="2000" />',
      '  <button type="submit" aria-label="Send">↑</button>',
      "</form>",
      '<div class="hnm-chat-footer">No hype. Just the facts. · Conversations may be logged.</div>',
    ].join("");
    return panel;
  }

  // ──── Render a message bubble ────
  function renderMessage(text, role, opts) {
    opts = opts || {};
    var msgs = document.getElementById("hnm-chat-messages");
    if (!msgs) return;

    var el = document.createElement("div");
    el.className = "hnm-chat-msg " + role + (opts.error ? " error" : "");
    if (role === "assistant" && !opts.error) {
      // Split on double newline into paragraphs, escape HTML
      var parts = String(text).split(/\n\n+/);
      el.innerHTML = parts.map(function (p) {
        return "<p>" + escapeHtml(p).replace(/\n/g, "<br>") + "</p>";
      }).join("");
    } else {
      el.textContent = text;
    }
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function renderTyping() {
    var msgs = document.getElementById("hnm-chat-messages");
    if (!msgs) return null;
    var el = document.createElement("div");
    el.className = "hnm-chat-typing";
    el.id = "hnm-chat-typing-indicator";
    el.innerHTML = "<span></span><span></span><span></span>";
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function removeTyping() {
    var el = document.getElementById("hnm-chat-typing-indicator");
    if (el) el.remove();
  }

  function renderBookingCard(reason) {
    var msgs = document.getElementById("hnm-chat-messages");
    if (!msgs) return;
    var card = document.createElement("div");
    card.className = "hnm-chat-card";
    card.innerHTML = [
      '<div class="hnm-chat-card-eyebrow">Partnership inquiry</div>',
      '<h3 class="hnm-chat-card-title">Talk to James directly</h3>',
      '<p class="hnm-chat-card-body">Book a partnership call. 15–30 minutes, no pitch deck required.</p>',
      '<a href="/book" data-cal-link="jameshicks" data-cal-namespace="" class="hnm-chat-card-btn" data-track="booking-card">Book a Call →</a>',
    ].join("");
    msgs.appendChild(card);
    msgs.scrollTop = msgs.scrollHeight;

    // GA4 event
    track("chatbot_booking_surfaced", { reason: (reason || "").slice(0, 100) });

    // Track click — Cal.com auto-attaches modal trigger via data-cal-link attribute,
    // but for dynamically-added buttons we also explicitly call Cal("modal") to be safe.
    var btn = card.querySelector("[data-track=booking-card]");
    if (btn) {
      btn.addEventListener("click", function (e) {
        track("chatbot_booking_click", { source: "ai-card" });
        if (typeof window.Cal === "function") {
          e.preventDefault();
          window.Cal("modal", {
            calLink: "jameshicks",
            config: { layout: "month_view" }
          });
        }
        // If Cal isn't loaded, href="/book" fallback navigation runs naturally
      });
    }
  }

  function renderLeadConfirmation(input) {
    var msgs = document.getElementById("hnm-chat-messages");
    if (!msgs) return;
    var card = document.createElement("div");
    card.className = "hnm-chat-card lead";
    card.innerHTML = [
      '<div class="hnm-chat-card-eyebrow">Inquiry submitted</div>',
      '<h3 class="hnm-chat-card-title">Thanks, ' + escapeHtml(input.name) + ".</h3>",
      '<p class="hnm-chat-card-body">James will follow up within 24–48 hours at <strong>' + escapeHtml(input.email) + "</strong>.</p>",
    ].join("");
    msgs.appendChild(card);
    msgs.scrollTop = msgs.scrollHeight;

    track("chatbot_lead_captured", {
      inquiry_type: input.inquiry || "unknown",
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ──── Send a message ────
  var isSending = false;
  async function sendMessage(text) {
    if (isSending) return;
    if (!text || !text.trim()) return;

    var trimmed = text.trim().slice(0, 2000);
    renderMessage(trimmed, "user");
    history.push({ role: "user", content: trimmed });
    saveHistory();

    track("chatbot_message_sent", { length: trimmed.length });

    isSending = true;
    var form = document.getElementById("hnm-chat-form");
    var input = form.querySelector("input");
    var btn = form.querySelector("button");
    input.value = "";
    input.disabled = true;
    btn.disabled = true;
    renderTyping();

    try {
      var res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history: history.slice(0, -1), // exclude the just-added user message
          sessionId: sessionId,
        }),
      });

      removeTyping();

      if (res.status === 429) {
        var data = await res.json();
        renderMessage(data.error || "Rate limit hit. Please wait a bit.", "assistant", { error: true });
        return;
      }
      if (res.status === 503) {
        var data = await res.json();
        renderMessage(data.error || "Ask James is offline. Please use the contact form.", "assistant", { error: true });
        return;
      }
      if (!res.ok) {
        var errData = {};
        try { errData = await res.json(); } catch (e) {}
        renderMessage(errData.error || "Something went wrong. Please try again or use the contact form.", "assistant", { error: true });
        return;
      }

      var data = await res.json();
      if (data.text) {
        renderMessage(data.text, "assistant");
        history.push({ role: "assistant", content: data.text });
        saveHistory();
      }

      if (data.tool && data.tool.name === "surface_booking") {
        renderBookingCard(data.tool.input?.reason);
      }
      if (data.leadCaptured && data.tool && data.tool.name === "capture_lead") {
        renderLeadConfirmation(data.tool.input);
      }
    } catch (err) {
      removeTyping();
      renderMessage("Connection issue. Please try again or use the contact form.", "assistant", { error: true });
    } finally {
      isSending = false;
      input.disabled = false;
      btn.disabled = false;
      input.focus();
    }
  }

  // ──── Wire up the panel ────
  var panelEl = null;
  var hasOpenedOnce = false;

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = buildPanel();

    var container = document.getElementById("hnm-chatbot-fullscreen");
    if (container) {
      container.appendChild(panelEl);
      panelEl.classList.add("open");
    } else {
      document.body.appendChild(panelEl);
    }

    // Restore history visually on first build
    history.forEach(function (m) {
      renderMessage(m.content, m.role);
    });

    // Wire close
    var closeBtn = panelEl.querySelector(".hnm-chat-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        panelEl.classList.remove("open");
      });
    }

    // Wire form
    var form = panelEl.querySelector("#hnm-chat-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = form.querySelector("input");
      sendMessage(input.value);
    });

    // Focus input when opened
    setTimeout(function () {
      var input = panelEl.querySelector("input");
      if (input) input.focus();
    }, 300);

    return panelEl;
  }

  function openPanel() {
    var p = ensurePanel();
    p.classList.add("open");
    if (!hasOpenedOnce) {
      track("chatbot_open", { session_id: sessionId });
      hasOpenedOnce = true;
    }
  }

  function closePanel() {
    if (panelEl) panelEl.classList.remove("open");
  }

  // ──── Build floating toggle button (skipped on fullscreen page) ────
  function init() {
    var fullscreenContainer = document.getElementById("hnm-chatbot-fullscreen");

    if (fullscreenContainer) {
      // Fullscreen mode: build panel immediately inside the container, no toggle
      ensurePanel();
      track("chatbot_open", { mode: "fullscreen", session_id: sessionId });
      return;
    }

    // Floating mode: build the toggle button
    var btn = document.createElement("button");
    btn.id = "hnm-chat-toggle";
    btn.setAttribute("aria-label", "Open Ask James chatbot");
    btn.innerHTML = [
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
      '  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
      "</svg>",
      '<span class="badge">Ask</span>',
    ].join("");
    document.body.appendChild(btn);

    btn.addEventListener("click", function () {
      if (panelEl && panelEl.classList.contains("open")) {
        closePanel();
      } else {
        openPanel();
      }
    });

    // Escape key closes
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panelEl && panelEl.classList.contains("open")) {
        closePanel();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
