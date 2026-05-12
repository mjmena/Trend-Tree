// Pipedream Workflow Step: Generate Intro
//
// One Gemini call that writes the daily digest's editorial intro line.
// Surfaces emerging themes across today's selected trends — categories that
// recur, clusters that are heating up — in 1-2 sentences for the email header.
//
// Soft-fails: on any error or empty output, returns intro: "" and lets the
// email render without the intro block.

const GEMINI_MODEL = "gemini-3-flash-preview";

const parseVariant = (v) => {
  if (v == null) return [];
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v : [];
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

const buildPrompt = (rows) => {
  const risingRows = rows.filter((r) => isRising(r.VELOCITY_DIRECTION));
  const fillerRows = rows.filter((r) => !isRising(r.VELOCITY_DIRECTION));

  const renderRow = (r) => {
    const macros = parseVariant(r.MACROTREND_TAGS).slice(0, 2).join(", ");
    return `- ${r.TREND_NAME ?? "(untitled)"} [${prettifyToken(r.CATEGORY ?? "")}${r.SUBCATEGORY ? " / " + prettifyToken(r.SUBCATEGORY) : ""}] heat ${Number(r.HEAT_INDEX ?? 0).toFixed(1)} · ${String(r.VELOCITY_DIRECTION ?? "").toLowerCase()}${macros ? ` · macro: ${macros}` : ""}
  ${(r.SUMMARY_SHORT ?? "").trim()}`;
  };

  return `You are writing the editorial intro line for McClatchy's daily trend-intelligence newsletter ("Trend Insights Daily").

TODAY'S RISING TRENDS (${risingRows.length}):
${risingRows.map(renderRow).join("\n") || "(none — see top-heat trends below)"}

TOP-HEAT FILLER (${fillerRows.length}):
${fillerRows.map(renderRow).join("\n") || "(none)"}

TASK
Write 1-2 sentences (≤280 chars total) describing the day's emerging themes across these trends. Call out clusters or recurring categories where you see them ("three of today's risers cluster around X"; "wellness and beauty share a Y throughline"). If there's nothing rising, frame the digest as a top-heat snapshot.

STYLE
- Confident, concise, B2B-appropriate (sales/marketing teams read this).
- No bullets, no emoji, no hedging ("it seems", "perhaps").
- Don't list every trend by name — synthesize the shape of the day.
- Do not include the date.

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
  const parsed = JSON.parse(text);
  const intro = String(parsed?.intro ?? "").trim();
  if (!intro) throw new Error("Gemini returned empty intro");
  return intro;
};

export default defineComponent({
  name: "Generate Intro (Gemini)",
  description: "Writes the 1-2 sentence editorial intro for the daily digest email.",
  version: "0.0.1",
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
      const cost = (input / 1_000_000) * 0.3 + (output / 1_000_000) * 2.5;
      $.export("$summary", `Intro generated (${intro.length} chars) — $${cost.toFixed(4)}`);
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
