// Pipedream Workflow Step: ChatGPT specialist — content strategy + STEPPS
//
// Round 1 specialist. ChatGPT excels at creative marketing copy and
// consumer-facing content ideation. Handles STEPPS framework analysis,
// content angles, social hooks, and hashtag strategy.

export default {
  name: "LLM Enrich: ChatGPT",
  description: "ChatGPT specialist — content angles, STEPPS, social hooks",
  version: "0.0.1",
  props: {
    openai: {
      type: "app",
      app: "openai",
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
      console.log("No LLM context, skipping");
      return null;
    }
    if (ctx.enrichment_type && ctx.enrichment_type !== "FULL") {
      console.log(`Enrichment type is ${ctx.enrichment_type}, skipping ChatGPT LLM call`);
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

    const topDomains = (gdelt.gdelt_top_domains || [])
      .slice(0, 10)
      .map((d) => `${d.domain} (${d.count} articles)`)
      .join(", ");

    const prompt = `You are a content strategist specializing in sponsored content and brand partnerships for a digital news publisher. Create a content and monetization strategy for this trend.

TREND: ${ctx.trend_topic}
CLUSTER SIZE: ${ctx.cluster_size} signals | HEAT: ${ctx.heat_index}/100
RELATED HASHTAGS: ${(ctx.hashtags || []).length > 0 ? ctx.hashtags.join(", ") : "(none)"}

MEDIA COVERING THIS: ${topDomains || "limited coverage"}
WIKIPEDIA: "${wiki.wiki_article_title ?? "no match"}" — ${wiki.wiki_pageviews_7d ?? 0} views/week
SOCIAL BUZZ: ${bsky.social_post_count_7d ?? 0} posts, ${bsky.social_avg_engagement ?? 0} avg engagement
GOOGLE TRENDS: search interest ${gt.gt_interest_score ?? "N/A"}/100${(gt.gt_related_queries || []).map((q) => q.query).slice(0, 5).join(", ") ? `, related: ${(gt.gt_related_queries || []).map((q) => q.query).slice(0, 5).join(", ")}` : ""}
AMAZON TRENDING: ${amz.amazon_product_count ?? 0} matching products${(amz.amazon_related_products || []).length > 0 ? `: ${amz.amazon_related_products.slice(0, 3).map((p) => p.title).join("; ")}` : ""}${amz.amazon_avg_price ? ` — avg $${amz.amazon_avg_price}` : ""}
PINTEREST: ${pin.pinterest_trend_count ?? 0} trends${(pin.pinterest_categories || []).length > 0 ? ` in ${pin.pinterest_categories.map((c) => c.category).join(", ")}` : ""}
TIKTOK: ${tt.tiktok_hashtag_count ?? 0} hashtags${tt.tiktok_total_views ? `, ${tt.tiktok_total_views.toLocaleString()} total views` : ""}

TOP SIGNAL TITLES:
${(ctx.top_signals || []).map((s) => `- "${s.title}" (${s.source})`).join("\n") || "(none)"}

IMPORTANT: Base your recommendations ONLY on the source evidence above. If data is insufficient for a field, output null rather than speculating. Do not invent brand names, statistics, or claims not supported by the data.

Respond in valid JSON:
{
  "content_angles": [                // 3-5 editorial angles a news publisher could pursue
    {
      "headline": string,            // compelling headline
      "hook": string,                // 1-2 sentence pitch for why readers care
      "format": string,              // "longform"|"listicle"|"how-to"|"interview"|"data-viz"|"video"
      "target_persona": string       // who this angle serves
    }
  ],
  "social_hooks": [                  // 3-4 social media content ideas
    {
      "platform": string,            // "instagram"|"tiktok"|"facebook"|"twitter"|"pinterest"
      "hook": string,                // the post concept
      "hashtags": [string],          // 3-5 relevant hashtags
      "format": string               // "reel"|"carousel"|"story"|"thread"|"pin"
    }
  ],
  "sponsored_content_ideas": [       // 2-3 specific brand partnership concepts
    {
      "concept": string,             // the sponsored content idea
      "ideal_brand_type": string,    // what kind of brand fits
      "audience": string,            // who it reaches
      "cta": string                  // call to action
    }
  ],
  "stepps_analysis": {               // Jonah Berger's STEPPS framework
    "social_currency": string,       // why sharing this makes people look good
    "triggers": string,              // what everyday cues remind people of this trend
    "emotion": string,               // what emotion does this evoke (awe, anxiety, humor, etc.)
    "public": string,                // how visible is this behavior to others
    "practical_value": string,       // what useful info can people share
    "stories": string                // what narrative wraps around this trend
  },
  "hashtag_strategy": [string]       // 10-15 hashtags across platforms, mix of broad and niche
}`;

    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.openai.$auth.api_key}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.5,
          response_format: { type: "json_object" },
        }),
      });

      if (!resp.ok) throw new Error(`ChatGPT HTTP ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content || "";
      const result = JSON.parse(text);

      // Token usage tracking
      const usage = data.usage || {};
      result._token_usage = {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        model: "gpt-4o-mini",
      };

      console.log(`ChatGPT: ${(result.content_angles || []).length} content angles, ${(result.social_hooks || []).length} social hooks, ${(result.sponsored_content_ideas || []).length} sponsor ideas`);
      console.log(`  STEPPS emotion: ${result.stepps_analysis?.emotion}`);
      console.log(`  Tokens: ${result._token_usage.input} in / ${result._token_usage.output} out`);

      return result;
    } catch (e) {
      console.log(`ChatGPT error: ${e.message}`);
      return null;
    }
  },
};
