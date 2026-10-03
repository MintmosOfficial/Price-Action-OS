/**
 * /api/spark  —  MINTMOS Spark backend proxy (Vercel serverless function, Node runtime)
 *
 * Browser -> this route -> Gemini API.
 * The Gemini key is read ONLY from the server-side environment variable GEMINI_API_KEY.
 */

const SYSTEM_INSTRUCTION = "You are the official MINTMOS Price Action OS AI Co-Pilot. You have absolute mastery over the Price Action Operating System, the 8 Deep Modules, the 4-stage Execution Roadmap, the T.L.S Confluence Framework (Trend + Level + Signal), and the flagship setups (BOS Retest, Zone Rejection, Second-Entry Continuation). You are strictly prohibited from answering questions outside of this trading framework, price action mechanics, risk management metrics, or administrative data regarding raoabannn@gmail.com. Keep your answers brief, high-identity, and professional.";

// Models the browser is allowed to request (the frontend keeps its fallback order).
const ALLOWED_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-flash-latest"];

const GENERATION_CONFIG = { temperature: 0.4, maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "low" } };

// ---- limits ----
const MAX_BODY_BYTES = 3 * 1024 * 1024;   // whole request
const MAX_TURNS = 15;                      // history (frontend sends <= 15)
const MAX_PARTS = 4;                       // parts per turn
const MAX_TEXT_CHARS = 150000;             // per text part (frontend caps context at 4 x 30k)
const MAX_IMAGE_B64 = 2.5 * 1024 * 1024;   // base64 chars per image
const UPSTREAM_TIMEOUT_MS = 25000;
const RATE_LIMIT = { max: 20, windowMs: 60 * 1000 }; // per IP per minute (best-effort, see README)

// ---- best-effort in-memory rate limiter (per warm serverless instance) ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) { hits.set(ip, { n: 1, reset: now + RATE_LIMIT.windowMs }); }
  else if (++rec.n > RATE_LIMIT.max) return true;
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return false;
}

const send = (res, status, message) =>
  res.status(status).json(message ? { error: { message } } : {});

// ---- validation / sanitising: returns clean Gemini "contents" or null ----
function cleanContents(contents) {
  if (!Array.isArray(contents) || contents.length < 1 || contents.length > MAX_TURNS) return null;
  const out = [];
  for (const turn of contents) {
    if (!turn || typeof turn !== "object") return null;
    if (turn.role !== "user" && turn.role !== "model") return null;
    if (!Array.isArray(turn.parts) || turn.parts.length < 1 || turn.parts.length > MAX_PARTS) return null;
    const parts = [];
    for (const p of turn.parts) {
      if (!p || typeof p !== "object") return null;
      if (typeof p.text === "string") {
        if (p.text.length > MAX_TEXT_CHARS) return null;
        parts.push({ text: p.text });
      } else if (p.inlineData && turn.role === "user") {
        const { mimeType, data } = p.inlineData;
        if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) return null;
        if (typeof data !== "string" || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
        parts.push({ inlineData: { mimeType, data } });
      } else return null;
    }
    out.push({ role: turn.role, parts });
  }
  if (out[out.length - 1].role !== "user") return null;
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, "Method not allowed."); }

  // Same-origin only (blocks other websites from using your endpoint from a browser)
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch (_) {}
    if (!ok) return send(res, 403, "Forbidden origin.");
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) { res.setHeader("Retry-After", "30"); return send(res, 429, "Too many requests. Please slow down."); }

  const len = Number(req.headers["content-length"] || 0);
  if (len > MAX_BODY_BYTES) return send(res, 413, "Request too large.");
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
    return send(res, 415, "Content-Type must be application/json.");

  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set on the server.");
    return send(res, 500, "Spark server is not configured (API key missing).");
  }

  const body = req.body;   // Vercel parses JSON for us
  if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, "Invalid request body.");
  const model = body.model === undefined ? ALLOWED_MODELS[0] : body.model;
  if (!ALLOWED_MODELS.includes(model)) return send(res, 400, "Unsupported model.");
  const contents = cleanContents(body.contents);
  if (!contents) return send(res, 400, "Invalid conversation data.");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents,
          generationConfig: GENERATION_CONFIG,
        }),
        signal: ctrl.signal,
      }
    );
    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      // Log status only — never the key, headers or raw upstream payload.
      console.error("Gemini upstream error", r.status, model);
      if (r.status === 401 || r.status === 403) return send(res, 403, "Spark backend API key problem — check the server configuration.");
      if (r.status === 429) return send(res, 429, "Gemini is rate limiting requests. Try again later.");
      if (r.status === 500 || r.status === 503 || r.status === 504) return send(res, 503, "Gemini is overloaded or unavailable. Try again later.");
      return send(res, 502, "Gemini rejected the request.");
    }

    // Return only what the frontend needs.
    const c = j.candidates && j.candidates[0];
    const parts = ((c && c.content && c.content.parts) || [])
      .filter((p) => typeof p.text === "string")
      .map((p) => (p.thought ? { text: p.text, thought: true } : { text: p.text }));
    return res.status(200).json({
      candidates: [{ content: { parts }, finishReason: c && c.finishReason }],
      promptFeedback: j.promptFeedback && j.promptFeedback.blockReason ? { blockReason: j.promptFeedback.blockReason } : undefined,
    });
  } catch (e) {
    console.error("Gemini request failed:", e && e.name);
    if (e && e.name === "AbortError") return send(res, 504, "Gemini took too long to respond. Try again.");
    return send(res, 502, "Could not reach Gemini.");
  } finally {
    clearTimeout(timer);
  }
};
