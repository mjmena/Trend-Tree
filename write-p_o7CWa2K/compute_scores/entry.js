// Write Enrichment — compute_scores
//
// Takes the LLM output payload from the dispatcher (the body of the
// llm-enrichment workflow's response) plus the freshly-queried
// FCT_TREND_SOURCE_METRICS rows, and assembles a single JSON payload
// shaped for direct consumption by the downstream merge_dim +
// insert_history registry actions (which unpack it via PARSE_JSON(:1)).
//
// Responsibilities:
//   1. Normalize category to the 13-value enum (plus subcategory snake_case)
//   2. Compute SOURCE_COVERAGE_BREADTH from the source metrics rows
//   3. Compute MODEL_AGREEMENT_SCORE (Gemini vs Claude, 4 dimensions)
//   4. Compute TREND_COMMERCIAL_SCORE (weighted composite, 0-100)
//   5. Compute SOURCE_METRICS_SNAPSHOT object for history
//   6. Determine ENRICHMENT_TIER (FULL | GATED | SOURCES_ONLY)
//   7. Stringify to payload_json for downstream SQL steps
//
// Port of trends-sql/pipedream/enrichment/enrich_write_snowflake.mjs.
// The legacy step executes SQL directly via this.snowflake.executeQuery;
// here we only build data and let the registry actions handle writes.
//
// For SOURCES_ONLY or REFRESH runs, or when llm_output is missing/null,
// returns payload_json = "{}" so the downstream MERGE/INSERT become
// no-ops (they match nothing). update_queue still runs and marks the
// row COMPLETED with tier = SOURCES_ONLY.

const CATEGORY_MAP = {
  // Canonical pass-through
  wellness: "wellness", food_beverage: "food_beverage", beauty: "beauty",
  fitness: "fitness", fashion: "fashion", home_living: "home_living",
  sustainability: "sustainability", consumer_tech: "consumer_tech",
  personal_care: "personal_care", social_lifestyle: "social_lifestyle",
  entertainment: "entertainment", travel: "travel",
  parenting: "parenting", other: "other",
  // Old enum → new
  food_diet: "food_beverage", home: "home_living",
  tech: "consumer_tech", cultural_shift: "social_lifestyle",
  // Common LLM drift variants
  "health & wellness": "wellness", "health_wellness": "wellness",
  "health and wellness": "wellness", "health": "wellness",
  "food & diet": "food_beverage", "food and diet": "food_beverage",
  "diet": "food_beverage", "nutrition": "food_beverage",
  "food & beverage": "food_beverage", "beverages": "food_beverage",
  "skincare": "beauty", "grooming": "personal_care",
  "personal care": "personal_care",
  "technology": "consumer_tech", "consumer technology": "consumer_tech",
  "culture": "social_lifestyle", "cultural shift": "social_lifestyle",
  "lifestyle": "social_lifestyle", "social": "social_lifestyle",
  "home & living": "home_living", "home decor": "home_living",
  "unknown": "other", "none": "other",
};

const normalizeCategory = (raw) => {
  if (!raw) return "other";
  return CATEGORY_MAP[String(raw).toLowerCase().trim()] ?? "other";
};

const normalizeSubcategory = (raw) => {
  if (!raw) return null;
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
};

// Strip internal metadata fields (_token_usage, _gated, etc.) before
// storing an LLM response in Snowflake.
const stripMeta = (obj) => {
  if (!obj || typeof obj !== "object") return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("_")) clean[k] = v;
  }
  return clean;
};

function computeAgreement(gemini, claude) {
  if (!gemini || !claude) return { score: null, notes: "" };
  let agreements = 0;
  let comparisons = 0;
  const contradictions = [];

  // 1. Validity
  if (gemini.is_valid_trend !== undefined && claude.is_valid_trend !== undefined) {
    comparisons++;
    if (gemini.is_valid_trend === claude.is_valid_trend) agreements++;
    else contradictions.push(`validity: Gemini=${gemini.is_valid_trend}, Claude=${claude.is_valid_trend}`);
  }

  // 2. Category (both were normalized before this function runs)
  if (gemini.category && claude.category) {
    comparisons++;
    if (gemini.category === claude.category) agreements++;
    else contradictions.push(`category: Gemini="${gemini.category}", Claude="${claude.category}"`);
  }

  // 3. Lifecycle with adjacent-stage partial credit
  if (gemini.lifecycle_stage && claude.lifecycle_stage) {
    comparisons++;
    const g = String(gemini.lifecycle_stage).toLowerCase();
    const c = String(claude.lifecycle_stage).toLowerCase();
    if (g === c) {
      agreements++;
    } else {
      const ordered = ["emerging", "growing", "mainstream", "saturated"];
      const gi = ordered.indexOf(g);
      const ci = ordered.indexOf(c);
      if (gi >= 0 && ci >= 0 && Math.abs(gi - ci) === 1) {
        agreements += 0.5;
        contradictions.push(`lifecycle: Gemini="${g}", Claude="${c}" (adjacent)`);
      } else {
        contradictions.push(`lifecycle: Gemini="${g}", Claude="${c}"`);
      }
    }
  }

  // 4. Confidence numeric proximity
  const gConf = typeof gemini.confidence === "number" ? gemini.confidence : null;
  const cConf = typeof claude.confidence_score === "number" ? claude.confidence_score : null;
  if (gConf !== null && cConf !== null) {
    comparisons++;
    const diff = Math.abs(gConf - cConf);
    if (diff <= 0.15) agreements++;
    else if (diff <= 0.3) agreements += 0.5;
    else contradictions.push(`confidence: Gemini=${gConf}, Claude=${cConf} (gap=${diff.toFixed(2)})`);
  }

  return {
    score: comparisons > 0 ? Math.round((agreements / comparisons) * 100) / 100 : null,
    notes: contradictions.join("; "),
  };
}

function computeCommercialScore({ claude, chatgpt, gtInterest, bluesky, sourceCoverage }) {
  if (!claude) return null;
  const sponsorship = claude.sponsorship_fit_score ?? 0;
  const coverage = (sourceCoverage / 7) * 100;
  const confidence = claude.confidence_score ?? 0;

  const brands = claude.brand_associations || [];
  const brandQuality = brands.length > 0
    ? brands.reduce((s, b) => s + (b.fit_score || 0), 0) / brands.length
    : 0;

  const socialPosts = bluesky?.social_post_count_7d ?? 0;
  const socialBuzz = Math.min(socialPosts * 2, 100);

  const hasContent = chatgpt !== null && chatgpt !== undefined;
  const contentAngles = chatgpt?.content_angles?.length ?? 0;
  const socialHooks = chatgpt?.social_hooks?.length ?? 0;
  const contentRichness = hasContent
    ? Math.min(contentAngles * 12 + socialHooks * 10, 100)
    : 0;

  const rawScore = hasContent
    ? sponsorship * 0.25 +
      coverage * 0.10 +
      brandQuality * 0.20 +
      gtInterest * 0.10 +
      contentRichness * 0.15 +
      socialBuzz * 0.20
    : sponsorship * 0.30 +
      coverage * 0.15 +
      brandQuality * 0.25 +
      gtInterest * 0.15 +
      socialBuzz * 0.15;

  if (!claude.is_valid_trend) {
    return Math.round(Math.min(rawScore * 0.25, 25));
  }
  const confMultiplier = 0.5 + confidence * 0.5;
  const bonus = sourceCoverage >= 3 ? 5 : 0;
  return Math.round(Math.min(rawScore * confMultiplier + bonus, 100));
}

export default defineComponent({
  props: {
    trend_id: {
      type: "string",
      label: "Trend ID",
    },
    enrichment_type: {
      type: "string",
      label: "Enrichment type",
      description: "FULL | SOURCES_ONLY | REFRESH — from queue or sources workflow",
      optional: true,
    },
    llm_output: {
      type: "any",
      label: "Full LLM workflow response body",
      description: "The response body of the llm-enrichment workflow, or null for SOURCES_ONLY runs",
      optional: true,
    },
    source_metrics_rows: {
      type: "any",
      label: "FCT_TREND_SOURCE_METRICS rows (from query_source_metrics)",
      optional: true,
    },
  },
  async run({ $ }) {
    const trendId = this.trend_id;
    if (!trendId) throw new Error("trend_id is required");

    const enrichmentType = this.enrichment_type || "FULL";
    const llmOutput = this.llm_output || null;

    // ── Source coverage + history snapshot (from fresh FCT query) ────
    const sourceRows = this.source_metrics_rows || [];
    const sourceCoverage = sourceRows.length;
    const sourceSnapshot = {};
    for (const r of sourceRows) {
      if (!r.SOURCE_NAME) continue;
      sourceSnapshot[r.SOURCE_NAME] = {
        headline_metric: r.HEADLINE_METRIC,
        headline_metric_name: r.HEADLINE_METRIC_NAME,
      };
    }

    // ── Early return for non-FULL runs ───────────────────────────────
    if (enrichmentType !== "FULL" || !llmOutput) {
      console.log(`Skipping DIM write: enrichment_type=${enrichmentType}, has_llm_output=${!!llmOutput}`);
      $.export("$summary", `${trendId} [${enrichmentType}] — DIM skipped`);
      return {
        trend_id: trendId,
        enrichment_type: enrichmentType,
        tier: "SOURCES_ONLY",
        skip_dim: true,
        source_coverage: sourceCoverage,
        llm_total_tokens: 0,
        llm_cost_estimate: 0,
        payload: {},
        payload_json: "{}",
      };
    }

    // ── Extract LLM outputs ──────────────────────────────────────────
    const claudeRaw = llmOutput.claude_output ?? null;
    const geminiRaw = llmOutput.gemini_output ?? null;
    const grokRaw = llmOutput.grok_output ?? null;
    const chatgptRaw = llmOutput.chatgpt_output ?? null;

    if (!claudeRaw) {
      console.log("No Claude synthesizer output; marking gated");
      $.export("$summary", `${trendId} — no Claude output, gated`);
      return {
        trend_id: trendId,
        enrichment_type: "FULL",
        tier: "GATED",
        skip_dim: true,
        source_coverage: sourceCoverage,
        llm_total_tokens: llmOutput.llm_total_tokens || 0,
        llm_cost_estimate: llmOutput.llm_cost_estimate || 0,
        payload: {},
        payload_json: "{}",
      };
    }

    // Normalize categories before computing agreement
    const claude = { ...claudeRaw };
    claude.category = normalizeCategory(claude.category);
    claude.subcategory = normalizeSubcategory(claude.subcategory);

    const gemini = geminiRaw ? { ...geminiRaw, category: normalizeCategory(geminiRaw.category) } : null;
    const grok = grokRaw;
    const chatgpt = chatgptRaw;

    const wasGated = claudeRaw._gated === true || llmOutput.gated === true;
    const tier = wasGated ? "GATED" : "FULL";

    // ── Scoring ──────────────────────────────────────────────────────
    const { score: agreementScore, notes: agreementNotes } = computeAgreement(gemini, claude);

    const sources = llmOutput.enrich_context?.sources || {};
    const gtInterest = sources.google_trends?.gt_interest_score ?? 0;
    const bluesky = sources.bluesky ?? null;

    const commercialScore = computeCommercialScore({
      claude,
      chatgpt,
      gtInterest,
      bluesky,
      sourceCoverage,
    });

    // ── LLM responses (strip internal _fields) ───────────────────────
    const llmResponses = {
      claude: stripMeta(claude),
      gemini: stripMeta(gemini),
      grok: stripMeta(grok),
      chatgpt: stripMeta(chatgpt),
    };

    const brandCount = (claude.brand_associations || []).length;

    // ── Assemble the single payload object consumed by SQL PARSE_JSON ─
    const payload = {
      trend_id: trendId,
      trend_name: claude.trend_name ?? null,
      summary: claude.summary ?? null,
      category: claude.category,
      subcategory: claude.subcategory,
      lifecycle_stage: claude.lifecycle_stage ?? null,
      is_valid_trend: claude.is_valid_trend ?? null,
      confidence_score: claude.confidence_score ?? null,
      trend_commercial_score: commercialScore,
      source_coverage_breadth: sourceCoverage,
      target_demographics: claude.target_demographics ?? null,
      target_psychographics: claude.target_psychographics ?? null,
      audience_personas: claude.audience_personas ?? null,
      purchase_intent_signals: claude.purchase_intent_signals ?? null,
      brand_associations: claude.brand_associations ?? null,
      product_categories: claude.product_categories ?? null,
      competitor_landscape: gemini?.competitor_landscape ?? null,
      sponsorship_fit_score: claude.sponsorship_fit_score ?? null,
      monetization_angles: claude.monetization_angles ?? null,
      content_angles: chatgpt?.content_angles ?? null,
      social_hooks: chatgpt?.social_hooks ?? null,
      sponsored_content_ideas: chatgpt?.sponsored_content_ideas ?? null,
      stepps_analysis: chatgpt?.stepps_analysis ?? null,
      hashtag_strategy: chatgpt?.hashtag_strategy ?? null,
      voice_of_customer: grok?.voice_of_customer ?? null,
      vibe_shift: grok?.vibe_shift ?? null,
      social_narrative: grok?.social_narrative ?? null,
      cultural_drivers: grok?.cultural_drivers ?? null,
      seasonal_relevance: grok?.seasonal_relevance ?? null,
      geographic_hotspots: grok?.geographic_hotspots ?? null,
      llm_responses: llmResponses,
      models_used: llmOutput.models_used ?? claudeRaw._models_used ?? null,
      model_agreement_score: agreementScore,
      model_agreement_notes: agreementNotes || (claude.model_agreement_notes ?? null),
      llm_token_usage: llmOutput.llm_token_usage ?? null,
      llm_total_tokens: llmOutput.llm_total_tokens ?? 0,
      llm_cost_estimate: llmOutput.llm_cost_estimate ?? 0,
      // For history insert
      source_metrics_snapshot: sourceSnapshot,
      brand_association_count: brandCount,
    };

    console.log(`Computed: commercial=${commercialScore}, agreement=${agreementScore}, sources=${sourceCoverage}`);
    console.log(`Tokens: ${payload.llm_total_tokens}, cost: $${payload.llm_cost_estimate}`);
    console.log(`Tier: ${tier}, Trend: "${payload.trend_name}" (${payload.category}/${payload.subcategory})`);

    $.export("$summary", `${tier}: ${payload.trend_name} (${payload.category})`);

    return {
      trend_id: trendId,
      enrichment_type: "FULL",
      tier,
      skip_dim: false,
      source_coverage: sourceCoverage,
      commercial_score: commercialScore,
      agreement_score: agreementScore,
      llm_total_tokens: payload.llm_total_tokens,
      llm_cost_estimate: payload.llm_cost_estimate,
      payload,
      payload_json: JSON.stringify(payload),
    };
  },
});
