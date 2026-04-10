// Pipedream Workflow Step: Claude synthesizer — final enrichment assembly
//
// Round 2 synthesizer. Receives outputs from Round 1 specialists
// (Gemini, Grok) plus source evidence, and produces the final
// trend profile: B2B/B2C naming, short/long summaries, and
// categorization. The Snowflake write step is NOT in this workflow —
// that's the orchestrator's step 4.

export default defineComponent({
  name: "LLM Enrich: Claude Synthesizer",
  description: "Claude synthesizer — naming, summaries, categorization",
  version: "0.0.2",
  props: {
    anthropic: {
      type: "app",
      app: "anthropic",
    },
    enrich_context: {
      type: "object",
      label: "Trend enrichment context",
      description: "Output from the load_llm_context step",
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

    // Gather specialist outputs (any may be null if that step failed)
    const gemini = this.gemini_output ?? null;
    const grok = this.grok_output ?? null;

    const modelsUsed = [];
    if (gemini) modelsUsed.push("gemini-2.5-flash");
    if (grok) modelsUsed.push("grok-3-mini-fast");

    const s = ctx.sources || {};
    const gdelt = s.gdelt || {};
    const wiki = s.wikimedia || {};
    const bsky = s.bluesky || {};
    const gt = s.google_trends || {};
    const amz = s.amazon || {};
    const pin = s.pinterest || {};
    const tt = s.tiktok || {};

    modelsUsed.push("claude-sonnet-4-6");

    const prompt = `You are the final synthesizer in a multi-model trend analysis pipeline. Your job is to take the specialist analyses below, the source evidence, and produce a definitive trend profile focused on consumer-facing naming (both a professional B2B register and a quirky B2C register), short and long summaries, and categorization. The trend itself has already been validated by the upstream clustering pipeline — do not re-judge whether it is a real trend. Ground everything in the source evidence — don't invent claims unsupported by the data.

TREND: ${ctx.trend_topic}
CLUSTER SIZE: ${ctx.cluster_size} | HEAT: ${ctx.heat_index}/100 | VELOCITY: ${ctx.velocity}
RELATED HASHTAGS: ${(ctx.hashtags || []).length > 0 ? ctx.hashtags.join(", ") : "(none)"}

SOURCE EVIDENCE:
- GDELT: ${gdelt.gdelt_article_count_7d ?? 0} articles across ${gdelt.gdelt_domain_count_7d ?? 0} domains, tone=${gdelt.gdelt_tone_avg ?? "N/A"}
- Wikipedia: "${wiki.wiki_article_title ?? "none"}" — ${wiki.wiki_pageviews_7d ?? 0} views/wk, ${wiki.wiki_pageview_growth_pct ?? "N/A"}% growth
- Bluesky: ${bsky.social_post_count_7d ?? 0} posts, ${bsky.social_avg_engagement ?? 0} avg engagement
- Sentiment: +${bsky.social_sentiment?.positive ?? 0}/-${bsky.social_sentiment?.negative ?? 0}
- Google Trends: search interest ${gt.gt_interest_score ?? "N/A"}/100, ${(gt.gt_related_queries || []).length} related queries
- Amazon Movers & Shakers: ${amz.amazon_product_count ?? 0} matching products${amz.amazon_avg_price ? `, avg price $${amz.amazon_avg_price}` : ""}${(amz.amazon_top_departments || []).length > 0 ? `, depts: ${amz.amazon_top_departments.map((d) => d.department).join(", ")}` : ""}
- Pinterest: ${pin.pinterest_trend_count ?? 0} trending articles${(pin.pinterest_categories || []).length > 0 ? ` (${pin.pinterest_categories.map((c) => c.category).join(", ")})` : ""}
- TikTok: ${tt.tiktok_hashtag_count ?? 0} trending hashtags${tt.tiktok_best_rank ? `, best rank #${tt.tiktok_best_rank}` : ""}${tt.tiktok_total_views ? `, ${tt.tiktok_total_views.toLocaleString()} views` : ""}

GEMINI ASSESSMENT (validation + categorization):
${gemini ? JSON.stringify(gemini, null, 2) : "UNAVAILABLE — this specialist failed"}

GROK ASSESSMENT (cultural context + social pulse):
${grok ? JSON.stringify(grok, null, 2) : "UNAVAILABLE — this specialist failed"}

REAL SOCIAL QUOTES:
${(bsky.social_top_posts || []).map((p, i) => `${i + 1}. "${(p.text || "").slice(0, 500)}"`).join("\n") || "(none)"}

Now synthesize all of this into a final trend profile. Where specialists agree, be confident. Where they disagree, use your judgment. Ground everything in the source evidence — don't invent claims unsupported by the data.

Respond in valid JSON:
{
  "trend_name_b2b": string,          // 2-5 words, direct, professional register — for B2B dashboard
  "trend_name_b2c": string,          // 2-5 words, quirky, consumer-facing — for public-facing dashboard
  "summary_short": string,           // 1-2 sentences for dashboard card view
  "summary_long": string,            // 1 paragraph for deep-dive view
  "category": string,                // must be one of: wellness, food_beverage, beauty, fitness, fashion, home_living, sustainability, consumer_tech, personal_care, social_lifestyle, entertainment, travel, parenting, other
  "subcategory": string              // lowercase snake_case, e.g. "gut_health", "functional_beverages"
}`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.anthropic.$auth.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
        }),
      });

      if (!resp.ok) throw new Error(`Claude HTTP ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const text = data?.content?.[0]?.text || "";

      // Extract JSON from response (Claude may wrap in markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in Claude response");
      const result = JSON.parse(jsonMatch[0]);

      console.log(`Claude synthesis: B2B="${result.trend_name_b2b}" / B2C="${result.trend_name_b2c}" — ${result.category}/${result.subcategory}`);
      console.log(`  Short: ${(result.summary_short || "").slice(0, 120)}`);
      console.log(`  Long: ${(result.summary_long || "").slice(0, 120)}`);

      // Token usage tracking
      const usage = data.usage || {};
      result._token_usage = {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        model: "claude-sonnet-4-6",
      };

      console.log(`  Tokens: ${result._token_usage.input} in / ${result._token_usage.output} out`);

      // Attach metadata
      result._models_used = modelsUsed;
      result._specialist_outputs = {
        gemini: gemini || null,
        grok: grok || null,
      };

      return result;
    } catch (e) {
      console.log(`Claude error: ${e.message}`);
      return null;
    }
  },
});
