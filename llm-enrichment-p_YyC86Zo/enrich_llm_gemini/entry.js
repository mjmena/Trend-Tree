// Pipedream Workflow Step: Gemini specialist — categorization + competitive landscape
//
// Round 1 specialist. Receives the enrich_context bundle from build_llm_context
// and asks Gemini to classify the trend and surface useful context for the
// downstream Claude synthesizer. Clustering already validated the trend —
// Gemini does not re-judge validity, confidence, or lifecycle.
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

const PROMPT_KEY = "enrichment.gemini.categorize";

export default defineComponent({
  name: "LLM Enrich: Gemini",
  description: "Gemini specialist — categorization + competitive landscape",
  version: "0.0.2",
  props: {
    google_gemini: { type: "app", app: "google_gemini" },
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
      console.log("No LLM context from build_llm_context step, skipping");
      return null;
    }
    if (ctx.enrichment_type && ctx.enrichment_type !== "FULL") {
      console.log(`Enrichment type is ${ctx.enrichment_type}, skipping Gemini LLM call`);
      return null;
    }

    const loaded = loadPrompts(this.prompts_rows);
    const prompt = mustGet(loaded, PROMPT_KEY);

    const s = ctx.sources || {};
    const gdelt = s.gdelt || {};
    const wiki = s.wikimedia || {};
    const bsky = s.bluesky || {};
    const gt = s.google_trends || {};
    const amz = s.amazon || {};
    const pin = s.pinterest || {};
    const tt = s.tiktok || {};

    const top_signals_formatted = (ctx.top_signals || [])
      .map((sg, i) => `${i + 1}. "${sg.title || "untitled"}" (${sg.source || "unknown"}, ${sg.domain || "N/A"})`)
      .join("\n") || "(no signals)";

    const hashtags_formatted = (ctx.hashtags || []).length > 0 ? ctx.hashtags.join(", ") : "(none)";

    const source_evidence = [
      `- Media coverage: ${gdelt.gdelt_article_count_7d ?? 0} articles across ${gdelt.gdelt_domain_count_7d ?? 0} domains (tone: ${gdelt.gdelt_tone_avg ?? "N/A"})`,
      `- Wikipedia: "${wiki.wiki_article_title ?? "no match"}" — ${wiki.wiki_pageviews_7d ?? 0} views/week, ${wiki.wiki_pageview_growth_pct ?? "N/A"}% WoW growth`,
      `- Social: ${bsky.social_post_count_7d ?? 0} Bluesky posts, avg ${bsky.social_avg_engagement ?? 0} engagement`,
      `- Social sentiment: +${bsky.social_sentiment?.positive ?? 0} / -${bsky.social_sentiment?.negative ?? 0} / neutral ${bsky.social_sentiment?.neutral ?? 0}`,
      `- Google Trends: search interest ${gt.gt_interest_score ?? "N/A"}/100, ${(gt.gt_related_queries || []).length} related queries`,
      `- Amazon: ${amz.amazon_product_count ?? 0} related products trending on Amazon Movers & Shakers${amz.amazon_avg_price ? ` (avg $${amz.amazon_avg_price})` : ""}`,
      `- Pinterest: ${pin.pinterest_trend_count ?? 0} trending articles${(pin.pinterest_categories || []).length > 0 ? ` (${pin.pinterest_categories.map((c) => c.category).join(", ")})` : ""}`,
      `- TikTok: ${tt.tiktok_hashtag_count ?? 0} trending hashtags${tt.tiktok_best_rank ? `, best rank #${tt.tiktok_best_rank}` : ""}${tt.tiktok_total_views ? `, ${tt.tiktok_total_views.toLocaleString()} views` : ""}`,
    ].join("\n");

    const rendered = render(prompt.template, {
      trend_topic: ctx.trend_topic,
      cluster_size: ctx.cluster_size,
      heat_index: ctx.heat_index,
      velocity: ctx.velocity,
      top_signals_formatted,
      hashtags_formatted,
      source_evidence,
    });

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${prompt.model}:generateContent?key=${this.google_gemini.$auth.api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: rendered }] }],
            generationConfig: {
              responseMimeType: prompt.params.responseMimeType ?? "application/json",
              temperature: prompt.params.temperature ?? 0.3,
            },
          }),
        },
      );

      if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const result = JSON.parse(text);

      const usage = data.usageMetadata || {};
      result._token_usage = {
        input: usage.promptTokenCount || 0,
        output: usage.candidatesTokenCount || 0,
        model: prompt.model,
      };
      result._prompt = { key: PROMPT_KEY, version: prompt.version };

      console.log(`Gemini: category=${result.category}/${result.subcategory}`);
      console.log(`  Competitors: ${(result.competitor_landscape || []).map((c) => c.brand).join(", ")}`);
      console.log(`  Context notes: ${(result.context_notes || "").slice(0, 100)}`);
      console.log(`  Tokens: ${result._token_usage.input} in / ${result._token_usage.output} out`);
      console.log(`  Prompt: ${PROMPT_KEY} v${prompt.version}`);

      return result;
    } catch (e) {
      console.log(`Gemini error: ${e.message}`);
      return null;
    }
  },
});
