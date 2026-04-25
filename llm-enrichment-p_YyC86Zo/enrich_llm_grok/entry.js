// Pipedream Workflow Step: Grok specialist — cultural context + social pulse
//
// Round 1 specialist. Grok's training on X/social data makes it well-suited
// for understanding the cultural "why" behind a trend — what vibe shift is
// happening, what's driving adoption, and what the social conversation feels like.
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file — cross-file imports (./lib/*, sibling .js, sibling
// .mjs) all fail at deploy time. Canonical source lives at
// /home/marty/dev/Trend-Tree/agents/lib/prompt_loader.mjs — keep edits in sync.
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
    throw new Error(
      `Prompt '${key}' not loaded. Confirm DIM_LLM_PROMPT has IS_ACTIVE=TRUE for this key and the query_prompts step's IN clause includes it.`,
    );
  }
  return p;
}

const PROMPT_KEY = "enrichment.grok.cultural";

export default defineComponent({
  name: "LLM Enrich: Grok",
  description: "Grok specialist — cultural context, vibe shift, social pulse",
  version: "0.0.2",
  props: {
    x_ai: { type: "app", app: "x_ai" },
    enrich_context: {
      type: "object",
      label: "Trend enrichment context",
      description: "Output from the build_llm_context step",
    },
    prompts_rows: {
      type: "any",
      label: "DIM_LLM_PROMPT rows",
      description: "Output of the query_prompts step",
    },
  },
  async run() {
    const ctx = this.enrich_context;
    if (!ctx || !ctx.trend_topic) {
      console.log("No LLM context, skipping");
      return null;
    }
    if (ctx.enrichment_type && ctx.enrichment_type !== "FULL") {
      console.log(`Enrichment type is ${ctx.enrichment_type}, skipping Grok LLM call`);
      return null;
    }

    const loaded = loadPrompts(this.prompts_rows);
    const prompt = mustGet(loaded, PROMPT_KEY);

    const s = ctx.sources || {};
    const bsky = s.bluesky || {};
    const gt = s.google_trends || {};
    const tt = s.tiktok || {};
    const pin = s.pinterest || {};

    const social_quotes_formatted = (bsky.social_top_posts || [])
      .map((p, i) => `  ${i + 1}. "${(p.text || "").slice(0, 500)}"`)
      .join("\n") || "  (no social posts found)";

    const hashtags_formatted = (ctx.hashtags || []).length > 0 ? ctx.hashtags.join(", ") : "(none)";

    const co_hashtags_formatted = (bsky.social_hashtags || [])
      .slice(0, 15)
      .map((h) => `#${h.tag} (${h.count})`)
      .join(", ") || "none";

    const tiktok_hashtags_formatted = (tt.tiktok_hashtags || []).length > 0
      ? `: ${tt.tiktok_hashtags.map((h) => h.hashtag).join(", ")}`
      : "";

    const rendered = render(prompt.template, {
      trend_topic: ctx.trend_topic,
      velocity: ctx.velocity,
      heat_index: ctx.heat_index,
      hashtags_formatted,
      social_quotes_formatted,
      co_hashtags_formatted,
      sentiment_positive: bsky.social_sentiment?.positive ?? 0,
      sentiment_negative: bsky.social_sentiment?.negative ?? 0,
      gt_interest_score: gt.gt_interest_score ?? "N/A",
      gt_related_query_count: (gt.gt_related_queries || []).length,
      tiktok_hashtag_count: tt.tiktok_hashtag_count ?? 0,
      tiktok_hashtags_formatted,
      pinterest_trend_count: pin.pinterest_trend_count ?? 0,
    });

    try {
      const resp = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.x_ai.$auth.api_key}`,
        },
        body: JSON.stringify({
          model: prompt.model,
          messages: [{ role: "user", content: rendered }],
          temperature: prompt.params.temperature ?? 0.4,
          response_format: prompt.params.response_format ?? { type: "json_object" },
        }),
      });

      if (!resp.ok) throw new Error(`Grok HTTP ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content || "";
      const result = JSON.parse(text);

      const usage = data.usage || {};
      result._token_usage = {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        model: prompt.model,
      };
      result._prompt = { key: PROMPT_KEY, version: prompt.version };

      console.log(`Grok: vibe_shift="${(result.vibe_shift || "").slice(0, 80)}..."`);
      console.log(`  Drivers: ${(result.cultural_drivers || []).map((d) => d.driver).join(", ")}`);
      console.log(`  Seasonal: ${result.seasonal_relevance?.is_seasonal ? result.seasonal_relevance.peak_months.join(", ") : "not seasonal"}`);
      console.log(`  Tokens: ${result._token_usage.input} in / ${result._token_usage.output} out`);
      console.log(`  Prompt: ${PROMPT_KEY} v${prompt.version}`);

      return result;
    } catch (e) {
      console.log(`Grok error: ${e.message}`);
      return null;
    }
  },
});
