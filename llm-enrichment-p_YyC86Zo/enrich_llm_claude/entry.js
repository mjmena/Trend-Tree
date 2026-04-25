// Pipedream Workflow Step: Claude synthesizer — final enrichment assembly
//
// Round 2 synthesizer. Receives outputs from Round 1 specialists
// (Gemini, Grok) plus source evidence, and produces the final
// trend profile: B2B/B2C naming, short/long summaries, and
// categorization. The Snowflake write step is NOT in this workflow —
// that's the orchestrator's step 4.
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

const PROMPT_KEY = "enrichment.claude.synthesize";

export default defineComponent({
  name: "LLM Enrich: Claude Synthesizer",
  description: "Claude synthesizer — naming, summaries, categorization",
  version: "0.0.3",
  props: {
    anthropic: { type: "app", app: "anthropic" },
    enrich_context: {
      type: "object",
      label: "Trend enrichment context",
      description: "Output from the build_llm_context step",
    },
    gemini_output: {
      type: "object",
      label: "Gemini specialist output",
      description: "Output from the enrich_llm_gemini step",
      optional: true,
    },
    grok_output: {
      type: "object",
      label: "Grok specialist output",
      description: "Output from the enrich_llm_grok step",
      optional: true,
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
      console.log(`Enrichment type is ${ctx.enrichment_type}, skipping Claude synthesis`);
      return null;
    }

    const loaded = loadPrompts(this.prompts_rows);
    const prompt = mustGet(loaded, PROMPT_KEY);

    const gemini = this.gemini_output ?? null;
    const grok = this.grok_output ?? null;

    const modelsUsed = [];
    if (gemini) modelsUsed.push(gemini._token_usage?.model || "gemini-2.5-flash");
    if (grok) modelsUsed.push(grok._token_usage?.model || "grok-3-mini-fast");
    modelsUsed.push(prompt.model);

    const s = ctx.sources || {};
    const gdelt = s.gdelt || {};
    const wiki = s.wikimedia || {};
    const bsky = s.bluesky || {};
    const gt = s.google_trends || {};
    const amz = s.amazon || {};
    const pin = s.pinterest || {};
    const tt = s.tiktok || {};

    const hashtags_formatted = (ctx.hashtags || []).length > 0 ? ctx.hashtags.join(", ") : "(none)";

    const source_evidence = [
      `- GDELT: ${gdelt.gdelt_article_count_7d ?? 0} articles across ${gdelt.gdelt_domain_count_7d ?? 0} domains, tone=${gdelt.gdelt_tone_avg ?? "N/A"}`,
      `- Wikipedia: "${wiki.wiki_article_title ?? "none"}" — ${wiki.wiki_pageviews_7d ?? 0} views/wk, ${wiki.wiki_pageview_growth_pct ?? "N/A"}% growth`,
      `- Bluesky: ${bsky.social_post_count_7d ?? 0} posts, ${bsky.social_avg_engagement ?? 0} avg engagement`,
      `- Sentiment: +${bsky.social_sentiment?.positive ?? 0}/-${bsky.social_sentiment?.negative ?? 0}`,
      `- Google Trends: search interest ${gt.gt_interest_score ?? "N/A"}/100, ${(gt.gt_related_queries || []).length} related queries`,
      `- Amazon Movers & Shakers: ${amz.amazon_product_count ?? 0} matching products${amz.amazon_avg_price ? `, avg price $${amz.amazon_avg_price}` : ""}${(amz.amazon_top_departments || []).length > 0 ? `, depts: ${amz.amazon_top_departments.map((d) => d.department).join(", ")}` : ""}`,
      `- Pinterest: ${pin.pinterest_trend_count ?? 0} trending articles${(pin.pinterest_categories || []).length > 0 ? ` (${pin.pinterest_categories.map((c) => c.category).join(", ")})` : ""}`,
      `- TikTok: ${tt.tiktok_hashtag_count ?? 0} trending hashtags${tt.tiktok_best_rank ? `, best rank #${tt.tiktok_best_rank}` : ""}${tt.tiktok_total_views ? `, ${tt.tiktok_total_views.toLocaleString()} views` : ""}`,
    ].join("\n");

    const social_quotes_formatted = (bsky.social_top_posts || [])
      .map((p, i) => `${i + 1}. "${(p.text || "").slice(0, 500)}"`)
      .join("\n") || "(none)";

    // Strip only the NEW audit field (_prompt) so input matches pre-migration
    // bytes — old code stringified the full specialist output including
    // _token_usage. This keeps prompt-version visible in the workflow response
    // (return_llm_output) without changing what Claude actually sees.
    const stripNew = (o) => {
      if (!o) return o;
      const { _prompt, ...rest } = o;
      return rest;
    };

    const gemini_output_json = gemini ? JSON.stringify(stripNew(gemini), null, 2) : "UNAVAILABLE — this specialist failed";
    const grok_output_json = grok ? JSON.stringify(stripNew(grok), null, 2) : "UNAVAILABLE — this specialist failed";

    const rendered = render(prompt.template, {
      trend_topic: ctx.trend_topic,
      cluster_size: ctx.cluster_size,
      heat_index: ctx.heat_index,
      velocity: ctx.velocity,
      hashtags_formatted,
      source_evidence,
      gemini_output_json,
      grok_output_json,
      social_quotes_formatted,
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

      if (!resp.ok) throw new Error(`Claude HTTP ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const text = data?.content?.[0]?.text || "";

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in Claude response");
      const result = JSON.parse(jsonMatch[0]);

      console.log(`Claude synthesis: B2B="${result.trend_name_b2b}" / B2C="${result.trend_name_b2c}" — ${result.category}/${result.subcategory}`);
      console.log(`  Short: ${(result.summary_short || "").slice(0, 120)}`);
      console.log(`  Long: ${(result.summary_long || "").slice(0, 120)}`);

      const usage = data.usage || {};
      result._token_usage = {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        model: prompt.model,
      };
      result._prompt = { key: PROMPT_KEY, version: prompt.version };
      result._models_used = modelsUsed;

      console.log(`  Tokens: ${result._token_usage.input} in / ${result._token_usage.output} out`);
      console.log(`  Prompt: ${PROMPT_KEY} v${prompt.version}`);

      return result;
    } catch (e) {
      console.log(`Claude error: ${e.message}`);
      return null;
    }
  },
});
