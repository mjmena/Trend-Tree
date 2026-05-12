// Pipedream Workflow Step: Generate Intro
//
// One Gemini 3.1 Pro call that writes two layered editorial outputs for
// the daily digest email: a short preheader (≤85 chars, the inbox-preview
// teaser) and a 1-2 sentence intro (≤280 chars, the visible body opener).
// Both surface themes across today's trends — recurring categories,
// clusters of momentum, shared cultural drivers.
//
// Feeds the model the full enrichment context per trend (summary, vibe
// shift, social narrative, cultural drivers, seasonal/geographic signals,
// key data points) so the editorial voice has more than the headline to
// riff on.
//
// Why Pro (not Flash): Flash repeatedly truncated multi-field JSON output,
// emitting 4-word intro strings before closing. Pro 3.1 at thinkingLevel
// "low" produces consistent, complete output in 10-30s on this prompt.
// FETCH_TIMEOUT_MS (120s) caps the call so the step can never block
// the workflow.
//
// Soft-fails: on any error or empty output, returns blank intro/preheader
// and lets the email render without the editorial block.

const GEMINI_MODEL = "gemini-3.1-pro-preview";

// Pro pricing (per 1M tokens). Update if Google's rates change.
const INPUT_PER_M = 1.25;
const OUTPUT_PER_M = 10.0;

// Hard ceiling on the Gemini call so the step can't block the workflow.
// Pro 3.1 at thinkingLevel "medium" on this ~5K-token prompt can take
// 2-5 minutes during slow Google windows. 480s (8 min) leaves the
// workflow lambda_timeout (600s) ~2 min for the other steps.
const FETCH_TIMEOUT_MS = 480_000;

const parseVariant = (v) => {
  if (v == null) return null;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return v;
};

const asArray = (v) => {
  const p = parseVariant(v);
  return Array.isArray(p) ? p : [];
};

const prettifyToken = (s) => String(s ?? "")
  .replace(/[_-]+/g, " ")
  .trim()
  .replace(/\s+/g, " ")
  .split(" ")
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join(" ");

const isRising = (v) => {
  const u = String(v ?? "").toUpperCase();
  return u === "NEW" || u === "GROWING" || u === "RESURGENT";
};

const renderTrend = (r, idx) => {
  const name = r.TREND_NAME ?? "(untitled)";
  const b2b = r.TREND_NAME_B2B && r.TREND_NAME_B2B !== name ? ` (B2B: ${r.TREND_NAME_B2B})` : "";
  const cat = prettifyToken(r.CATEGORY ?? "");
  const sub = r.SUBCATEGORY ? ` / ${prettifyToken(r.SUBCATEGORY)}` : "";
  const status = String(r.VELOCITY_DIRECTION ?? "").toLowerCase();
  const heat = Number(r.HEAT_INDEX ?? 0).toFixed(1);
  const cluster = r.TOTAL_CLUSTER_SIZE ?? 0;
  const sources = r.DISTINCT_SOURCE_COUNT ?? 0;
  const macros = asArray(r.MACROTREND_TAGS);

  const summary = String(r.SUMMARY_LONG || r.SUMMARY_SHORT || "").trim();
  const vibe = String(r.VIBE_SHIFT ?? "").trim();

  const socialNarrative = asArray(r.SOCIAL_NARRATIVE)
    .map((n) => `    - ${n.point || n}`)
    .join("\n");

  const culturalDrivers = asArray(r.CULTURAL_DRIVERS)
    .map((d) => `    - ${d.driver || d}${d.influence_level ? ` (${d.influence_level})` : ""}`)
    .join("\n");

  const seasonal = parseVariant(r.SEASONAL_RELEVANCE);
  const seasonalLine = seasonal && seasonal.is_seasonal
    ? `  Seasonality: peaks ${(seasonal.peak_months || []).join(", ") || "(unspecified)"}`
    : "";

  const geo = asArray(r.GEOGRAPHIC_HOTSPOTS)
    .map((g) => `${g.region}${g.intensity ? ` (${g.intensity})` : ""}`)
    .join(", ");
  const geoLine = geo ? `  Geographic hotspots: ${geo}` : "";

  const keyData = asArray(r.KEY_DATA_POINTS)
    .map((k) => `${k.source}: ${k.metric_name}=${k.metric_value}`)
    .join("; ");
  const keyDataLine = keyData ? `  Key metrics: ${keyData}` : "";

  return `[${idx + 1}] ${name}${b2b}
  Category: ${cat}${sub}
  Status: ${status} · heat ${heat} · cluster ${cluster} signals across ${sources} source families
  Macro tags: ${macros.join(", ") || "(none)"}
  Summary: ${summary || "(none)"}
${vibe ? `  Vibe shift: ${vibe}\n` : ""}${socialNarrative ? `  Why now:\n${socialNarrative}\n` : ""}${culturalDrivers ? `  Cultural drivers:\n${culturalDrivers}\n` : ""}${seasonalLine ? `${seasonalLine}\n` : ""}${geoLine ? `${geoLine}\n` : ""}${keyDataLine ? `${keyDataLine}\n` : ""}`;
};

const buildPrompt = (rows) => {
  const risingRows = rows.filter((r) => isRising(r.VELOCITY_DIRECTION));
  const fillerRows = rows.filter((r) => !isRising(r.VELOCITY_DIRECTION));
  const allRows = [...risingRows, ...fillerRows];

  return `You're writing the opening line of a daily trend-intelligence newsletter. McClatchy publishes it — sales and marketing folks read it over coffee. Your job: give them the vibe of the day in 1-2 sentences. Witty if it lands, never forced. The trend cards do the heavy lifting; you're just the cold open.

TODAY'S DIGEST — ${risingRows.length} rising trend(s), ${fillerRows.length} top-heat filler trend(s).

=== RISING TRENDS (lifecycle: NEW / GROWING / RESURGENT) ===
${risingRows.length ? risingRows.map((r, i) => renderTrend(r, i)).join("\n") : "(no rising trends today — digest is a top-heat snapshot)"}

=== TOP-HEAT FILLER (STABLE / DORMANT) ===
${fillerRows.length ? fillerRows.map((r, i) => renderTrend(r, risingRows.length + i)).join("\n") : "(none)"}

TASK
Write TWO layered editorial lines:

1. "preheader" — ONE complete sentence, ≤85 chars. This is the inbox-preview teaser that shows next to the subject line. Make it a hook: a single observation that makes a reader want to open. Must end with a period.

2. "intro" — 1-2 complete sentences, ≤280 chars total. This is the visible editorial opener inside the email — the elaboration on the preheader. Find the through-line across today's trends. If two or three risers share a mood, name it in plain English. Both sentences MUST end with terminal punctuation; do not start a sentence you don't finish.

VOICE (applies to both)
- Talk like a smart friend who reads too much, not a McKinsey deck.
- Plain verbs, concrete nouns. "People are doing X" beats "consumers are driving demand for X."
- A little wit is fine. A wry observation is fine. No puns, no emoji, no hedging, no exclamation points.
- BANNED phrases: "Today's intelligence", "consumer pivot", "driving demand", "simultaneously", "moreover", "leveraging", "the rise of", "ushering in", "signals a shift", "underscores", "increasingly". If you wrote one, rewrite.
- No proper-noun trend names — synthesize, don't recite.
- Keep it newsroom-safe (no crude or insulting language); McClatchy is corporate media.

EXAMPLES OF THE RIGHT VOICE (style only, ignore content)
Example A:
  preheader: "Burnout's losing its grip on the wellness aisle."
  intro: "Burnout's losing its grip on the wellness aisle — people are shaking, breathing, and napping their way through 2026."
Example B:
  preheader: "Three risers, one shared instinct: stop optimizing."
  intro: "Three of today's risers all want the same thing: stop optimizing, start feeling. The wearables industry is going to feel that."
Example C:
  preheader: "Beauty's doing the heavy lifting today."
  intro: "Quiet day on the fashion side; beauty is doing all the heavy lifting, mostly from the scalp up."

OUTPUT — a single JSON object and nothing else:
{ "preheader": "...", "intro": "..." }`;
};

const callGemini = async (apiKey, prompt) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.5,
      responseMimeType: "application/json",
      // Generous budget so thinking + JSON wrapper + content all fit
      // with room to spare. The model won't pad output to fill space —
      // the actual emit is ~300-500 tokens; the rest is thinking budget.
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingLevel: "medium" },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
    }
    return await resp.json();
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Gemini call exceeded ${FETCH_TIMEOUT_MS}ms timeout`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

// Trim a dangling incomplete trailing sentence — Gemini sometimes starts
// a second/third sentence that doesn't finish ("…skincare. From").
// If the last text after the final terminal punctuation isn't empty,
// it's a fragment; drop it.
const trimDangling = (text) => {
  const t = (text || "").trim();
  if (!t) return "";
  const matches = [...t.matchAll(/[.!?][")\]”’]?/g)];
  if (matches.length === 0) return t;
  const last = matches[matches.length - 1];
  const endPos = last.index + last[0].length;
  const tail = t.slice(endPos).trim();
  return tail ? t.slice(0, endPos) : t;
};

const extractOutput = (data) => {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  const finishReason = data?.candidates?.[0]?.finishReason;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Fall back to regex extraction so a malformed JSON wrapper still
    // yields something usable. Intro is the required field; preheader
    // is optional and can be empty.
    const introMatch = text.match(/"intro"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const preheaderMatch = text.match(/"preheader"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const intro = introMatch
      ? trimDangling(introMatch[1].replace(/\\"/g, '"').replace(/\\n/g, " "))
      : "";
    const preheader = preheaderMatch
      ? trimDangling(preheaderMatch[1].replace(/\\"/g, '"').replace(/\\n/g, " "))
      : "";
    if (intro) return { intro, preheader };
    throw new Error(
      `JSON.parse failed (${e.message}); finishReason=${finishReason}; raw="${text.slice(0, 200)}"`,
    );
  }

  const intro = trimDangling(String(parsed?.intro ?? ""));
  const preheader = trimDangling(String(parsed?.preheader ?? ""));
  if (!intro) throw new Error(`Gemini returned empty intro; finishReason=${finishReason}`);
  return { intro, preheader };
};

export default defineComponent({
  name: "Generate Intro (Gemini Pro)",
  description: "Writes the editorial preheader + intro for the daily digest email using Gemini 3.1 Pro with full enrichment context.",
  version: "0.3.0",
  props: {
    google_gemini: {
      type: "app",
      app: "google_gemini",
    },
    dashboard_rows: {
      type: "any",
      label: "Dashboard rows from query_dashboard",
    },
  },
  async run({ $ }) {
    const rows = Array.isArray(this.dashboard_rows) ? this.dashboard_rows : [];
    if (rows.length === 0) {
      $.export("$summary", "No trends — skipping intro");
      return { intro: "", preheader: "" };
    }

    const apiKey = this.google_gemini?.$auth?.api_key;
    if (!apiKey) {
      console.log("generate_intro: no Gemini api key, skipping");
      $.export("$summary", "No api key — skipping intro");
      return { intro: "", preheader: "" };
    }

    try {
      const data = await callGemini(apiKey, buildPrompt(rows));
      const { intro, preheader } = extractOutput(data);
      const usage = data?.usageMetadata || {};
      const input = usage.promptTokenCount || 0;
      const output = usage.candidatesTokenCount || 0;
      const cost = (input / 1_000_000) * INPUT_PER_M + (output / 1_000_000) * OUTPUT_PER_M;
      $.export("$summary", `Intro generated (intro ${intro.length}c, preheader ${preheader.length}c, ${input}/${output} tok) — $${cost.toFixed(4)}`);
      return {
        intro,
        preheader,
        _usage: { input, output, model: GEMINI_MODEL, cost_estimate_usd: cost },
      };
    } catch (e) {
      const msg = e?.message || String(e);
      console.log(`generate_intro: soft-fail — ${msg}`);
      $.export("$summary", `Intro skipped (${msg.slice(0, 80)})`);
      return { intro: "", preheader: "", _error: msg.slice(0, 500) };
    }
  },
});
