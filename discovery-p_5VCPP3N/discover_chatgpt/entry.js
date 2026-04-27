// Discovery — discover_chatgpt
//
// Calls GPT-5-mini with the web_search tool to surface emerging consumer
// trends from mainstream lifestyle media + product launches NOT in the
// active list.
//
// Uses OpenAI Responses API (/v1/responses) — the new shape that supports
// built-in web search tool.
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

const PROMPT_KEY = "discovery.chatgpt.search";

export default defineComponent({
  name: "Discovery: ChatGPT",
  description: "GPT-5-mini + web_search for consumer media + product launch discovery",
  version: "0.0.1",
  props: {
    openai: { type: "app", app: "openai" },
    prompts_rows: { type: "any", label: "DIM_LLM_PROMPT rows" },
    discovery_context: { type: "object", label: "build_discovery_context output" },
  },
  async run() {
    const ctx = this.discovery_context || {};
    const loaded = loadPrompts(this.prompts_rows);
    const prompt = mustGet(loaded, PROMPT_KEY);
    const verticals = Array.isArray(ctx.verticals) && ctx.verticals.length ? ctx.verticals : ["consumer"];
    const apiKey = this.openai.$auth.api_key;

    async function callShard(vertical) {
      const rendered = render(prompt.template, {
        active_trends: ctx.active_trends_formatted || "(none)",
        valuable_examples: ctx.valuable_examples_formatted || "(none)",
        vertical,
      });
      // OpenAI /v1/responses + web_search tool. Tool name is `web_search`
      // (not the older `web_search_preview` GA-preview name).
      const body = {
        model: prompt.model,
        input: [{ role: "user", content: rendered }],
        tools: [{ type: "web_search" }],
        temperature: prompt.params.temperature ?? 0.5,
      };
      const resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
      const data = await resp.json();
      let text = "";
      if (typeof data.output_text === "string") text = data.output_text;
      else if (Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content) if (typeof c.text === "string") text += c.text;
          }
        }
      }
      if (!text) throw new Error(`No text in ChatGPT response: ${JSON.stringify(data).slice(0, 240)}`);
      const arrText = extractJsonArray(text);
      if (!arrText) throw new Error(`No JSON array in ChatGPT response: ${text.slice(0, 240)}`);
      const parsed = JSON.parse(arrText);
      if (!Array.isArray(parsed)) throw new Error("Parsed ChatGPT response is not an array");
      const usage = data.usage || {};
      const proposals = parsed
        .filter((p) => p && typeof p === "object" && p.topic)
        .map((p) => ({ ...p, vertical: p.vertical || vertical }));
      return {
        vertical,
        proposals,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
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
        console.log(`ChatGPT shard error: ${r.reason?.message || r.reason}`);
      }
    }
    const successCount = settled.filter((r) => r.status === "fulfilled").length;
    console.log(`ChatGPT discovery: ${allProposals.length} proposals across ${successCount}/${verticals.length} shards (${JSON.stringify(perVerticalCounts)}), ${totalIn} in / ${totalOut} out`);

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
