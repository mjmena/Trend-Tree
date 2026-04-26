// Discovery — discover_gemini
//
// Calls Gemini 2.5 Flash with Google Search grounding to surface
// emerging consumer trends NOT in the active list. Citation URLs
// required — proposals without one are dropped at canonicalize step.
//
// Per gemini_grounding_gotcha.md memory: do NOT set responseMimeType
// when using the Google Search tool — the response shape conflicts.
// Parse text + extract JSON manually instead.
//
// =====================================================================
// Inlined helpers (canonical: agents/lib/prompt_loader.mjs)
// =====================================================================

function loadPrompts(rows) {
  const out = {};
  for (const r of (rows || [])) {
    const key = r.PROMPT_KEY;
    if (!key) continue;
    let params = r.MODEL_PARAMS;
    if (typeof params === "string") {
      try { params = JSON.parse(params); } catch { params = {}; }
    }
    if (!params || typeof params !== "object") params = {};
    out[key] = { template: r.TEMPLATE || "", model: r.MODEL || "", params, version: r.VERSION };
  }
  return out;
}

function render(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars?.[key];
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v, null, 2);
  });
}

function mustGet(loaded, key) {
  const p = loaded?.[key];
  if (!p || !p.template) {
    throw new Error(`Prompt '${key}' not loaded. Confirm DIM_LLM_PROMPT IS_ACTIVE=TRUE for this key.`);
  }
  return p;
}

function extractJsonArray(text) {
  // Gemini may wrap in ```json ... ``` or include preamble; find the first [ ... ] balanced array.
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const PROMPT_KEY = "discovery.gemini.search";

export default defineComponent({
  name: "Discovery: Gemini",
  description: "Gemini 2.5 Flash + Google Search grounding for trend discovery",
  version: "0.0.1",
  props: {
    google_gemini: { type: "app", app: "google_gemini" },
    prompts_rows: { type: "any", label: "DIM_LLM_PROMPT rows" },
    discovery_context: { type: "object", label: "build_discovery_context output" },
  },
  async run() {
    const ctx = this.discovery_context || {};
    const loaded = loadPrompts(this.prompts_rows);
    const prompt = mustGet(loaded, PROMPT_KEY);

    const rendered = render(prompt.template, {
      active_trends: ctx.active_trends_formatted || "(none)",
      valuable_examples: ctx.valuable_examples_formatted || "(none)",
    });

    const body = {
      contents: [{ parts: [{ text: rendered }] }],
      tools: prompt.params.tools ?? [{ google_search: {} }],
      generationConfig: {
        temperature: prompt.params.temperature ?? 0.5,
      },
    };

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${prompt.model}:generateContent?key=${this.google_gemini.$auth.api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const arrText = extractJsonArray(text);
      if (!arrText) throw new Error(`No JSON array in Gemini response: ${text.slice(0, 240)}`);
      const proposals = JSON.parse(arrText);
      if (!Array.isArray(proposals)) throw new Error("Parsed Gemini response is not an array");

      const usage = data.usageMetadata || {};
      console.log(`Gemini discovery: ${proposals.length} proposals, ${usage.promptTokenCount || 0} in / ${usage.candidatesTokenCount || 0} out`);

      return {
        proposals: proposals.filter((p) => p && typeof p === "object" && p.topic),
        model: prompt.model,
        prompt_key: PROMPT_KEY,
        prompt_version: prompt.version,
        _token_usage: {
          input: usage.promptTokenCount || 0,
          output: usage.candidatesTokenCount || 0,
          model: prompt.model,
        },
        error: null,
      };
    } catch (e) {
      console.log(`Gemini discovery error: ${e.message}`);
      return { proposals: [], model: prompt.model, prompt_key: PROMPT_KEY, prompt_version: prompt.version, error: e.message };
    }
  },
});
