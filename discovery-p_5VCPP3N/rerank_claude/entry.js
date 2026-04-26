// Discovery — rerank_claude
//
// Reads the union of proposals from discover_{gemini,grok,chatgpt} and
// scores each with Claude. Drops proposals that overlap active trends,
// fail specificity, or have weak/missing URLs. Outputs the kept set
// (with source_model + score) for canonicalization.
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

const PROMPT_KEY = "discovery.claude.rerank";
const KEEP_THRESHOLD = 0.5;

export default defineComponent({
  name: "Discovery: Claude Rerank",
  description: "Claude scores + filters union of model proposals",
  version: "0.0.1",
  props: {
    anthropic: { type: "app", app: "anthropic" },
    prompts_rows: { type: "any", label: "DIM_LLM_PROMPT rows" },
    discovery_context: { type: "object", label: "build_discovery_context output" },
    gemini_proposals: { type: "object", optional: true },
    grok_proposals: { type: "object", optional: true },
    chatgpt_proposals: { type: "object", optional: true },
  },
  async run({ $ }) {
    const ctx = this.discovery_context || {};
    const loaded = loadPrompts(this.prompts_rows);
    const prompt = mustGet(loaded, PROMPT_KEY);

    // Collect proposals from all 3 search models, tagging each with source.
    const all = [];
    for (const [model, payload] of [
      ["gemini", this.gemini_proposals],
      ["grok", this.grok_proposals],
      ["chatgpt", this.chatgpt_proposals],
    ]) {
      const proposals = payload?.proposals || [];
      for (const p of proposals) {
        all.push({
          source_model: model,
          source_model_full: payload?.model || model,
          topic: String(p.topic || "").slice(0, 200),
          evidence_url: String(p.evidence_url || "").trim(),
          why_now: String(p.why_now || "").slice(0, 600),
        });
      }
    }

    if (all.length === 0) {
      console.log("No proposals to rerank — returning empty kept set");
      $.export("$summary", "0 proposals from upstream — nothing to rerank");
      return { kept_proposals: [], dropped_count: 0, raw_input_count: 0, _token_usage: { input: 0, output: 0, model: prompt.model } };
    }

    // Format proposals for the prompt: numbered list with index for the rubric
    const proposalsFormatted = all.map((p, i) =>
      `${i}. [${p.source_model}] "${p.topic}"\n   URL: ${p.evidence_url || "(missing)"}\n   why_now: ${p.why_now}`,
    ).join("\n\n");

    const rendered = render(prompt.template, {
      active_trends: ctx.active_trends_formatted || "(none)",
      valuable_examples: ctx.valuable_examples_formatted || "(none)",
      proposals: proposalsFormatted,
    });

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.anthropic.$auth.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: prompt.model,
          max_tokens: prompt.params.max_tokens ?? 4096,
          messages: [{ role: "user", content: rendered }],
          temperature: prompt.params.temperature ?? 0.3,
        }),
      });

      if (!resp.ok) throw new Error(`Claude HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
      const data = await resp.json();
      const text = data?.content?.[0]?.text || "";

      // Extract JSON array (Claude may wrap in code block).
      const arrMatch = text.match(/\[[\s\S]*\]/);
      if (!arrMatch) throw new Error(`No JSON array in Claude response: ${text.slice(0, 240)}`);
      const scores = JSON.parse(arrMatch[0]);
      if (!Array.isArray(scores)) throw new Error("Claude response is not an array");

      // Apply keep filter — index into the original `all` array
      const kept = [];
      const dropped = [];
      for (const s of scores) {
        const idx = Number(s.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= all.length) continue;
        const p = all[idx];
        const score = Number(s.score) || 0;
        const keep = (s.keep === true || s.keep === "true") && score >= KEEP_THRESHOLD;
        const decorated = { ...p, score, reasoning: String(s.reasoning || "").slice(0, 400) };
        if (keep) kept.push(decorated);
        else dropped.push(decorated);
      }

      const usage = data.usage || {};
      console.log(
        `Claude rerank: ${all.length} input → ${kept.length} kept, ${dropped.length} dropped ` +
        `(${usage.input_tokens || 0}in/${usage.output_tokens || 0}out)`,
      );
      $.export("$summary", `${kept.length}/${all.length} kept from rerank`);

      return {
        kept_proposals: kept,
        dropped_count: dropped.length,
        raw_input_count: all.length,
        _token_usage: {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          model: prompt.model,
        },
        prompt_key: PROMPT_KEY,
        prompt_version: prompt.version,
      };
    } catch (e) {
      console.log(`Claude rerank error: ${e.message}`);
      // On rerank failure, pass through everything ungated rather than drop
      // all the upstream work. Better to over-include and let canonicalize
      // + dedupe trim than to drop the whole run.
      return {
        kept_proposals: all.map((p) => ({ ...p, score: 0, reasoning: `rerank failed: ${e.message}` })),
        dropped_count: 0,
        raw_input_count: all.length,
        error: e.message,
      };
    }
  },
});
