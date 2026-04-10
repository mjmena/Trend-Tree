// Pipedream Workflow Step: Claude synthesizer — final enrichment assembly
//
// Round 2 synthesizer. Receives outputs from all Round 1 specialists
// (Gemini, Grok, ChatGPT) plus source evidence, and produces the final
// enrichment profile with audience profiling, brand strategy, and
// confidence scoring based on cross-model agreement. The Snowflake write
// step is NOT in this workflow — that's the orchestrator's step 4.

export default {
  name: "LLM Enrich: Claude Synthesizer",
  description: "Claude synthesizer — audience profiling, brand strategy, confidence scoring",
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
    chatgpt_output: {
      type: "object",
      label: "ChatGPT specialist output",
      description: "Output from the enrich_llm_chatgpt step",
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
    const chatgpt = this.chatgpt_output ?? null;

    const modelsUsed = [];
    if (gemini) modelsUsed.push("gemini-2.5-flash");
    if (grok) modelsUsed.push("grok-3-mini-fast");
    if (chatgpt) modelsUsed.push("gpt-4o-mini");

    const s = ctx.sources || {};
    const gdelt = s.gdelt || {};
    const wiki = s.wikimedia || {};
    const bsky = s.bluesky || {};
    const gt = s.google_trends || {};
    const amz = s.amazon || {};
    const pin = s.pinterest || {};
    const tt = s.tiktok || {};

    // ── Gemini validation gate ─────────────────────────────────────────
    // Skip expensive Claude synthesis when Gemini confidently says invalid
    // AND source evidence is weak. Saves ~$0.05+ per invalid trend.
    // Count the 7 active sources only (Reddit/McClatchy are not in pipeline).
    let sourceCoverage = 0;
    if ((gdelt.gdelt_article_count_7d ?? 0) > 0) sourceCoverage++;
    if ((wiki.wiki_pageviews_7d ?? 0) > 0) sourceCoverage++;
    if ((bsky.social_post_count_7d ?? 0) > 0) sourceCoverage++;
    if ((gt.gt_interest_score ?? 0) > 0) sourceCoverage++;
    if ((amz.amazon_product_count ?? 0) > 0) sourceCoverage++;
    if ((pin.pinterest_trend_count ?? 0) > 0) sourceCoverage++;
    if ((tt.tiktok_hashtag_count ?? 0) > 0) sourceCoverage++;

    if (gemini
        && gemini.is_valid_trend === false
        && (gemini.confidence ?? 0) >= 0.8
        && sourceCoverage <= 2) {
      console.log(`GATE: Gemini confidently invalid (confidence=${gemini.confidence}), source coverage=${sourceCoverage}/7 — skipping Claude API call`);
      modelsUsed.push("claude-sonnet-4-6-GATED");
      return {
        trend_name: ctx.trend_topic,
        summary: gemini.validation_reasoning || "Trend flagged as invalid by validation model.",
        category: gemini.category || "unknown",
        subcategory: gemini.subcategory || "unknown",
        lifecycle_stage: gemini.lifecycle_stage || "emerging",
        is_valid_trend: false,
        confidence_score: gemini.confidence,
        sponsorship_fit_score: 0,
        target_demographics: null,
        target_psychographics: null,
        audience_personas: null,
        purchase_intent_signals: null,
        brand_associations: [],
        product_categories: [],
        monetization_angles: [],
        model_agreement_notes: `Gemini gated: is_valid_trend=false (confidence=${gemini.confidence}). Claude synthesis skipped to save cost. Source coverage: ${sourceCoverage}/7.`,
        _models_used: modelsUsed,
        _specialist_outputs: { gemini, grok: grok || null, chatgpt: chatgpt || null },
        _token_usage: { input: 0, output: 0, model: "claude-sonnet-4-6" },
        _gated: true,
      };
    }

    modelsUsed.push("claude-sonnet-4-6");

    const prompt = `You are the final synthesizer in a multi-model trend analysis pipeline. Your job is to take the specialist analyses below, the source evidence, and produce a definitive trend enrichment profile focused on audience targeting and brand partnership opportunities for a news publisher (McClatchy).

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

CHATGPT ASSESSMENT (content strategy + STEPPS):
${chatgpt ? JSON.stringify(chatgpt, null, 2) : "UNAVAILABLE — this specialist failed"}

REAL SOCIAL QUOTES:
${(bsky.social_top_posts || []).map((p, i) => `${i + 1}. "${(p.text || "").slice(0, 500)}"`).join("\n") || "(none)"}

Now synthesize all of this into a final enrichment profile. Where specialists agree, be confident. Where they disagree, note the tension and use your judgment. Ground everything in the source evidence — don't invent claims unsupported by the data.

Respond in valid JSON:
{
  "trend_name": string,              // canonical 2-5 word name (improve on the raw topic if needed)
  "summary": string,                 // one paragraph: what, why, who cares, commercial potential
  "category": string,                // must be one of: wellness, food_beverage, beauty, fitness, fashion, home_living, sustainability, consumer_tech, personal_care, social_lifestyle, entertainment, travel, parenting, other
  "subcategory": string,             // lowercase snake_case, e.g. "gut_health", "functional_beverages"
  "lifecycle_stage": string,         // must be one of: emerging, growing, mainstream, saturated
  "is_valid_trend": boolean,
  "confidence_score": number,        // 0.0-1.0 based on source evidence strength + model agreement

  "target_demographics": {
    "age_ranges": [string],          // e.g. ["25-34", "35-44"]
    "gender_skew": string,           // "female-leaning"|"male-leaning"|"balanced"
    "income_bracket": string,        // "budget"|"mid-range"|"premium"|"luxury"
    "education": string
  },
  "target_psychographics": {
    "values": [string],              // what they care about
    "interests": [string],           // adjacent interests
    "lifestyle": string,             // one-sentence lifestyle description
    "media_habits": [string]         // where they consume content
  },
  "audience_personas": [             // 2-3 distinct buyer personas
    {
      "name": string,                // catchy persona name
      "description": string,         // 2-3 sentences
      "pain_points": [string],
      "media_consumption": [string]
    }
  ],
  "purchase_intent_signals": [string], // what people are actively buying/searching

  "brand_associations": [            // 5-8 brand partnership opportunities
    {
      "brand": string,
      "fit_score": number,           // 0-100
      "rationale": string,
      "partnership_type": string     // "sponsored_article"|"product_placement"|"affiliate"|"event"|"co-branded_content"
    }
  ],
  "product_categories": [
    {"category": string, "relevance": string, "example_products": [string]}
  ],
  "sponsorship_fit_score": number,   // 0-100 overall commercial viability
  "monetization_angles": [
    {"type": string, "description": string, "estimated_value": string}
  ],

  "model_agreement_notes": string    // where did specialists agree/disagree? what did you resolve?
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

      console.log(`Claude synthesis: "${result.trend_name}" — ${result.category}/${result.subcategory}`);
      console.log(`  Valid: ${result.is_valid_trend}, Confidence: ${result.confidence_score}, Sponsorship fit: ${result.sponsorship_fit_score}`);
      console.log(`  Demographics: ${result.target_demographics?.age_ranges?.join(", ")}, ${result.target_demographics?.gender_skew}`);
      console.log(`  Brands: ${(result.brand_associations || []).map((b) => `${b.brand} (${b.fit_score})`).join(", ")}`);
      console.log(`  Agreement notes: ${(result.model_agreement_notes || "").slice(0, 100)}`);

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
        chatgpt: chatgpt || null,
      };

      return result;
    } catch (e) {
      console.log(`Claude error: ${e.message}`);
      return null;
    }
  },
};
