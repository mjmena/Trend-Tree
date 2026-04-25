// Distillation Lead — run_lead_agent
//
// Orchestrator agent. Sees:
//   - The raw signal window since the cursor (q_signals_window)
//   - The SQL clustering's view of the same window (q_louvain_candidates)
//   - Top active trends for dedup (q_neighbors)
//
// Produces a 3-way bucketing (OVERLAP / AGENT_ONLY / LOUVAIN_ONLY),
// dispatches subagents in parallel via the dispatch_subagent tool (HTTP
// fanout to distillation-subagent-p_jmCjj3J), consolidates verdicts,
// and emits accepted candidates via propose_trend_candidate.
//
// The downstream commit_candidates step bulk-inserts candidates_json into
// STG_TREND_CANDIDATES_AGENT (Phase 1 shadow table — does NOT replace the
// live STG_TREND_CANDIDATES yet).

import { runAgentLoop } from "./lib/anthropic_loop.js";
import { LEAD_TOOL_NAMES } from "./lib/tool_catalog.js";

const SYSTEM_PROMPT = `You are the lead orchestrator of a consumer-trends distillation pipeline. Every 1-2 hours you wake up to the firehose: thousands of fresh signals from headlines, Bluesky, GDELT, Google Trends, and more. Your job is to distill SPECIFIC, ACTIONABLE consumer trends from this firehose. You have a SQL Louvain clustering's output as one input among many — you can override it.

═══════════════════════════════════════════════════════════════════════
SPECIFICITY RUBRIC — the single most important rule
═══════════════════════════════════════════════════════════════════════
A trend is a SPECIFIC consumer behavior, product use case, aesthetic, or
cultural pattern that brands could meaningfully act on within 30-180 days.
A trend has a noun phrase you can put on a slide and a verb a consumer is doing.

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

═══════════════════════════════════════════════════════════════════════
YOUR PROCESS
═══════════════════════════════════════════════════════════════════════
1. CALL query_signals_window with no filter (or a broad sample) to inspect the
   recent signals. Look for noun-verb consumer behaviors that recur or that 3+
   independent signals point to. Form 20-80 candidate hypotheses.

2. CALL query_louvain_candidates to see what the SQL clustering thinks. Each
   cluster has a centroid_topic + signal_ids + signal_count + top_domains.

3. RECONCILE into three buckets:
   - OVERLAP: Your hypothesis maps onto a Louvain cluster. Mark for validation.
   - AGENT_ONLY: Your hypothesis has no Louvain match. These are the
     emergent-signal candidates Louvain missed (your scan caught a pattern
     with too little volume for community detection).
   - LOUVAIN_ONLY: A Louvain cluster you didn't independently propose.
     Usually these are category-level conflations the math made.

4. DISPATCH SUBAGENTS in parallel via dispatch_subagent. One dispatch per
   hypothesis, with the bucket label and supporting signal_ids. Subagents
   gather extra evidence (ingest tools), validate specificity, and return
   verdicts + refined candidates. Concurrency cap is 10 in flight.

5. CONSOLIDATE results. Subagents have already proposed candidates into the
   shared accumulator via propose_trend_candidate. You can also propose
   directly if you want to add or override (e.g. when subagents return
   conflicting verdicts you want to settle).

6. END your turn with a brief text block summarizing: signals seen, hypotheses
   formed, dispatches sent, accepted candidates by bucket.

═══════════════════════════════════════════════════════════════════════
GUARDRAILS
═══════════════════════════════════════════════════════════════════════
- Don't propose categories. The dashboard already has tags for that.
- Don't propose duplicates of existing trends — call query_trend_neighbors first.
- Be opinionated about specificity. Reject more than you accept.
- Phase 1 EXPLICITLY values recall on weak emergent signals — when an
  AGENT_ONLY hypothesis has 3-5 independent specific signals, dispatch a
  subagent to corroborate rather than dismiss it.
- Budget: keep total LLM spend under $5/run. Subagents cost ~$0.20 each;
  prefer 30-60 dispatches max.`;

export default defineComponent({
  props: {
    anthropic: { type: "app", app: "anthropic" },
    event: { type: "any" },
    cursor_rows: { type: "any", optional: true },
    signal_rows: { type: "any", optional: true },
    louvain_rows: { type: "any", optional: true },
    neighbor_rows: { type: "any", optional: true },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const dryRun = evt.dry_run === true;
    const started = Date.now();

    // Build the agent's pre-fetched pools
    const signal_pool = (Array.isArray(this.signal_rows) ? this.signal_rows : []).map((r) => ({
      signal_id: r.SIGNAL_ID,
      source_name: r.SOURCE_NAME,
      title: r.SIGNAL_TITLE,
      body: r.SIGNAL_TEXT,
      detected_at: r.SIGNAL_TIMESTAMP,
      domain: tryParseMetadataDomain(r.METADATA),
      url: tryParseMetadataUrl(r.METADATA),
    }));
    const louvain_pool = (Array.isArray(this.louvain_rows) ? this.louvain_rows : []).map((r) => ({
      cluster_id: r.CLUSTER_ID,
      centroid_topic: r.CENTROID_TOPIC,
      signal_count: r.SIGNAL_COUNT,
      distinct_source_count: r.DISTINCT_SOURCE_COUNT,
      velocity_direction: r.VELOCITY_DIRECTION,
      heat_index: r.TREND_HEAT_INDEX,
      detected_at: r.DETECTED_AT,
      signal_ids: r.SIGNAL_IDS || [],
      top_domains: r.TOP_DOMAINS || [],
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

    // Track the highest signal timestamp we observed so we can advance the cursor
    const max_signal_ts = signal_pool.reduce((acc, s) => {
      const t = s.detected_at;
      return !acc || (t && t > acc) ? t : acc;
    }, null);

    const context = {
      signal_pool,
      louvain_pool,
      trend_neighbor_pool,
      proposed_candidates: [],
      agent_session_id: evt.agent_session_id,
      chain_id: evt.chain_id,
      iteration: evt.iteration,
      endpoints: {
        distillation_subagent: process.env.DISTILLATION_SUBAGENT_URL || "",
        ingest_search_bluesky: process.env.INGEST_SEARCH_BLUESKY_URL || "",
        ingest_search_gdelt: process.env.INGEST_SEARCH_GDELT_URL || "",
        ingest_search_google_trends: process.env.INGEST_SEARCH_GOOGLE_TRENDS_URL || "",
        ingest_grok_live_search: process.env.INGEST_GROK_LIVE_SEARCH_URL || "",
      },
    };

    const userMsg = `Window starts at ${this.cursor_rows?.[0]?.WINDOW_START_TS || "(none)"}.
Pre-fetched pools available to your tools:
  - signal_pool: ${signal_pool.length} raw signals from STG_EXTERNAL_SIGNALS (agent-fetched evidence excluded)
  - louvain_pool: ${louvain_pool.length} clusters from FCT_TREND_METRICS in this window
  - trend_neighbor_pool: ${trend_neighbor_pool.length} active trends (last 30d) for dedup

Subagent endpoint: ${context.endpoints.distillation_subagent ? "configured" : "NOT CONFIGURED — dispatch_subagent will return errors"}

Begin your scan. Be opinionated about specificity.`;

    if (dryRun) {
      console.log("dry_run=true: skipping LLM");
      return emptyResult({ chain_id: evt.chain_id, max_signal_ts, started, signals_seen: signal_pool.length, skipped: "dry_run" });
    }

    let result;
    try {
      result = await runAgentLoop({
        anthropic: this.anthropic,
        tool_names: LEAD_TOOL_NAMES,
        system: SYSTEM_PROMPT,
        user_message: userMsg,
        context,
        max_iterations: 15,
        budget_usd: evt.budget_remaining_usd ?? evt.budget_usd ?? 5.0,
        per_call_max_tokens: evt.per_call_max_tokens || 8192,
        thinking_budget_tokens: evt.thinking_budget_tokens || 5000,
      });
    } catch (e) {
      console.log(`lead loop error: ${e.message}`);
      return emptyResult({
        chain_id: evt.chain_id,
        max_signal_ts,
        started,
        signals_seen: signal_pool.length,
        skipped: "error",
        error: e.message,
      });
    }

    // Cap reasoning_trace size per candidate so the JSON blob doesn't blow
    // out the registry action's parameter binding limit.
    const candidates = (context.proposed_candidates || []).map((c) => ({
      ...c,
      reasoning_trace: capTrace(c.reasoning_trace, 30_000),
    }));
    const candidates_json = JSON.stringify(candidates);

    const duration_ms = Date.now() - started;
    console.log(
      `lead done: candidates=${candidates.length} turns=${result.turns} cost=$${result.cost_usd.toFixed(4)} stop=${result.stop_reason} duration=${duration_ms}ms`,
    );
    $.export(
      "$summary",
      `${candidates.length} candidates, ${result.turns} turns, $${result.cost_usd.toFixed(2)}, ${Math.round(duration_ms / 1000)}s`,
    );

    return {
      chain_id: evt.chain_id,
      agent_session_id: evt.agent_session_id,
      iteration: evt.iteration,
      candidates,
      candidates_json,
      candidates_count: candidates.length,
      signals_seen: signal_pool.length,
      louvain_seen: louvain_pool.length,
      max_signal_ts,
      run_duration_ms: duration_ms,
      cost_usd: result.cost_usd,
      tokens: result.tokens,
      turns: result.turns,
      stop_reason: result.stop_reason,
      final_text: result.final_text,
      reasoning_trace_size: result.reasoning_trace.length,
      tool_call_count: result.tool_calls.length,
    };
  },
});

function emptyResult({ chain_id, max_signal_ts, started, signals_seen, skipped, error }) {
  return {
    chain_id,
    candidates: [],
    candidates_json: "[]",
    candidates_count: 0,
    signals_seen: signals_seen || 0,
    louvain_seen: 0,
    max_signal_ts,
    run_duration_ms: Date.now() - started,
    cost_usd: 0,
    tokens: { input: 0, output: 0, total: 0 },
    turns: 0,
    stop_reason: skipped,
    error: error || null,
  };
}

function capTrace(trace, maxBytes) {
  if (!Array.isArray(trace)) return trace;
  const json = JSON.stringify(trace);
  if (json.length <= maxBytes) return trace;
  // Drop earliest thinking blocks first; keep tool_use/tool_result for audit
  const compact = trace.map((entry) =>
    entry.kind === "thinking"
      ? { turn: entry.turn, kind: "thinking", text: (entry.text || "").slice(0, 400) + "…" }
      : entry,
  );
  const compactJson = JSON.stringify(compact);
  if (compactJson.length <= maxBytes) return compact;
  // Last resort: truncate the array
  return compact.slice(-Math.floor(maxBytes / 200));
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
