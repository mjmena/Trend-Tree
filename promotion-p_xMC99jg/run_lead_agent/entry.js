// Promotion Lead — run_lead_agent
//
// Pure JavaScript dispatcher (no LLM). Reads the SQL-ordered candidate slice
// plus the pre-computed neighbor pool + signal samples, builds one dispatch
// per candidate, and fans out to the promotion subagent in parallel.
// Aggregates each subagent's decision into a bundle for the apply step.
//
// Why no LLM: lead's job is dispatch + aggregation, not judgment. Selection
// already happened in SQL. Adding an LLM in the lead would (a) burn tokens
// for no decision-quality gain, and (b) risk drift between two LLMs reasoning
// about the same candidate. The subagent (promotion-agent-p_yKCmm9r) is
// where LLM topic judgment lives.
//
// =====================================================================
// Helper code below is INLINED. Pipedream packages each step as a single
// self-contained file — cross-file imports (./lib/*, sibling .js, sibling
// .mjs) all fail at deploy time. Canonical source for the helpers lives at
// /home/marty/dev/Trend-Tree/agents/lib/*.mjs — keep edits in sync.
// =====================================================================

// ─────────────────────────────────────────────────────────────────────
// fanoutSubagents — Promise.all helper for parallel subagent HTTP calls
// (canonical source: agents/lib/subagent_client.mjs)
// ─────────────────────────────────────────────────────────────────────

async function fanoutSubagents({
  url,
  dispatches,
  concurrency = 6,
  perCallTimeoutMs = 240_000,
}) {
  if (!url || /PLACEHOLDER/i.test(url)) {
    return {
      error: `subagent endpoint not configured (got '${url}'). Set PROMOTION_SUBAGENT_URL env var or wire subagent_url prop.`,
      results: [],
    };
  }
  if (!Array.isArray(dispatches) || dispatches.length === 0) {
    return { results: [], note: "no dispatches" };
  }

  const results = new Array(dispatches.length);
  let cursor = 0;

  async function worker() {
    while (cursor < dispatches.length) {
      const idx = cursor++;
      const body = dispatches[idx];
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), perCallTimeoutMs);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await resp.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        if (!resp.ok) {
          results[idx] = {
            candidate_id: body.candidate_id,
            error: `HTTP ${resp.status}: ${text.slice(0, 240)}`,
            duration_ms: Date.now() - started,
          };
        } else {
          results[idx] = {
            candidate_id: body.candidate_id,
            duration_ms: Date.now() - started,
            ...parsed,
          };
        }
      } catch (e) {
        results[idx] = {
          candidate_id: body.candidate_id,
          error: e.name === "AbortError" ? `timeout after ${perCallTimeoutMs}ms` : e.message,
          duration_ms: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, dispatches.length) }, () => worker());
  await Promise.all(workers);

  const summary = {
    dispatched: dispatches.length,
    succeeded: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    by_decision: {},
  };
  for (const r of results) {
    const d = r?.decision || (r?.error ? "ERROR" : "UNKNOWN");
    summary.by_decision[d] = (summary.by_decision[d] || 0) + 1;
  }
  return { results, summary };
}

// ─────────────────────────────────────────────────────────────────────
// Quality-gate pre-check (no LLM dispatch on obvious LOW_QUALITY)
// Mirror the threshold in seed_prompts_promotion.sql / decision_rubric.
// ─────────────────────────────────────────────────────────────────────

const QUALITY_GATE = {
  min_cluster_size: 3,
  min_source_families: 2,
  min_confidence: 0.3,
  min_specificity: 0.3,
};

// Group SOURCE_BREAKDOWN keys into families. Two source variants from the
// same platform (e.g. amazon_movers + amazon_trends) count as ONE family —
// they don't constitute independent corroboration. A trend needs evidence
// from at least 2 distinct families to pass the gate.
function sourceFamilyOf(sourceName) {
  const s = String(sourceName || "").toLowerCase();
  if (s.startsWith("amazon")) return "amazon";
  if (s.startsWith("agent_") && s.endsWith("_discovery")) return "agent_discovery";
  if (s.startsWith("google_trends")) return "google_trends";
  if (s === "wikimedia") return "wikimedia";
  return s; // bluesky, gdelt, tiktok, pinterest, etc. — each their own family
}

function distinctSourceFamilies(sourceBreakdown) {
  if (!sourceBreakdown || typeof sourceBreakdown !== "object") return new Set();
  const families = new Set();
  for (const k of Object.keys(sourceBreakdown)) {
    families.add(sourceFamilyOf(k));
  }
  return families;
}

function failQualityGate(c) {
  const size = c.CLUSTER_SIZE ?? 0;
  const conf = c.CONFIDENCE ?? 0;
  const spec = c.SPECIFICITY_SCORE ?? 0;
  const families = distinctSourceFamilies(c.SOURCE_BREAKDOWN);
  if (size < QUALITY_GATE.min_cluster_size)
    return `cluster_size=${size}<${QUALITY_GATE.min_cluster_size}`;
  if (families.size < QUALITY_GATE.min_source_families)
    return `source_families=${families.size}<${QUALITY_GATE.min_source_families} (got [${[...families].join(",")}])`;
  if (conf < QUALITY_GATE.min_confidence)
    return `confidence=${conf}<${QUALITY_GATE.min_confidence}`;
  if (spec < QUALITY_GATE.min_specificity)
    return `specificity_score=${spec}<${QUALITY_GATE.min_specificity}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Parse the combined q_compute_vectors_and_neighbors output:
//   each row has CANDIDATE_VECTOR + (optional) NEIGHBOR_* columns.
//   Candidates with no neighbors above threshold appear with NEIGHBOR_TREND_ID NULL.
// Returns { vectorsByCandidate: Map, neighborsByCandidate: Map }
// ─────────────────────────────────────────────────────────────────────

function indexCombinedRows(combinedRows, signalSampleRows) {
  // signalSampleRows: { TREND_ID, SIGNAL_TITLE, SIGNAL_TIMESTAMP, ... }
  const samplesByTrend = new Map();
  for (const r of (signalSampleRows || [])) {
    const tid = r.TREND_ID || r.NEIGHBOR_TREND_ID;
    if (!tid) continue;
    const arr = samplesByTrend.get(tid) || [];
    arr.push({
      title: r.SIGNAL_TITLE || r.TITLE,
      domain: r.DOMAIN,
      timestamp: r.SIGNAL_TIMESTAMP || r.DETECTED_AT,
    });
    samplesByTrend.set(tid, arr);
  }

  const vectorsByCandidate = new Map();
  const neighborsByCandidate = new Map();

  for (const r of (combinedRows || [])) {
    const cid = r.CANDIDATE_ID;
    if (!cid) continue;

    if (!vectorsByCandidate.has(cid)) {
      vectorsByCandidate.set(cid, r.CANDIDATE_VECTOR);
    }

    const tid = r.NEIGHBOR_TREND_ID;
    if (!tid) continue;                                      // sentinel row for candidate with 0 neighbors

    const list = neighborsByCandidate.get(cid) || [];
    list.push({
      trend_id: tid,
      topic: r.NEIGHBOR_TOPIC,
      similarity: r.SIMILARITY,
      cluster_size: r.NEIGHBOR_CLUSTER_SIZE,
      heat: r.NEIGHBOR_HEAT,
      age_days: r.NEIGHBOR_AGE_DAYS,
      last_update: r.NEIGHBOR_LAST_UPDATE,
      summary: r.NEIGHBOR_SUMMARY,
      category: r.NEIGHBOR_CATEGORY,
      sample_signals: (samplesByTrend.get(tid) || []).slice(0, 3),
    });
    neighborsByCandidate.set(cid, list);
  }

  return { vectorsByCandidate, neighborsByCandidate };
}

// ─────────────────────────────────────────────────────────────────────
// Format candidate context for subagent (compact, readable blocks)
// ─────────────────────────────────────────────────────────────────────

function buildDispatch(candidate, candidateVector, neighborPool, ctx) {
  return {
    candidate_id: candidate.CANDIDATE_ID,
    candidate_topic: candidate.CANDIDATE_TOPIC,
    distillation_verdict: candidate.DISTILLATION_VERDICT,
    distillation_dedup_target: candidate.DISTILLATION_DEDUP_TARGET || null,
    distillation_reasoning: candidate.DISTILLATION_REASONING || "",
    cluster_size: candidate.CLUSTER_SIZE,
    source_count: candidate.SOURCE_COUNT,
    confidence: candidate.CONFIDENCE,
    specificity_score: candidate.SPECIFICITY_SCORE,
    bucket: candidate.BUCKET,
    source_breakdown: candidate.SOURCE_BREAKDOWN,
    candidate_vector: candidateVector,                // pass through to apply step on PROMOTE_NEW
    neighbor_pool: neighborPool,
    chain_id: ctx.chain_id,
    iteration: ctx.iteration,
    dry_run: ctx.dry_run,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Step entrypoint
// ─────────────────────────────────────────────────────────────────────

export default defineComponent({
  name: "Promotion: run lead agent",
  description: "Dispatch promotion subagents in parallel, aggregate decisions",
  version: "0.0.1",
  props: {
    event: { type: "any" },
    selected_candidates: { type: "any", optional: true },
    vectors_and_neighbors: { type: "any", optional: true },
    neighbor_signal_samples: { type: "any", optional: true },
    subagent_url: { type: "string", label: "Promotion subagent endpoint" },
  },
  async run({ $ }) {
    const evt = this.event || {};
    const dryRun = evt.dry_run === true;
    const started = Date.now();

    const candidates = Array.isArray(this.selected_candidates) ? this.selected_candidates : [];
    if (candidates.length === 0) {
      console.log("no candidates to promote");
      return emptyResult({ chain_id: evt.chain_id, started, skipped: "no_candidates" });
    }

    // Parse the combined vectors+neighbors output (one query, candidate_vector
    // appears once per row but the same value across rows for a given candidate)
    const { vectorsByCandidate: vecByCid, neighborsByCandidate } =
      indexCombinedRows(this.vectors_and_neighbors, this.neighbor_signal_samples);

    // Quality-gate pre-check: short-circuit obvious LOW_QUALITY rejects so we don't
    // burn LLM tokens on them. They land in the bundle as REJECT directly.
    const bundle = [];
    const dispatches = [];

    for (const c of candidates) {
      const fail = failQualityGate(c);
      if (fail) {
        bundle.push({
          candidate_id: c.CANDIDATE_ID,
          decision: "REJECT",
          decision_category: "LOW_QUALITY",
          rejection_reason: `LOW_QUALITY: ${fail}`,
          rationale: `Auto-rejected by quality gate: ${fail}.`,
          distillation_verdict: c.DISTILLATION_VERDICT,
          max_neighbor_sim: null,
          considered_neighbors: [],
          tokens: { input: 0, output: 0 },
          cost_usd: 0,
        });
        continue;
      }
      const vec = vecByCid.get(c.CANDIDATE_ID) || null;
      const neighbors = neighborsByCandidate.get(c.CANDIDATE_ID) || [];
      dispatches.push(buildDispatch(c, vec, neighbors, {
        chain_id: evt.chain_id,
        iteration: evt.iteration,
        dry_run: dryRun,
      }));
    }

    console.log(
      `lead: ${candidates.length} candidates, ${bundle.length} pre-rejected (quality gate), ${dispatches.length} to dispatch`,
    );

    if (dryRun) {
      console.log("dry_run=true: skipping subagent fanout");
      const dryBundle = dispatches.map((d) => ({
        candidate_id: d.candidate_id,
        decision: "DEFER",
        decision_category: "DRY_RUN",
        defer_reason: "dry_run",
        rationale: "dry_run: subagent skipped",
        distillation_verdict: d.distillation_verdict,
        max_neighbor_sim: (d.neighbor_pool[0] || {}).similarity || null,
        considered_neighbors: [],
        tokens: { input: 0, output: 0 },
        cost_usd: 0,
      }));
      return {
        chain_id: evt.chain_id,
        iteration: evt.iteration,
        bundle: [],                                                  // empty bundle so apply step is no-op
        bundle_json: "[]",
        bundle_count: 0,
        quality_gate_rejected: bundle.length,
        dispatched_count: 0,
        dry_run_picks: dryBundle,
        cost_usd: 0,
        run_duration_ms: Date.now() - started,
        skipped: "dry_run",
      };
    }

    // Fan out
    const fanout = await fanoutSubagents({
      url: this.subagent_url,
      dispatches,
      concurrency: 6,
      perCallTimeoutMs: 240_000,
    });

    // Collect successful subagent decisions into the bundle
    const failed = [];
    let totalCost = 0;
    for (const r of (fanout.results || [])) {
      if (r.error || !r.decision) {
        failed.push({ candidate_id: r.candidate_id, error: r.error || "no_decision" });
        continue;
      }
      bundle.push({
        candidate_id: r.candidate_id,
        decision: r.decision,
        decision_category: r.decision_category,
        target_trend_id: r.target_trend_id,
        trend_topic: r.trend_topic,
        trend_vector: r.trend_vector,                // subagent returns the candidate vector through for PROMOTE_NEW
        rejection_reason: r.rejection_reason,
        defer_until: r.defer_until,
        defer_reason: r.defer_reason,
        rationale: r.rationale,
        distillation_verdict: r.distillation_verdict,
        max_neighbor_sim: r.max_neighbor_sim,
        considered_neighbors: r.considered_neighbors || [],
        model_used: r.model_used,
        tokens: r.tokens,
        cost_usd: r.cost_usd,
      });
      totalCost += Number(r.cost_usd || 0);
    }

    const bundle_json = JSON.stringify(bundle);
    const duration_ms = Date.now() - started;

    console.log(
      `lead done: bundle=${bundle.length} failed=${failed.length} cost=$${totalCost.toFixed(4)} duration=${duration_ms}ms`,
    );
    $.export(
      "$summary",
      `${bundle.length} decisions queued, ${failed.length} subagent failures, $${totalCost.toFixed(2)}`,
    );

    return {
      chain_id: evt.chain_id,
      iteration: evt.iteration,
      bundle,
      bundle_json,
      bundle_count: bundle.length,
      quality_gate_rejected: bundle.filter((b) => b.decision_category === "LOW_QUALITY").length,
      dispatched_count: dispatches.length,
      failed_dispatches: failed,
      cost_usd: Math.round(totalCost * 10000) / 10000,
      fanout_summary: fanout.summary,
      run_duration_ms: duration_ms,
    };
  },
});

function emptyResult({ chain_id, started, skipped }) {
  return {
    chain_id,
    bundle: [],
    bundle_json: "[]",
    bundle_count: 0,
    dispatched_count: 0,
    cost_usd: 0,
    run_duration_ms: Date.now() - started,
    skipped,
  };
}
