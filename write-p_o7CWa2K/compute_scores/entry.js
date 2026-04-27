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
//   3. Stringify to payload_json for downstream SQL steps
//
// The SOURCES_ONLY / REFRESH gate has been removed — the promotion agent
// only queues trends that need enrichment, so every run is a FULL run
// from the dashboard's perspective. `enrichment_type` is captured for
// audit/telemetry but no longer skips the DIM write.

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

    // ── Skip DIM write only when llm_output is genuinely absent ──────
    // (e.g. agent loop errored out before propose_enrichment fired). The
    // legacy ENRICHMENT_TYPE gate is gone — every queued trend gets a
    // full DIM merge.
    if (!llmOutput) {
      console.log(`Skipping DIM write: no llm_output for ${trendId}`);
      $.export("$summary", `${trendId} — DIM skipped (no llm_output)`);
      return {
        trend_id: trendId,
        enrichment_type: enrichmentType,
        tier: "NO_OUTPUT",
        skip_dim: true,
        source_coverage: sourceCoverage,
        llm_total_tokens: 0,
        llm_cost_estimate: 0,
        payload: {},
        payload_json: "{}",
      };
    }

    // ── Extract LLM outputs ──────────────────────────────────────────
    // Phase 3: agent loop emits `enrichment_output` (canonical shape).
    // Legacy: 3-LLM cascade emits `claude_output` + `gemini_output` + `grok_output`.
    // Shape detection picks the right path; both tolerated during cutover.
    const enrichmentRaw = llmOutput.enrichment_output ?? null;
    const claudeRaw = llmOutput.claude_output ?? null;

    if (!enrichmentRaw && !claudeRaw) {
      throw new Error(`compute_scores: no enrichment_output or claude_output for trend ${trendId} — expected a FULL run`);
    }

    const tier = "FULL";

    let payload;
    if (enrichmentRaw) {
      // Phase 3 path: single agent output, fully self-contained.
      const e = { ...enrichmentRaw };
      const category = normalizeCategory(e.category);
      const subcategory = normalizeSubcategory(e.subcategory);
      const lowConfidenceFlag =
        typeof e.low_confidence_flag === "boolean"
          ? e.low_confidence_flag
          : (typeof e.category_confidence === "number" ? e.category_confidence < 0.6 : null);

      payload = {
        trend_id: trendId,
        trend_name_b2b: e.trend_name_b2b ?? null,
        trend_name_b2c: e.trend_name_b2c ?? null,
        summary_short: e.summary_short ?? null,
        summary_long: e.summary_long ?? null,
        category,
        subcategory,
        category_confidence: e.category_confidence ?? null,
        low_confidence_flag: lowConfidenceFlag,
        voice_of_customer: e.voice_of_customer ?? null,
        vibe_shift: e.vibe_shift ?? null,
        // Phase 3 social_narrative is a structured array — write to V2 column.
        // Legacy SOCIAL_NARRATIVE STRING column gets a JSON-stringified preview
        // so dashboards still rendering the old field continue to show something.
        social_narrative_v2: e.social_narrative ?? null,
        social_narrative: Array.isArray(e.social_narrative)
          ? e.social_narrative.map((n) => n.point).filter(Boolean).join(" • ").slice(0, 4000) || null
          : (typeof e.social_narrative === "string" ? e.social_narrative : null),
        cultural_drivers: e.cultural_drivers ?? null,
        seasonal_relevance: e.seasonal_relevance ?? null,
        geographic_hotspots: e.geographic_hotspots ?? null,
        social_proof: e.social_proof ?? null,
        originally_surfaced_at: e.originally_surfaced_at ?? null,
        name_candidates_considered: e.name_candidates_considered ?? null,
        name_reviewer: e.name_reviewer ?? null,
        agent_telemetry: llmOutput.agent_telemetry ?? null,
        llm_responses: { agent: stripMeta(e) },
        models_used: llmOutput.models_used ?? ["claude-sonnet-4-6"],
        llm_token_usage: llmOutput.llm_token_usage ?? null,
        llm_total_tokens: llmOutput.llm_total_tokens ?? 0,
        llm_cost_estimate: llmOutput.llm_cost_estimate ?? 0,
        source_metrics_snapshot: sourceSnapshot,
      };
    } else {
      // Legacy path (3-LLM cascade) — preserved for compat during cutover.
      const claude = { ...claudeRaw };
      claude.category = normalizeCategory(claude.category);
      claude.subcategory = normalizeSubcategory(claude.subcategory);

      const gemini = llmOutput.gemini_output
        ? { ...llmOutput.gemini_output, category: normalizeCategory(llmOutput.gemini_output.category) }
        : null;
      const grok = llmOutput.grok_output ?? null;

      payload = {
        trend_id: trendId,
        trend_name_b2b: claude.trend_name_b2b ?? null,
        trend_name_b2c: claude.trend_name_b2c ?? null,
        summary_short: claude.summary_short ?? null,
        summary_long: claude.summary_long ?? null,
        category: claude.category,
        subcategory: claude.subcategory,
        category_confidence: null,
        low_confidence_flag: null,
        voice_of_customer: grok?.voice_of_customer ?? null,
        vibe_shift: grok?.vibe_shift ?? null,
        social_narrative_v2: null,
        social_narrative: grok?.social_narrative ?? null,
        cultural_drivers: grok?.cultural_drivers ?? null,
        seasonal_relevance: grok?.seasonal_relevance ?? null,
        geographic_hotspots: grok?.geographic_hotspots ?? null,
        social_proof: null,
        originally_surfaced_at: null,
        name_candidates_considered: null,
        name_reviewer: null,
        agent_telemetry: null,
        llm_responses: {
          claude: stripMeta(claude),
          gemini: stripMeta(gemini),
          grok: stripMeta(grok),
        },
        models_used: llmOutput.models_used ?? claudeRaw._models_used ?? null,
        llm_token_usage: llmOutput.llm_token_usage ?? null,
        llm_total_tokens: llmOutput.llm_total_tokens ?? 0,
        llm_cost_estimate: llmOutput.llm_cost_estimate ?? 0,
        source_metrics_snapshot: sourceSnapshot,
      };
    }

    console.log(`Tokens: ${payload.llm_total_tokens}, cost: $${payload.llm_cost_estimate}`);
    console.log(`Tier: ${tier}, Trend: B2B="${payload.trend_name_b2b}" / B2C="${payload.trend_name_b2c}" (${payload.category}/${payload.subcategory})${payload.low_confidence_flag ? " [LOW CONF]" : ""}`);
    if (payload.name_reviewer) {
      console.log(`Reviewer: b2b=${payload.name_reviewer.score_b2b} b2c=${payload.name_reviewer.score_b2c}${payload.name_reviewer.alternate_b2c ? ` alt='${payload.name_reviewer.alternate_b2c}'` : ""}`);
    }

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
