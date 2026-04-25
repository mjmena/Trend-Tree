// Distillation Subagent — run_subagent
//
// Drives the Sonnet 4.6 tool-use loop for ONE hypothesis sent by the lead.
// Bucket-aware system prompt (OVERLAP / AGENT_ONLY / LOUVAIN_ONLY) sets
// the corroboration burden:
//   - OVERLAP: validate specificity; split if too broad.
//   - AGENT_ONLY: must call ≥1 ingest tool to corroborate; if no
//     independent corroboration, return NOISE.
//   - LOUVAIN_ONLY: probable broad cluster; either accept (signals all
//     point to one specific behavior) or reject as CATEGORY_TOO_BROAD.
//
// The subagent emits accepted candidates via the propose_trend_candidate
// tool (accumulated in ctx.proposed_candidates). The respond step picks
// them up and returns them to the lead alongside the reasoning trace.

import { runAgentLoop } from "../lib/anthropic_loop.js";
import { SUBAGENT_TOOL_NAMES } from "../lib/tool_catalog.js";

const SYSTEM_PROMPT_TEMPLATE = `You are a distillation subagent for a consumer-trends pipeline. The lead orchestrator gave you ONE hypothesis to investigate. Your job: decide if it's a real, specific, actionable consumer trend.

═══════════════════════════════════════════════════════════════════════
SPECIFICITY RUBRIC — the single most important rule
═══════════════════════════════════════════════════════════════════════
A trend is a SPECIFIC consumer behavior, product use case, aesthetic, or
cultural pattern that brands could meaningfully act on within 30-180 days.
A trend has a noun phrase you can put on a slide and a verb a consumer
is doing.

GOOD examples — the bar:
  • "Cottage cheese as high-protein snack replacement (women 25-45)"
  • "Mouth taping for sleep optimization"
  • "Mob wife aesthetic — fur, gold, dramatic lip (winter 2026 revival)"
  • "Pickleball-specific apparel emerging beyond core-player niche"
  • "Fiber-maxxing — adding psyllium/chia to everything"
  • "Sleepy girl mocktail (tart cherry + magnesium)"

BAD examples — REJECT these:
  • "Wellness" / "Health & wellness" — category, not behavior
  • "AI productivity tools" — category
  • "Beauty trends" — category
  • "Sustainable fashion" — category
  • "Mental health awareness" — discourse, not behavior
  • "Politics" / "Elections" / "[Celebrity] news cycle" — news, not durable

Heuristic: if you can't describe (a) what the consumer does, (b) what they
buy or use, and (c) why it's distinct from a sibling pattern, in 2 sentences
with a concrete example — it's not specific enough. Either drill in (split
the cluster into 2-5 sub-behaviors) or drop it.

═══════════════════════════════════════════════════════════════════════
YOUR BUCKET: {{BUCKET}}
═══════════════════════════════════════════════════════════════════════
{{BUCKET_INSTRUCTIONS}}

═══════════════════════════════════════════════════════════════════════
HOW TO RESPOND
═══════════════════════════════════════════════════════════════════════
1. Use query_signals_window to inspect the supporting signals.
2. Use query_trend_neighbors to check whether this overlaps an existing trend.
3. {{INGEST_GUIDANCE}}
4. For each accepted candidate, call propose_trend_candidate ONCE with:
     verdict: "REAL_TREND" (new) or "DUPLICATE_OF" (with dedup_of_trend_id)
     topic: the noun-verb description, ≤80 chars
     supporting_signal_ids: union of original + any you fetched
     confidence: 0.0-1.0
     specificity_score: 0.0-1.0 (1.0 = noun-verb-product, 0.0 = category)
     bucket, reasoning, source_breakdown, evidence_added
5. If you reject (NOISE or CATEGORY_TOO_BROAD), do NOT call propose_trend_candidate
   — just end with a brief text explanation. Your final text block is captured.

You may call multiple propose_trend_candidate if a broad cluster splits
into 2-5 sibling behaviors.

Be opinionated. The lead is counting on you to filter.`;

const BUCKET_INSTRUCTIONS = {
  OVERLAP: `Both your raw-signal scan and the SQL Louvain clustering surfaced this hypothesis — high confidence overlap. Validate specificity. If the hypothesis is a category-level grouping ("wellness", "fitness"), either drill into 2-5 sub-behaviors and call propose_trend_candidate for each, or reject as CATEGORY_TOO_BROAD. If it's already specific, validate that supporting signals back the noun-verb framing and accept.`,
  AGENT_ONLY: `Your raw-signal scan picked this up but Louvain did not — usually because volume is too low for community detection. This is the high-value bucket: real emergent trends often start here. CRITICAL: you MUST call at least one ingest_* tool (try ingest_grok_live_search FIRST — it's fastest at ~3-5s) to corroborate. Demand at least one independent fetched signal pointing to the same noun-verb behavior. If no independent corroboration emerges → NOISE (don't propose).`,
  LOUVAIN_ONLY: `Louvain clustered this signal group but you did NOT propose it from your raw scan — usually a sign of category-level grouping that the math conflated. Inspect signal diversity: if all signals point to one specific consumer behavior, accept (your scan missed it); if they span multiple loosely-related stories under a vague label, reject as CATEGORY_TOO_BROAD.`,
};

const INGEST_GUIDANCE_BY_BUCKET = {
  OVERLAP: "Call discover_external_tools then an ingest_* tool only if the raw signals are thin or borderline.",
  AGENT_ONLY: "REQUIRED: call discover_external_tools({need: 'web'}) and then ingest_grok_live_search to corroborate. If borderline, also try ingest_search_bluesky for cultural traction or ingest_search_gdelt for hard-news evidence.",
  LOUVAIN_ONLY: "Only call ingest tools if the signal evidence is ambiguous about specificity vs. breadth.",
};

export default defineComponent({
  props: {
    anthropic: { type: "app", app: "anthropic" },
    request: { type: "any" },
    signal_rows: { type: "any", optional: true },
    neighbor_rows: { type: "any", optional: true },
  },
  async run({ $ }) {
    const req = this.request || {};
    const dryRun = req.dry_run === true;
    const bucket = req.bucket;

    // Pre-fetched pools that the agent's tools read from
    const signal_pool = (Array.isArray(this.signal_rows) ? this.signal_rows : []).map((r) => ({
      signal_id: r.SIGNAL_ID,
      source_name: r.SOURCE_NAME,
      title: r.SIGNAL_TITLE,
      body: r.SIGNAL_TEXT,
      detected_at: r.SIGNAL_TIMESTAMP,
      domain: tryParseMetadataDomain(r.METADATA),
      url: tryParseMetadataUrl(r.METADATA),
      metadata: r.METADATA,
    }));
    const trend_neighbor_pool = (Array.isArray(this.neighbor_rows) ? this.neighbor_rows : []).map((r) => ({
      trend_id: r.TREND_ID,
      trend_topic: r.TREND_TOPIC,
      total_cluster_size: r.TOTAL_CLUSTER_SIZE,
      distinct_source_count: r.DISTINCT_SOURCE_COUNT,
      velocity_direction: r.VELOCITY_DIRECTION,
      trend_heat_index: r.TREND_HEAT_INDEX,
      last_update_at: r.LAST_UPDATE_AT,
    }));

    const context = {
      signal_pool,
      louvain_pool: [], // subagents don't see Louvain — that's the lead's job
      trend_neighbor_pool,
      proposed_candidates: [],
      agent_session_id: req.agent_session_id || "",
      chain_id: req.chain_id || "",
      iteration: 1,
      endpoints: {
        ingest_search_bluesky: process.env.INGEST_SEARCH_BLUESKY_URL || "",
        ingest_search_gdelt: process.env.INGEST_SEARCH_GDELT_URL || "",
        ingest_search_google_trends: process.env.INGEST_SEARCH_GOOGLE_TRENDS_URL || "",
        ingest_grok_live_search: process.env.INGEST_GROK_LIVE_SEARCH_URL || "",
      },
    };

    const system = SYSTEM_PROMPT_TEMPLATE
      .replaceAll("{{BUCKET}}", bucket)
      .replaceAll("{{BUCKET_INSTRUCTIONS}}", BUCKET_INSTRUCTIONS[bucket] || "")
      .replaceAll("{{INGEST_GUIDANCE}}", INGEST_GUIDANCE_BY_BUCKET[bucket] || "");

    const userMsg = `HYPOTHESIS: ${req.hypothesis}

SUPPORTING SIGNAL IDS (${req.signal_ids.length}): ${req.signal_ids.join(", ")}

These signals are pre-loaded in your query_signals_window pool — call it with no filter to see them all.
Existing trend neighbors (last 30d active) are pre-loaded in your query_trend_neighbors pool.

Your verdict and any candidates are emitted via propose_trend_candidate. Be opinionated.`;

    if (dryRun) {
      console.log("dry_run=true: skipping LLM, returning empty plan");
      return {
        verdict: "DRY_RUN",
        candidates: [],
        reasoning_trace: [],
        tool_calls: [],
        cost_usd: 0,
        tokens: { input: 0, output: 0, total: 0 },
        turns: 0,
        stop_reason: "dry_run",
      };
    }

    let result;
    try {
      result = await runAgentLoop({
        anthropic: this.anthropic,
        tool_names: SUBAGENT_TOOL_NAMES.concat([
          "ingest_search_bluesky",
          "ingest_search_gdelt",
          "ingest_search_google_trends",
          "ingest_grok_live_search",
        ]),
        system,
        user_message: userMsg,
        context,
        max_iterations: 12,
        budget_usd: 1.0,
        per_call_max_tokens: 6000,
        thinking_budget_tokens: 3000,
      });
    } catch (e) {
      console.log(`subagent loop error: ${e.message}`);
      return {
        verdict: "ERROR",
        error: e.message,
        candidates: [],
        reasoning_trace: [],
        tool_calls: [],
        cost_usd: 0,
        tokens: { input: 0, output: 0, total: 0 },
        turns: 0,
        stop_reason: "error",
      };
    }

    const proposed = context.proposed_candidates || [];
    const verdict = derivedVerdict(proposed, result.final_text, bucket);

    console.log(
      `subagent done: verdict=${verdict} candidates=${proposed.length} turns=${result.turns} cost=$${result.cost_usd.toFixed(4)} stop=${result.stop_reason}`,
    );
    $.export(
      "$summary",
      `${bucket} → ${verdict} (${proposed.length} candidate${proposed.length === 1 ? "" : "s"}, ${result.turns} turns, $${result.cost_usd.toFixed(2)})`,
    );

    return {
      verdict,
      candidates: proposed,
      final_text: result.final_text,
      reasoning_trace: result.reasoning_trace,
      tool_calls: result.tool_calls.map((tc) => ({
        turn: tc.turn,
        name: tc.name,
        duration_ms: tc.duration_ms,
        input_summary: keysOnly(tc.input),
        ok: !tc.output?.error,
      })),
      cost_usd: result.cost_usd,
      tokens: result.tokens,
      turns: result.turns,
      stop_reason: result.stop_reason,
    };
  },
});

function derivedVerdict(proposed, finalText, bucket) {
  if (proposed.length === 0) {
    // No candidates proposed → infer rejection. Final text often signals which.
    const t = (finalText || "").toLowerCase();
    if (t.includes("noise")) return "NOISE";
    if (t.includes("too broad") || t.includes("category_too_broad") || t.includes("category-too-broad")) {
      return "CATEGORY_TOO_BROAD";
    }
    return bucket === "AGENT_ONLY" ? "NOISE" : "CATEGORY_TOO_BROAD";
  }
  if (proposed.length > 1) return "REAL_TREND_SPLIT";
  return proposed[0].verdict || "REAL_TREND";
}

function tryParseMetadataDomain(md) {
  try {
    const m = typeof md === "string" ? JSON.parse(md) : md;
    return m?.domain || (m?.url ? new URL(m.url).hostname : null);
  } catch { return null; }
}
function tryParseMetadataUrl(md) {
  try {
    const m = typeof md === "string" ? JSON.parse(md) : md;
    return m?.url || m?.uri || m?.embedded_url || null;
  } catch { return null; }
}

function keysOnly(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const k of Object.keys(obj).slice(0, 6)) {
    const v = obj[k];
    out[k] = Array.isArray(v) ? `[len=${v.length}]` : typeof v === "string" ? v.slice(0, 80) : v;
  }
  return out;
}
