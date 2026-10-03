// api/spark.js — Mintmos Spark backend (Vercel Node.js function)
// Streaming + exponential-backoff retries + history pruning, using the official Google Gen AI SDK.
const { GoogleGenAI } = require("@google/genai");

/* ───────── Config ───────── */
const MODEL       = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"; // fastest current model. Want smarter answers? set GEMINI_MODEL=gemini-3.8-flash
const THINKING    = process.env.GEMINI_THINKING_LEVEL;                   // optional: "LOW" (or "MINIMAL") = faster replies on Gemini 3.x
const MAX_RETRIES = 3;       // retries after the first try → waits ≈ 1s, 2s, 4s
const BASE_DELAY  = 1000;    // ms
const MAX_TURNS   = 12;      // newest history messages kept
const MAX_CHARS   = 24000;   // ≈ 6k tokens of text (history + current message)
const MAX_OUTPUT  = 2048;    // caps answer length → caps latency
const SYSTEM = process.env.SPARK_SYSTEM ||
  "You are Mintmos Spark, the study co-pilot inside the MINTMOS Price Action Operating System. " +
  "Answer clearly and concisely, in plain language, using the course material you are given. " +
  "This is education, not financial advice.";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/* ───────── 1. Exponential backoff ───────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRetryable = (e) => {
  const s = Number((e && (e.status ?? e.code)) || 0);
  return [429, 500, 502, 503, 504].includes(s) ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|ETIMEDOUT|ECONNRESET|fetch failed|timed? ?out/i.test(String((e && e.message) || ""));
};
async function withBackoff(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= MAX_RETRIES || !isRetryable(e)) throw e;
      const wait = BASE_DELAY * 2 ** attempt + Math.random() * 250; // jitter avoids retry stampedes
      console.warn(`Gemini ${e.status || ""} – retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
}

/* ───────── 3. Context-window pruning ───────── */
const textLen = (m) => m.parts.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
function pruneHistory(contents) {
  const msgs = contents.filter((m) => m && Array.isArray(m.parts) && m.parts.length);
  const last = msgs[msgs.length - 1];                       // current question (keeps its image, if any)
  const hist = msgs.slice(0, -1).slice(-MAX_TURNS).map((m) => ({
    role: m.role,
    parts: m.parts.map((p) => (p.inlineData ? { text: "[image omitted]" } : p)), // old images are never re-sent
  }));
  let total = textLen(last);
  const kept = [];
  for (let i = hist.length - 1; i >= 0; i--) {              // newest first, stop when the budget is spent
    const n = textLen(hist[i]);
    if (total + n > MAX_CHARS) break;
    total += n; kept.unshift(hist[i]);
  }
  while (kept.length && kept[0].role !== "user") kept.shift(); // Gemini wants the conversation to start with the user
  return kept.concat(last);
}

// Whatever goes wrong (429, 503, timeout, network, blocked, bad config) the user only ever sees this.
// The real reason is written to the server log instead, so nothing is lost for debugging.
const BUSY = "Spark is Busy";
const friendly = (e) => {
  console.error("Spark error:", (e && (e.status || e.code)) || "", (e && e.message) || e);
  return BUSY;
};

/* ───────── Handler ───────── */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, model: MODEL });
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: { message: friendly(new Error("Server is missing GEMINI_API_KEY")) } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || !Array.isArray(body.contents) || !body.contents.length) {
    return res.status(400).json({ error: { message: friendly(new Error("Missing 'contents'")) } });
  }
  const contents = pruneHistory(body.contents);

  const config = { systemInstruction: SYSTEM, maxOutputTokens: MAX_OUTPUT };
  if (THINKING) config.thinkingConfig = { thinkingLevel: THINKING.toUpperCase() };

  // 2. Open the stream. The retry wraps "open + first chunk", because 429/503 errors
  //    surface there — before any bytes have gone to the browser, so a retry is invisible.
  let it, first;
  try {
    ({ it, first } = await withBackoff(async () => {
      const stream = await ai.models.generateContentStream({ model: MODEL, contents, config });
      const it = stream[Symbol.asyncIterator]();
      return { it, first: await it.next() };
    }));
  } catch (e) {
    const s = Number(e && e.status);
    return res.status(s >= 400 && s < 600 ? s : 502).json({ error: { message: friendly(e), status: s || 502 } });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  let aborted = false, sent = false;
  req.on("close", () => { aborted = true; });               // browser left → stop spending tokens
  try {
    for (let r = first; !r.done && !aborted; r = await it.next()) {
      const t = r.value && r.value.text;
      if (t) { sent = true; send({ t }); }
    }
    if (!sent && !aborted) send({ error: friendly(new Error("No answer was generated (possibly blocked)")) });
  } catch (e) {
    send({ error: friendly(e) });                           // mid-stream failure: tell the page, don't retry (would duplicate text)
  }
  res.end();
};
