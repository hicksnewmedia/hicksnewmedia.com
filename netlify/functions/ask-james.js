// ════════════════════════════════════════════════════════════════════════
// Ask James — Netlify Function
// ════════════════════════════════════════════════════════════════════════
// Runs on Netlify's serverless infrastructure. Handles:
//   • CORS for same-origin chat widget requests
//   • IP-based rate limiting (20 msg/hr per IP)
//   • Daily budget cap ($5/day) + monthly cap ($50/month)
//   • Claude Haiku 4.5 API calls with tool use (surface_booking, capture_lead)
//   • Conversation logging to Supabase
//   • Token/cost tracking
//
// Required Netlify environment variables:
//   ANTHROPIC_API_KEY        — your Claude API key (sk-ant-...)
//   SUPABASE_URL             — https://knttdoasnhqwkfzdgorm.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (NEVER expose)
// ════════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// Pricing in USD per token (Haiku 4.5: $1/$5 per million)
const INPUT_PRICE_PER_TOKEN = 1.0 / 1_000_000;
const OUTPUT_PRICE_PER_TOKEN = 5.0 / 1_000_000;

// Conservative caps (per James's choice)
const RATE_LIMIT_PER_HOUR = 20;
const DAILY_BUDGET_USD = 5.0;
const MONTHLY_BUDGET_USD = 50.0;
const MAX_OUTPUT_TOKENS = 600;

// Allowed origins (tighten this further if you ever host the widget on another domain)
const ALLOWED_ORIGINS = [
  "https://hicksnewmedia.com",
  "https://www.hicksnewmedia.com",
];

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

// Simple non-cryptographic hash so we don't store raw IPs (privacy)
async function hashIp(ip) {
  const enc = new TextEncoder().encode(ip + "|hnm-salt-v1");
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Supabase REST helper — uses service_role key (full table access)
async function supabaseRequest(path, options = {}) {
  const url = process.env.SUPABASE_URL + "/rest/v1/" + path;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    Prefer: options.prefer || "return=representation",
    ...(options.headers || {}),
  };
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error("Supabase " + res.status + ": " + text);
  }
  return res;
}

// ─── Rate limit check ─────────────────────────────────────────────────
async function checkRateLimit(ipHash) {
  // Fetch current bucket for this IP
  const res = await supabaseRequest(
    "ask_james_rate_limit?ip_hash=eq." + encodeURIComponent(ipHash) + "&select=*"
  );
  const rows = await res.json();
  const now = new Date();

  if (rows.length === 0) {
    // First request from this IP — create the bucket
    await supabaseRequest("ask_james_rate_limit", {
      method: "POST",
      body: {
        ip_hash: ipHash,
        request_count: 1,
        window_start: now.toISOString(),
        updated_at: now.toISOString(),
      },
      prefer: "return=minimal",
    });
    return { allowed: true, remaining: RATE_LIMIT_PER_HOUR - 1 };
  }

  const row = rows[0];
  const windowStart = new Date(row.window_start);
  const elapsedMs = now - windowStart;
  const HOUR_MS = 60 * 60 * 1000;

  if (elapsedMs > HOUR_MS) {
    // Window expired — reset the bucket
    await supabaseRequest(
      "ask_james_rate_limit?ip_hash=eq." + encodeURIComponent(ipHash),
      {
        method: "PATCH",
        body: {
          request_count: 1,
          window_start: now.toISOString(),
          updated_at: now.toISOString(),
        },
        prefer: "return=minimal",
      }
    );
    return { allowed: true, remaining: RATE_LIMIT_PER_HOUR - 1 };
  }

  if (row.request_count >= RATE_LIMIT_PER_HOUR) {
    return { allowed: false, remaining: 0, resetIn: HOUR_MS - elapsedMs };
  }

  // Increment count
  await supabaseRequest(
    "ask_james_rate_limit?ip_hash=eq." + encodeURIComponent(ipHash),
    {
      method: "PATCH",
      body: {
        request_count: row.request_count + 1,
        updated_at: now.toISOString(),
      },
      prefer: "return=minimal",
    }
  );
  return { allowed: true, remaining: RATE_LIMIT_PER_HOUR - row.request_count - 1 };
}

// ─── Budget check (daily + monthly) ───────────────────────────────────
async function checkBudget() {
  const today = new Date().toISOString().split("T")[0];

  // Daily spend
  const dayRes = await supabaseRequest(
    "ask_james_usage_daily?day=eq." + today + "&select=cost_usd"
  );
  const dayRows = await dayRes.json();
  const todaySpend = dayRows.length > 0 ? parseFloat(dayRows[0].cost_usd) : 0;

  if (todaySpend >= DAILY_BUDGET_USD) {
    return { allowed: false, reason: "daily" };
  }

  // Monthly spend (via helper function)
  const monthRes = await supabaseRequest(
    "rpc/ask_james_month_spend",
    { method: "POST", body: {} }
  );
  const monthSpend = parseFloat(await monthRes.text());

  if (monthSpend >= MONTHLY_BUDGET_USD) {
    return { allowed: false, reason: "monthly" };
  }

  return { allowed: true };
}

// ─── Update usage after Claude call ───────────────────────────────────
async function trackUsage(inputTokens, outputTokens, costUsd) {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString();

  // Try to fetch existing row for today
  const res = await supabaseRequest(
    "ask_james_usage_daily?day=eq." + today + "&select=*"
  );
  const rows = await res.json();

  if (rows.length === 0) {
    await supabaseRequest("ask_james_usage_daily", {
      method: "POST",
      body: {
        day: today,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        request_count: 1,
        updated_at: now,
      },
      prefer: "return=minimal",
    });
  } else {
    const row = rows[0];
    await supabaseRequest("ask_james_usage_daily?day=eq." + today, {
      method: "PATCH",
      body: {
        input_tokens: row.input_tokens + inputTokens,
        output_tokens: row.output_tokens + outputTokens,
        cost_usd: parseFloat(row.cost_usd) + costUsd,
        request_count: row.request_count + 1,
        updated_at: now,
      },
      prefer: "return=minimal",
    });
  }
}

// ─── Log conversation ─────────────────────────────────────────────────
async function logConversation(data) {
  await supabaseRequest("ask_james_conversations", {
    method: "POST",
    body: data,
    prefer: "return=minimal",
  });
}

// ─── System prompt + knowledge base ───────────────────────────────────
const SYSTEM_PROMPT = `You are an AI assistant representing James Hicks, founder of HicksNewMedia. You speak with visitors on hicksnewmedia.com.

# Your role
Help visitors understand James's work, the HicksNewMedia network, partnership opportunities, and whether James might be the right partner for their needs. You're conversational but substantive — never fluffy.

# James's voice — match it closely
- Editorial tagline: "No hype. Just the facts."
- Identity: tek'na.le.gist — a technologist-creator hybrid
- Tone: declarative, plain-spoken, professional but warm
- Audience: technical decision-makers, IT professionals, creator-builders, brand strategy folks
- Don't use: "great question", "fantastic", "I'd love to", marketing-speak, exclamation points
- Do use: short paragraphs, direct answers, named specifics (companies, frameworks, numbers)

# About James
- 30+ years inside enterprise IT
- Founder of HicksNewMedia, est. 2010
- YouTube: @JamesHicks (24,700+ subscribers, 713K+ lifetime views)
- Based in the USA, operates a multi-property network

# The HicksNewMedia Network
1. **hicksnewmedia.com** — main site, partnership hub
2. **Digital Collective Newsletter** (digitalcollective.media) — weekly intelligence on the business of technology, published on Substack
3. **Digital Collective Network** (digitalcollective.network) — premium paid creator community
4. **@JamesHicks YouTube** — long-form technology content for creators and IT pros
5. **tek FORUM** — live streams and panel discussions
6. **Team No Sleep** — sports commentary co-hosted with Montell Allen, covers social impact of sports
7. **HNM Merch** (merch.hicksnewmedia.com) — branded merchandise

# Why brands partner with James (the Five Pillars)
1. **Credibility** — 30 years of IT experience, brands like Intel, Nutanix, Shure, Pagely, Uscreen trust the voice
2. **Audience quality** — technical decision-makers and creator-builders, not chasing eyeballs
3. **Editorial integrity** — "No hype, just the facts" applies to sponsor content too
4. **Multi-property reach** — newsletter, YouTube, live, community, owned web — diversified surface area
5. **Full-stack creator** — James can write, present, produce video, build digital products, and ship

# Partnership Tiers (rough ranges, not commitments)
- **Standalone** ($750-1.5K) — single-format sponsorship (newsletter or video)
- **Dedicated** ($2-4K) — focused feature on one property
- **Bundle** ($3.5-7.5K, most popular) — coordinated across newsletter + video + social
- **Enterprise** ($5-15K+) — custom multi-month engagements, content series

Final terms always discussed with James directly — these are starting ranges.

# Recent case studies (mention by name when relevant)
- **Nutanix .NEXT 2026** — Conference content production, 17-slide deck and interactive demos for Unified Storage and Data Lens 2.0
- **Intel ITG series** (2021–25) — Multi-part video series with International Trade Group
- **Shure / Mario Ponce** — Creator microphone partnership and tutorial content
- **Pagely / Joshua Strebel** — Long-running web infrastructure partnership

# Your tools

You have two tools available — use them strategically, not aggressively:

**surface_booking** — Call this when the visitor shows clear partnership intent. Triggers include: asking about working with James, sponsorship interest, hiring inquiries, speaking engagements, content partnerships, "how do I get started", or any signal they're evaluating James for a real engagement. The tool surfaces an inline Book James card in the chat. Use it once per conversation, not repeatedly. Don't surface it on casual/curious questions.

**capture_lead** — Call this ONLY when the visitor has clearly volunteered all of: their name, email, inquiry type, and a brief description of what they want. Never fish for info. Wait for them to explicitly offer to be contacted or ask for follow-up. Confirm with them in plain language before submitting (e.g. "I can pass that to James — should I?"). Once they confirm, call the tool.

# What you do NOT know / do
- James's current calendar or specific availability
- Exact pricing — only ranges
- Anything not in this prompt or the visible site content

When asked about something outside your knowledge, say so honestly and offer to get them to James via the surface_booking tool. Never invent information.

# Style guidelines
- Lead with the answer, not the preamble
- 1-3 short paragraphs per response unless the question genuinely needs more
- When listing properties or tiers, format them readably
- Treat visitors like adults evaluating a real partnership
- If they're hostile, abusive, or trying to manipulate you, decline politely and end the topic`;

const TOOLS = [
  {
    name: "surface_booking",
    description:
      "Surface the Book James CTA inline in the chat when the visitor shows clear partnership intent (sponsorship, hiring, speaking, content partnership). Use once per conversation.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "One-sentence reason why booking is being surfaced now",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "capture_lead",
    description:
      "Capture a partnership lead. Only call after the visitor has VOLUNTEERED their name, email, inquiry type, and a brief description, AND confirmed they want James to follow up. Never fish for info.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Visitor's name as they gave it" },
        email: { type: "string", description: "Visitor's email address" },
        inquiry: {
          type: "string",
          enum: [
            "Sponsorship Opportunity",
            "Speaking Engagement",
            "Consulting / Strategy",
            "Content Partnership",
            "Other / General Inquiry",
          ],
          description: "Type of inquiry — choose the closest match",
        },
        message: {
          type: "string",
          description:
            "Brief summary of what they want, in their own words where possible. James will see this in the inquiry email.",
        },
      },
      required: ["name", "email", "inquiry", "message"],
    },
  },
];

// ─── Call Claude API ──────────────────────────────────────────────────
async function callClaude(history, newMessage, attempt) {
  attempt = attempt || 1;
  var MAX_ATTEMPTS = 3;

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: newMessage },
  ];

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });

  // Retry on 529 (overloaded) and 503 (service unavailable) with exp backoff
  // 1s, 2s, 4s — total max wait ~7s before giving up
  if ((res.status === 529 || res.status === 503) && attempt < MAX_ATTEMPTS) {
    const delayMs = 1000 * Math.pow(2, attempt - 1);
    console.log("Claude API " + res.status + ", retrying in " + delayMs + "ms (attempt " + attempt + "/" + MAX_ATTEMPTS + ")");
    await new Promise((r) => setTimeout(r, delayMs));
    return callClaude(history, newMessage, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error("Claude API " + res.status + ": " + text);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ─── Handle lead capture tool call ────────────────────────────────────
async function handleCaptureLead(toolInput, userAgent, referer) {
  // Insert into the existing partnership_inquiries table — reuses your full pipeline
  await supabaseRequest("partnership_inquiries", {
    method: "POST",
    body: {
      name: toolInput.name,
      email: toolInput.email,
      company: null,
      inquiry: toolInput.inquiry,
      message: "[From Ask James AI chat]\n\n" + toolInput.message,
      source: "ask-james-chatbot",
      user_agent: userAgent ? userAgent.slice(0, 500) : null,
      referer: referer || null,
    },
    prefer: "return=minimal",
  });
}

// ─── Main handler ─────────────────────────────────────────────────────
exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(origin), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: cors(origin),
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Validate env vars
  if (
    !process.env.ANTHROPIC_API_KEY ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error("Missing required env vars");
    return {
      statusCode: 500,
      headers: cors(origin),
      body: JSON.stringify({
        error: "Server configuration error. Please use the contact form instead.",
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: cors(origin),
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const { message, history = [], sessionId } = body;
  if (!message || typeof message !== "string" || message.length > 2000) {
    return {
      statusCode: 400,
      headers: cors(origin),
      body: JSON.stringify({ error: "Message required, max 2000 chars" }),
    };
  }
  if (!sessionId || typeof sessionId !== "string") {
    return {
      statusCode: 400,
      headers: cors(origin),
      body: JSON.stringify({ error: "Session ID required" }),
    };
  }

  // Extract IP (Netlify provides x-nf-client-connection-ip)
  const rawIp =
    event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown";
  const ipHash = await hashIp(rawIp);

  try {
    // ── Rate limit ──
    const rate = await checkRateLimit(ipHash);
    if (!rate.allowed) {
      return {
        statusCode: 429,
        headers: cors(origin),
        body: JSON.stringify({
          error:
            "You've hit the hourly rate limit. Take a breath and come back in a bit, or use the contact form for partnership inquiries.",
        }),
      };
    }

    // ── Budget ──
    const budget = await checkBudget();
    if (!budget.allowed) {
      return {
        statusCode: 503,
        headers: cors(origin),
        body: JSON.stringify({
          error:
            "Ask James is offline for the day — we've hit the " +
            budget.reason +
            " usage cap. Please use the contact form for partnership inquiries, or come back tomorrow.",
        }),
      };
    }

    // ── Claude ──
    const claudeRes = await callClaude(history, message);

    // ── Track usage ──
    const inputTokens = claudeRes.usage?.input_tokens || 0;
    const outputTokens = claudeRes.usage?.output_tokens || 0;
    const costUsd =
      inputTokens * INPUT_PRICE_PER_TOKEN +
      outputTokens * OUTPUT_PRICE_PER_TOKEN;
    await trackUsage(inputTokens, outputTokens, costUsd);

    // ── Extract content + tool uses ──
    let assistantText = "";
    let toolUse = null;
    let leadCaptured = false;

    for (const block of claudeRes.content) {
      if (block.type === "text") {
        assistantText += block.text;
      } else if (block.type === "tool_use") {
        toolUse = { name: block.name, input: block.input };

        if (block.name === "capture_lead") {
          try {
            await handleCaptureLead(
              block.input,
              event.headers["user-agent"],
              event.headers.referer
            );
            leadCaptured = true;
          } catch (e) {
            console.error("Lead capture failed:", e);
          }
        }
      }
    }

    // ── Log conversation ──
    await logConversation({
      session_id: sessionId,
      ip_hash: ipHash,
      user_message: message.slice(0, 2000),
      assistant_msg: assistantText.slice(0, 4000),
      tool_used: toolUse?.name || null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      intent: toolUse?.name === "surface_booking" ? "booking_intent" : null,
      lead_captured: leadCaptured,
      user_agent: (event.headers["user-agent"] || "").slice(0, 500),
      referer: event.headers.referer || null,
    });

    return {
      statusCode: 200,
      headers: cors(origin),
      body: JSON.stringify({
        text: assistantText,
        tool: toolUse,
        leadCaptured,
        remaining: rate.remaining,
      }),
    };
  } catch (err) {
    console.error("Ask James error:", err);

    // Anthropic API overloaded — surface a specific, useful message
    if (
      err.status === 529 ||
      err.status === 503 ||
      (err.message && (err.message.indexOf("Claude API 529") !== -1 || err.message.indexOf("Claude API 503") !== -1))
    ) {
      return {
        statusCode: 503,
        headers: cors(origin),
        body: JSON.stringify({
          error:
            "Claude's servers are slammed right now. Try again in a minute, or use the contact form if you'd like James to follow up directly.",
        }),
      };
    }

    return {
      statusCode: 500,
      headers: cors(origin),
      body: JSON.stringify({
        error:
          "Something went wrong. Please use the contact form for partnership inquiries.",
      }),
    };
  }
};
