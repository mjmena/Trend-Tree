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
//   2. Compute SOURCE_METRICS_SNAPSHOT object for history
//   3. Determine ENRICHMENT_TIER (FULL | SOURCES_ONLY)
//   4. Stringify to payload_json for downstream SQL steps
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
    if (!claudeRaw) {
      throw new Error(`compute_scores: no Claude synthesizer output for trend ${trendId} — expected a FULL run`);
    }

    const claude = { ...claudeRaw };
    claude.category = normalizeCategory(claude.category);
    claude.subcategory = normalizeSubcategory(claude.subcategory);

    const gemini = llmOutput.gemini_output
      ? { ...llmOutput.gemini_output, category: normalizeCategory(llmOutput.gemini_output.category) }
      : null;
    const grok = llmOutput.grok_output ?? null;

    const tier = "FULL";

    // ── LLM responses (strip internal _fields) ───────────────────────
    const llmResponses = {
      claude: stripMeta(claude),
      gemini: stripMeta(gemini),
      grok: stripMeta(grok),
    };

    // ── Assemble the single payload object consumed by SQL PARSE_JSON ─
    const payload = {
      trend_id: trendId,
      trend_name_b2b: claude.trend_name_b2b ?? null,
      trend_name_b2c: claude.trend_name_b2c ?? null,
      summary_short: claude.summary_short ?? null,
      summary_long: claude.summary_long ?? null,
      category: claude.category,
      subcategory: claude.subcategory,
      voice_of_customer: grok?.voice_of_customer ?? null,
      vibe_shift: grok?.vibe_shift ?? null,
      social_narrative: grok?.social_narrative ?? null,
      cultural_drivers: grok?.cultural_drivers ?? null,
      seasonal_relevance: grok?.seasonal_relevance ?? null,
      geographic_hotspots: grok?.geographic_hotspots ?? null,
      llm_responses: llmResponses,
      models_used: llmOutput.models_used ?? claudeRaw._models_used ?? null,
      llm_token_usage: llmOutput.llm_token_usage ?? null,
      llm_total_tokens: llmOutput.llm_total_tokens ?? 0,
      llm_cost_estimate: llmOutput.llm_cost_estimate ?? 0,
      // For history insert
      source_metrics_snapshot: sourceSnapshot,
    };

    console.log(`Tokens: ${payload.llm_total_tokens}, cost: $${payload.llm_cost_estimate}`);
    console.log(`Tier: ${tier}, Trend: B2B="${payload.trend_name_b2b}" / B2C="${payload.trend_name_b2c}" (${payload.category}/${payload.subcategory})`);

    $.export("$summary", `${tier}: ${payload.trend_name_b2c} (${payload.category})`);

    return {
      trend_id: trendId,
      enrichment_type: "FULL",
      tier,
      skip_dim: false,
      source_coverage: sourceCoverage,
      llm_total_tokens: payload.llm_total_tokens,
      llm_cost_estimate: payload.llm_cost_estimate,
      payload,
      payload_json: JSON.stringify(payload),
    };
  },
});
