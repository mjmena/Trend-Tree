// Pipedream Workflow Step: Gemini specialist — categorization + competitive landscape
//
// Round 1 specialist. Receives the enrich_context bundle from load_llm_context
// and asks Gemini to classify the trend and surface useful context for the
// downstream Claude synthesizer. Clustering already validated the trend —
// Gemini does not re-judge validity, confidence, or lifecycle.

export default defineComponent({
  name: "LLM Enrich: Gemini",
  description: "Gemini specialist — categorization + competitive landscape",
  version: "0.0.1",
  props: {
    google_gemini: {
      type: "app",
      app: "google_gemini",
    },
    enrich_context: {
      type: "object",
      label: "Trend enrichment context",
      description: "Output from the load_llm_context step",
    },
  },
  async run() {
    const ctx = this.enrich_context;
    if (!ctx || !ctx.trend_topic) {
      console.log("No LLM context from load_llm_context step, skipping");
      return null;
    }
    if (ctx.enrichment_type && ctx.enrichment_type !== "FULL") {
      console.log(`Enrichment type is ${ctx.enrichment_type}, skipping Gemini LLM call`);
      return null;
    }

    const s = ctx.sources || {};
    const gdelt = s.gdelt || {};
    const wiki = s.wikimedia || {};
    const bsky = s.bluesky || {};
    const gt = s.google_trends || {};
    const amz = s.amazon || {};
    const pin = s.pinterest || {};
    const tt = s.tiktok || {};

    const prompt = `You are a consumer trends analyst. Classify this trend and surface useful context for the downstream Claude synthesizer. The trend has already been validated by cross-source clustering — your job is categorization and competitive context, not validation.

TREND: ${ctx.trend_topic}
CLUSTER SIZE: ${ctx.cluster_size} signals from cross-source matching
HEAT INDEX: ${ctx.heat_index}/100
VELOCITY: ${ctx.velocity}

TOP SIGNALS (by PageRank centrality):
${(ctx.top_signals || []).map((s, i) => `${i + 1}. "${s.title || "untitled"}" (${s.source || "unknown"}, ${s.domain || "N/A"})`).join("\n") || "(no signals)"}

RELATED HASHTAGS: ${(ctx.hashtags || []).length > 0 ? ctx.hashtags.join(", ") : "(none)"}

SOURCE EVIDENCE:
- Media coverage: ${gdelt.gdelt_article_count_7d ?? 0} articles across ${gdelt.gdelt_domain_count_7d ?? 0} domains (tone: ${gdelt.gdelt_tone_avg ?? "N/A"})
- Wikipedia: "${wiki.wiki_article_title ?? "no match"}" — ${wiki.wiki_pageviews_7d ?? 0} views/week, ${wiki.wiki_pageview_growth_pct ?? "N/A"}% WoW growth
- Social: ${bsky.social_post_count_7d ?? 0} Bluesky posts, avg ${bsky.social_avg_engagement ?? 0} engagement
- Social sentiment: +${bsky.social_sentiment?.positive ?? 0} / -${bsky.social_sentiment?.negative ?? 0} / neutral ${bsky.social_sentiment?.neutral ?? 0}
- Google Trends: search interest ${gt.gt_interest_score ?? "N/A"}/100, ${(gt.gt_related_queries || []).length} related queries
- Amazon: ${amz.amazon_product_count ?? 0} related products trending on Amazon Movers & Shakers${amz.amazon_avg_price ? ` (avg $${amz.amazon_avg_price})` : ""}
- Pinterest: ${pin.pinterest_trend_count ?? 0} trending articles${(pin.pinterest_categories || []).length > 0 ? ` (${pin.pinterest_categories.map((c) => c.category).join(", ")})` : ""}
- TikTok: ${tt.tiktok_hashtag_count ?? 0} trending hashtags${tt.tiktok_best_rank ? `, best rank #${tt.tiktok_best_rank}` : ""}${tt.tiktok_total_views ? `, ${tt.tiktok_total_views.toLocaleString()} views` : ""}

IMPORTANT: Base your assessment ONLY on the source evidence above. If data is missing or insufficient for a field, output null rather than speculating. Do not invent statistics or cite information not provided.

Respond in valid JSON with these fields:
{
  "category": string,                // one of: wellness, food_beverage, beauty, fitness, fashion, home_living, sustainability, consumer_tech, personal_care, social_lifestyle, entertainment, travel, parenting, other
  "subcategory": string,             // more specific within the category, lowercase snake_case
  "competitor_landscape": [          // brands/companies active in this space — context for Claude's naming
    {"brand": string, "position": string, "activity_level": "high"|"medium"|"low"}
  ],
  "context_notes": string            // 2-3 sentences explaining the classification + any useful context for Claude
}`;

    try {
      // Use Gemini via Google AI API
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.google_gemini.$auth.api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.3,
            },
          }),
        },
      );

      if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const result = JSON.parse(text);

      // Token usage tracking
      const usage = data.usageMetadata || {};
      result._token_usage = {
        input: usage.promptTokenCount || 0,
        output: usage.candidatesTokenCount || 0,
        model: "gemini-2.5-flash",
      };

      console.log(`Gemini: category=${result.category}/${result.subcategory}`);
      console.log(`  Competitors: ${(result.competitor_landscape || []).map((c) => c.brand).join(", ")}`);
      console.log(`  Context notes: ${(result.context_notes || "").slice(0, 100)}`);
      console.log(`  Tokens: ${result._token_usage.input} in / ${result._token_usage.output} out`);

      return result;
    } catch (e) {
      console.log(`Gemini error: ${e.message}`);
      return null;
    }
  },
});
