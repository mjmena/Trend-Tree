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
    const verticals = Array.isArray(ctx.verticals) && ctx.verticals.length ? ctx.verticals : ["consumer"];
    const apiKey = this.google_gemini.$auth.api_key;

    async function callShard(vertical) {
      const rendered = render(prompt.template, {
        active_trends: ctx.active_trends_formatted || "(none)",
        valuable_examples: ctx.valuable_examples_formatted || "(none)",
        vertical,
      });
      const body = {
        contents: [{ parts: [{ text: rendered }] }],
        tools: prompt.params.tools ?? [{ google_search: {} }],
        generationConfig: { temperature: prompt.params.temperature ?? 0.5 },
      };
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${prompt.model}:generateContent?key=${apiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const arrText = extractJsonArray(text);
      if (!arrText) throw new Error(`No JSON array in Gemini response: ${text.slice(0, 240)}`);
      const parsed = JSON.parse(arrText);
      if (!Array.isArray(parsed)) throw new Error("Parsed Gemini response is not an array");
      const usage = data.usageMetadata || {};
      const proposals = parsed
        .filter((p) => p && typeof p === "object" && p.topic)
        .map((p) => ({ ...p, vertical: p.vertical || vertical }));
      return {
        vertical,
        proposals,
        input_tokens: usage.promptTokenCount || 0,
        output_tokens: usage.candidatesTokenCount || 0,
      };
    }

    const settled = await Promise.allSettled(verticals.map((v) => callShard(v)));
    const allProposals = [];
    let totalIn = 0;
    let totalOut = 0;
    let firstError = null;
    const perVerticalCounts = {};
    for (const r of settled) {
      if (r.status === "fulfilled") {
        allProposals.push(...r.value.proposals);
        totalIn += r.value.input_tokens;
        totalOut += r.value.output_tokens;
        perVerticalCounts[r.value.vertical] = r.value.proposals.length;
      } else {
        if (!firstError) firstError = r.reason?.message || String(r.reason);
        console.log(`Gemini shard error: ${r.reason?.message || r.reason}`);
      }
    }
    const successCount = settled.filter((r) => r.status === "fulfilled").length;
    console.log(`Gemini discovery: ${allProposals.length} proposals across ${successCount}/${verticals.length} shards (${JSON.stringify(perVerticalCounts)}), ${totalIn} in / ${totalOut} out`);

    return {
      proposals: allProposals,
      model: prompt.model,
      prompt_key: PROMPT_KEY,
      prompt_version: prompt.version,
      shards_attempted: verticals.length,
      shards_succeeded: successCount,
      per_vertical_counts: perVerticalCounts,
      _token_usage: { input: totalIn, output: totalOut, model: prompt.model },
      error: successCount === 0 ? (firstError || "all shards failed") : null,
    };
  },
});
