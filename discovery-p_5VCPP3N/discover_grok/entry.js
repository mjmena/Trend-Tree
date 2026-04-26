// Discovery — discover_grok
//
// Calls Grok 4 with web_search + x_search tools to surface emerging
// cultural / X-driven consumer trends NOT in the active list.
//
// Per xai_grok_api_migration.md memory: search_parameters is deprecated;
// live search now requires /v1/responses with tools[]. Defensive parsing
// of response shape since xAI tool-call responses can vary.
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
    throw new Error(`Prompt '${key}' not loaded.`);
  }
  return p;
}

function extractJsonArray(text) {
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

const PROMPT_KEY = "discovery.grok.search";

export default defineComponent({
  name: "Discovery: Grok",
  description: "Grok 4 + web_search + x_search for cultural trend discovery",
  version: "0.0.1",
  props: {
    x_ai: { type: "app", app: "x_ai" },
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

    // xAI /v1/responses shape with live search tools.
    const body = {
      model: prompt.model,
      input: rendered,
      temperature: prompt.params.temperature ?? 0.6,
      search_parameters: prompt.params.search_parameters ?? { mode: "auto" },
    };

    try {
      const resp = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.x_ai.$auth.api_key}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) throw new Error(`Grok HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
      const data = await resp.json();

      // Defensive extraction — xAI response shape may evolve.
      let text = "";
      if (typeof data.output_text === "string") text = data.output_text;
      else if (Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (typeof c.text === "string") text += c.text;
            }
          }
        }
      }
      if (!text) throw new Error(`No text in Grok response: ${JSON.stringify(data).slice(0, 240)}`);

      const arrText = extractJsonArray(text);
      if (!arrText) throw new Error(`No JSON array in Grok response: ${text.slice(0, 240)}`);
      const proposals = JSON.parse(arrText);
      if (!Array.isArray(proposals)) throw new Error("Parsed Grok response is not an array");

      const usage = data.usage || {};
      console.log(`Grok discovery: ${proposals.length} proposals, ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out`);

      return {
        proposals: proposals.filter((p) => p && typeof p === "object" && p.topic),
        model: prompt.model,
        prompt_key: PROMPT_KEY,
        prompt_version: prompt.version,
        _token_usage: {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          model: prompt.model,
        },
        error: null,
      };
    } catch (e) {
      console.log(`Grok discovery error: ${e.message}`);
      return { proposals: [], model: prompt.model, prompt_key: PROMPT_KEY, prompt_version: prompt.version, error: e.message };
    }
  },
});
