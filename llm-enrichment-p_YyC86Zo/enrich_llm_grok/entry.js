// Pipedream Workflow Step: Grok specialist — cultural context + social pulse
//
// Round 1 specialist. Grok's training on X/social data makes it well-suited
// for understanding the cultural "why" behind a trend — what vibe shift is
// happening, what's driving adoption, and what the social conversation feels like.

export default {
  name: "LLM Enrich: Grok",
  description: "Grok specialist — cultural context, vibe shift, social pulse",
  version: "0.0.1",
  props: {
    x_ai: {
      type: "app",
      app: "x_ai",
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
      console.log(`Enrichment type is ${ctx.enrichment_type}, skipping Grok LLM call`);
      return null;
    }

    const s = ctx.sources || {};
    const bsky = s.bluesky || {};
    const gt = s.google_trends || {};
    const tt = s.tiktok || {};
    const pin = s.pinterest || {};

    const socialQuotes = (bsky.social_top_posts || [])
      .map((p, i) => `  ${i + 1}. "${(p.text || "").slice(0, 500)}"`)
      .join("\n");

    const prompt = `You are a cultural trends analyst who deeply understands internet culture and social movements. Analyze why this trend is happening RIGHT NOW and what cultural shift it represents.

TREND: ${ctx.trend_topic}
VELOCITY: ${ctx.velocity} | HEAT: ${ctx.heat_index}/100
RELATED HASHTAGS: ${(ctx.hashtags || []).length > 0 ? ctx.hashtags.join(", ") : "(none)"}

REAL SOCIAL POSTS about this trend:
${socialQuotes || "  (no social posts found)"}

CO-OCCURRING HASHTAGS: ${(bsky.social_hashtags || []).slice(0, 15).map((h) => `#${h.tag} (${h.count})`).join(", ") || "none"}

SOCIAL SENTIMENT: +${bsky.social_sentiment?.positive ?? 0} positive, -${bsky.social_sentiment?.negative ?? 0} negative
GOOGLE TRENDS SEARCH INTEREST: ${gt.gt_interest_score ?? "N/A"}/100, ${(gt.gt_related_queries || []).length} related queries
TIKTOK: ${tt.tiktok_hashtag_count ?? 0} trending hashtags${(tt.tiktok_hashtags || []).length > 0 ? `: ${tt.tiktok_hashtags.map((h) => h.hashtag).join(", ")}` : ""}
PINTEREST: ${pin.pinterest_trend_count ?? 0} trending articles

IMPORTANT: Base your analysis ONLY on the social posts, hashtags, and sentiment data above. If data is missing, output null rather than speculating. Do not invent quotes or cite information not provided.

Respond in valid JSON:
{
  "vibe_shift": string,              // 1-2 sentences: what cultural or behavioral shift does this represent?
  "cultural_drivers": [              // 2-4 drivers explaining WHY this is trending now
    {"driver": string, "explanation": string}
  ],
  "social_narrative": string,        // how are real people talking about this? what's the dominant framing?
  "geographic_hotspots": [           // where is this trend strongest? (US regions/states)
    {"region": string, "strength": "strong"|"moderate"|"emerging", "notes": string}
  ],
  "seasonal_relevance": {
    "is_seasonal": boolean,
    "peak_months": [string],         // e.g. ["January", "February"]
    "notes": string
  },
  "voice_of_customer": [             // 3-5 synthesized consumer perspectives based on the social data
    {"quote": string, "sentiment": "positive"|"negative"|"neutral", "persona_type": string}
  ]
}`;

    try {
      const resp = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.x_ai.$auth.api_key}`,
        },
        body: JSON.stringify({
          model: "grok-3-mini-fast",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4,
          response_format: { type: "json_object" },
        }),
      });

      if (!resp.ok) throw new Error(`Grok HTTP ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content || "";
      const result = JSON.parse(text);

      // Token usage tracking
      const usage = data.usage || {};
      result._token_usage = {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        model: "grok-3-mini-fast",
      };

      console.log(`Grok: vibe_shift="${(result.vibe_shift || "").slice(0, 80)}..."`);
      console.log(`  Drivers: ${(result.cultural_drivers || []).map((d) => d.driver).join(", ")}`);
      console.log(`  Seasonal: ${result.seasonal_relevance?.is_seasonal ? result.seasonal_relevance.peak_months.join(", ") : "not seasonal"}`);
      console.log(`  Tokens: ${result._token_usage.input} in / ${result._token_usage.output} out`);

      return result;
    } catch (e) {
      console.log(`Grok error: ${e.message}`);
      return null;
    }
  },
};
