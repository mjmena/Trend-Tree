// Pipedream Workflow Step: Generate Intro
//
// One Gemini 3.1 Pro call that writes the daily digest's editorial intro line.
// Surfaces emerging themes across today's selected trends — categories that
// recur, clusters that are heating up, cultural drivers shared across trends —
// in 1-2 sentences for the email header.
//
// Feeds the model the full enrichment context per trend (summary, vibe shift,
// social narrative, cultural drivers, seasonal/geographic signals, key data
// points), not just the short summary, so the editorial voice has more than
// just the headline to riff on.
//
// Soft-fails: on any error or empty output, returns intro: "" and lets the
// email render without the intro block.

const GEMINI_MODEL = "gemini-3.1-pro-preview";

// Pro pricing (per 1M tokens). Update if Google's rates change.
const INPUT_PER_M = 1.25;
const OUTPUT_PER_M = 10.0;

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

  return `You are writing the editorial intro line for McClatchy's daily trend-intelligence newsletter ("Trend Insights Daily"), read by B2B marketing and sales teams across McClatchy's news properties.

TODAY'S DIGEST — ${risingRows.length} rising trend(s), ${fillerRows.length} top-heat filler trend(s).

=== RISING TRENDS (lifecycle: NEW / GROWING / RESURGENT) ===
${risingRows.length ? risingRows.map((r, i) => renderTrend(r, i)).join("\n") : "(no rising trends today — digest is a top-heat snapshot)"}

=== TOP-HEAT FILLER (STABLE / DORMANT) ===
${fillerRows.length ? fillerRows.map((r, i) => renderTrend(r, risingRows.length + i)).join("\n") : "(none)"}

TASK
Write the 1-2 sentence editorial intro line that opens the newsletter. ≤320 chars total. Synthesize the SHAPE of the day across these ${allRows.length} trends — recurring categories, shared cultural drivers, clusters of momentum, throughlines across seemingly unrelated trends. The reader sees the full trend cards below; your job is to give them the editorial frame.

STYLE
- Confident, concise, B2B-appropriate (sales/marketing teams read this).
- No bullets, no emoji, no hedging ("it seems", "perhaps").
- Don't recite the trend list — synthesize the throughline. If three risers share a vibe, name it.
- Reference cultural drivers or vibe shifts where they cluster across multiple trends.
- Do not include the date.
- If there's nothing rising, frame the digest as a top-heat snapshot ("Today's snapshot leans into...").

OUTPUT — a single JSON object and nothing else:
{ "intro": "..." }`;
};

const callGemini = async (apiKey, prompt) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.5,
      responseMimeType: "application/json",
      // Pro 3.1 burns tokens on thinking before emitting; budget needs to
      // cover thinking + the small JSON payload. 4096 matches the other
      // Pro-using agents in this repo (audit-agent, gemini_loop).
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel: "low" },
    },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
};

const extractIntro = (data) => {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  const finishReason = data?.candidates?.[0]?.finishReason;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Fall back to grabbing the intro field via regex in case the model
    // wrapped JSON in prose or truncated mid-string.
    const m = text.match(/"intro"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (m && m[1]) {
      const intro = m[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
      if (intro) return intro;
    }
    throw new Error(
      `JSON.parse failed (${e.message}); finishReason=${finishReason}; raw="${text.slice(0, 200)}"`,
    );
  }

  const intro = String(parsed?.intro ?? "").trim();
  if (!intro) throw new Error(`Gemini returned empty intro; finishReason=${finishReason}`);
  return intro;
};

export default defineComponent({
  name: "Generate Intro (Gemini Pro)",
  description: "Writes the 1-2 sentence editorial intro for the daily digest email using Gemini 3.1 Pro with full enrichment context.",
  version: "0.1.0",
  props: {
    google_gemini: {
      type: "app",
      app: "google_gemini",
    },
    dashboard_rows: {
      type: "any",
      label: "Verified dashboard rows from verify_sources_llm",
    },
  },
  async run({ $ }) {
    const rows = Array.isArray(this.dashboard_rows) ? this.dashboard_rows : [];
    if (rows.length === 0) {
      $.export("$summary", "No trends — skipping intro");
      return { intro: "" };
    }

    const apiKey = this.google_gemini?.$auth?.api_key;
    if (!apiKey) {
      console.log("generate_intro: no Gemini api key, skipping");
      $.export("$summary", "No api key — skipping intro");
      return { intro: "" };
    }

    try {
      const data = await callGemini(apiKey, buildPrompt(rows));
      const intro = extractIntro(data);
      const usage = data?.usageMetadata || {};
      const input = usage.promptTokenCount || 0;
      const output = usage.candidatesTokenCount || 0;
      const cost = (input / 1_000_000) * INPUT_PER_M + (output / 1_000_000) * OUTPUT_PER_M;
      $.export("$summary", `Intro generated (${intro.length} chars, ${input}/${output} tok) — $${cost.toFixed(4)}`);
      return {
        intro,
        _usage: { input, output, model: GEMINI_MODEL, cost_estimate_usd: cost },
      };
    } catch (e) {
      const msg = e?.message || String(e);
      console.log(`generate_intro: soft-fail — ${msg}`);
      $.export("$summary", `Intro skipped (${msg.slice(0, 80)})`);
      return { intro: "", _error: msg.slice(0, 500) };
    }
  },
});
