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
// Candidate classifier (ADR-0004)
//
// One pure function, classifyCandidate(c) → { action, reason, flags }:
//   - reject            — no LLM dispatch, $0. Single source family AND below
//                         the routing threshold (low confidence or low
//                         specificity). No corroboration-oracle rescue merited.
//   - route_normal      — ≥2 independent source families. Promote path
//                         unchanged; distillation's soft quality_flags ride
//                         along for the subagent to weigh.
//   - route_et_rescue   — exactly one source family BUT confidence ≥ τ AND
//                         specificity ≥ τ. Instead of a $0 reject (old
//                         behavior), the candidate is routed into the subagent
//                         loop, where the Exploding Topics oracle gets a chance
//                         to earn the missing second source family. The soft
//                         flags ride along too.
//
// The old `cluster_size < 2` hard-reject branch is DROPPED: distillation
// enforces ≥2 supporting signals (schema minItems:2 + a hard code guard), so
// the check could never fire (ADR-0004). The two-source doctrine stays intact —
// ET is a non-signal way to CLEAR the second-family requirement, never a way to
// veto a candidate that already has two real families.
// ─────────────────────────────────────────────────────────────────────

// τ for the ET-rescue routing pre-filter. Starts at 0.5/0.5 (mirrors
// SOFT_THRESHOLDS) — a tunable knob. `confidence` and `specificity_score`
// become load-bearing here: they now gate the single-family bucket.
const ET_TAU = {
  min_confidence: 0.5,
  min_specificity: 0.5,
};

const SOFT_THRESHOLDS = {
  min_confidence: 0.5,
  min_specificity: 0.5,
};

// Group SOURCE_BREAKDOWN keys into families. Two source variants from the
// same platform (e.g. amazon_movers + amazon_trends) count as ONE family —
// they don't constitute independent corroboration.
//
// Discovery LLMs (Gemini/Grok/ChatGPT) are kept as INDEPENDENT families:
// three different model architectures hitting the same trend is genuine
// cross-corroboration, not a single platform burst.
function sourceFamilyOf(sourceName) {
  const s = String(sourceName || "").toLowerCase();
  if (s.startsWith("amazon")) return "amazon";
  if (s === "agent_gemini_discovery") return "agent_gemini_discovery";
  if (s === "agent_grok_discovery") return "agent_grok_discovery";
  if (s === "agent_chatgpt_discovery") return "agent_chatgpt_discovery";
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

function qualityFlags(c) {
  const flags = [];
  const conf = c.CONFIDENCE ?? 0;
  const spec = c.SPECIFICITY_SCORE ?? 0;
  if (conf < SOFT_THRESHOLDS.min_confidence) flags.push(`low_confidence:${conf}`);
  if (spec < SOFT_THRESHOLDS.min_specificity) flags.push(`low_specificity:${spec}`);
  return flags;
}

// Pure classifier — the single gate. Returns { action, reason, flags,
// source_families }. See the block comment above for the action semantics.
function classifyCandidate(c) {
  const families = distinctSourceFamilies(c.SOURCE_BREAKDOWN);
  const flags = qualityFlags(c);
  const familyList = [...families].join(",");

  if (families.size >= 2) {
    return {
      action: "route_normal",
      reason: `source_families=${families.size} ([${familyList}])`,
      flags,
      source_families: families.size,
    };
  }

  // Exactly one (or zero) real source family from here down.
  const conf = c.CONFIDENCE ?? 0;
  const spec = c.SPECIFICITY_SCORE ?? 0;
  if (conf >= ET_TAU.min_confidence && spec >= ET_TAU.min_specificity) {
    return {
      action: "route_et_rescue",
      reason: `single_family ([${familyList}]) conf=${conf}>=${ET_TAU.min_confidence} spec=${spec}>=${ET_TAU.min_specificity} — eligible for ET corroboration`,
      flags,
      source_families: families.size,
    };
  }
  return {
    action: "reject",
    reason: `single_family ([${familyList}]) below tau: conf=${conf} spec=${spec} (need >=${ET_TAU.min_confidence}/${ET_TAU.min_specificity})`,
    flags,
    source_families: families.size,
  };
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
// Intra-batch clustering — finds candidates in the same batch that are
// near-dupes of each other (q_compute_intra_batch_pairs returns pairs
// at or above INTRA_BATCH_THRESHOLD, see workflow.yaml). Per cluster of
// 2+, we pick a leader deterministically and emit MERGE_INTO_CANDIDATE
// for the followers. Only the leader gets sent to the subagent.
//
// Why: parallel subagents see the same neighbor pool against existing
// FCT_TRENDS but can't see each other's candidates. Without this step,
// two near-dupe candidates from different distillation chains both
// land as PROMOTE_NEW.
//
// Threshold lives in the SQL step (q_compute_intra_batch_pairs); we
// just consume what it returns. Tied separately so SQL-side filtering
// can be tuned without redeploying JS.
// ─────────────────────────────────────────────────────────────────────

function buildClusters(candidates, intraPairs) {
  // Union-find over candidate IDs that participate in any intra-batch pair.
  // Candidates with no qualifying pair end up as singleton clusters and
  // are returned alongside leaders (subagent processes them normally).
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of candidates) parent.set(c.CANDIDATE_ID, c.CANDIDATE_ID);
  for (const p of (intraPairs || [])) {
    const a = p.CANDIDATE_A_ID, b = p.CANDIDATE_B_ID;
    if (parent.has(a) && parent.has(b)) union(a, b);
  }

  // Group by root
  const groups = new Map();
  const candById = new Map(candidates.map((c) => [c.CANDIDATE_ID, c]));
  for (const c of candidates) {
    const root = find(c.CANDIDATE_ID);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(c);
  }

  // Per cluster, pick leader: max cluster_size → max confidence → earliest CREATED_AT.
  // Same tie-break order used by the backfill dedup script — keep them in sync.
  const leaders = [];
  const followers = []; // { follower, leader }
  for (const cluster of groups.values()) {
    if (cluster.length === 1) {
      leaders.push(cluster[0]);
      continue;
    }
    cluster.sort((a, b) => {
      const aSize = a.CLUSTER_SIZE ?? 0, bSize = b.CLUSTER_SIZE ?? 0;
      if (aSize !== bSize) return bSize - aSize;
      const aConf = a.CONFIDENCE ?? 0, bConf = b.CONFIDENCE ?? 0;
      if (aConf !== bConf) return bConf - aConf;
      return new Date(a.CREATED_AT || 0) - new Date(b.CREATED_AT || 0);
    });
    const leader = cluster[0];
    leaders.push(leader);
    for (const f of cluster.slice(1)) followers.push({ follower: f, leader });
  }
  return { leaders, followers };
}

function indexIntraPairs(intraPairs) {
  // Map: candidate_id → [{other_id, similarity}, ...] for telemetry/audit.
  const m = new Map();
  for (const p of (intraPairs || [])) {
    const a = p.CANDIDATE_A_ID, b = p.CANDIDATE_B_ID, s = p.SIMILARITY;
    if (!m.has(a)) m.set(a, []);
    if (!m.has(b)) m.set(b, []);
    m.get(a).push({ other_id: b, similarity: s });
    m.get(b).push({ other_id: a, similarity: s });
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────
// Format candidate context for subagent (compact, readable blocks)
// ─────────────────────────────────────────────────────────────────────

function buildDispatch(candidate, candidateVector, neighborPool, flags, ctx) {
  return {
    candidate_id: candidate.CANDIDATE_ID,
    candidate_topic: candidate.CANDIDATE_TOPIC,
    candidate_query: candidate.CANDIDATE_QUERY || null,  // atomic ET lookup key (ADR-0004)
    et_rescue: ctx.et_rescue === true,                   // single-family; ET may earn source #2
    distillation_verdict: candidate.DISTILLATION_VERDICT,
    distillation_dedup_target: candidate.DISTILLATION_DEDUP_TARGET || null,
    distillation_reasoning: candidate.DISTILLATION_REASONING || "",
    cluster_size: candidate.CLUSTER_SIZE,
    source_count: candidate.SOURCE_COUNT,
    confidence: candidate.CONFIDENCE,
    specificity_score: candidate.SPECIFICITY_SCORE,
    bucket: candidate.BUCKET,
    source_breakdown: candidate.SOURCE_BREAKDOWN,
    quality_flags: flags,                              // soft-gate concerns the LLM should weigh
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
    intra_batch_pairs: { type: "any", optional: true },
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

    // Pass 1: classify. Short-circuit `reject` candidates as LOW_QUALITY (no
    // LLM dispatch, $0) so they don't burn tokens or enter intra-batch
    // clustering. `route_normal` and `route_et_rescue` survive to the loop;
    // the classification (flags + et_rescue) is kept per-candidate for Pass 3.
    const bundle = [];
    const survivors = [];
    const classByCid = new Map();

    for (const c of candidates) {
      const cls = classifyCandidate(c);
      classByCid.set(c.CANDIDATE_ID, cls);
      if (cls.action === "reject") {
        bundle.push({
          candidate_id: c.CANDIDATE_ID,
          decision: "REJECT",
          decision_category: "LOW_QUALITY",
          rejection_reason: `GATE: ${cls.reason}`,
          rationale: `Auto-rejected by classifier: ${cls.reason}.`,
          distillation_verdict: c.DISTILLATION_VERDICT,
          max_neighbor_sim: null,
          considered_neighbors: [],
          tokens: { input: 0, output: 0 },
          cost_usd: 0,
        });
        continue;
      }
      survivors.push(c);
    }

    // Pass 2: intra-batch dedup. Cluster survivors by candidate-to-candidate
    // similarity (precomputed in q_compute_intra_batch_pairs). Followers get
    // a MERGE_INTO_CANDIDATE decision pre-baked into the bundle — the proc
    // resolves target_candidate_id → trend_id after the leader is promoted.
    const intraPairs = Array.isArray(this.intra_batch_pairs) ? this.intra_batch_pairs : [];
    const intraByCid = indexIntraPairs(intraPairs);
    const { leaders, followers } = buildClusters(survivors, intraPairs);

    for (const { follower, leader } of followers) {
      const peers = intraByCid.get(follower.CANDIDATE_ID) || [];
      const sims = peers.map((p) => p.similarity);
      const maxSim = sims.length ? Math.max(...sims) : null;
      bundle.push({
        candidate_id: follower.CANDIDATE_ID,
        decision: "MERGE_INTO_CANDIDATE",
        decision_category: "INTRA_BATCH_DUPE",
        target_candidate_id: leader.CANDIDATE_ID,
        rationale: `Intra-batch dupe of leader ${leader.CANDIDATE_ID} (max_sim=${maxSim ?? "n/a"}). Leader picked by cluster_size=${leader.CLUSTER_SIZE}, confidence=${leader.CONFIDENCE}, created_at=${leader.CREATED_AT}.`,
        distillation_verdict: follower.DISTILLATION_VERDICT,
        max_neighbor_sim: maxSim,
        considered_neighbors: peers,
        tokens: { input: 0, output: 0 },
        cost_usd: 0,
      });
    }

    // Pass 3: build subagent dispatches for leaders + singletons. Reuse the
    // Pass-1 classification for each — its flags, and whether this is an
    // ET-rescue candidate (single-family, above τ) the subagent should try to
    // corroborate via Exploding Topics.
    const dispatches = [];
    for (const c of leaders) {
      const cls = classByCid.get(c.CANDIDATE_ID) || classifyCandidate(c);
      const vec = vecByCid.get(c.CANDIDATE_ID) || null;
      const neighbors = neighborsByCandidate.get(c.CANDIDATE_ID) || [];
      dispatches.push(buildDispatch(c, vec, neighbors, cls.flags, {
        chain_id: evt.chain_id,
        iteration: evt.iteration,
        dry_run: dryRun,
        et_rescue: cls.action === "route_et_rescue",
      }));
    }

    const etRescueCount = dispatches.filter((d) => d.et_rescue).length;
    console.log(
      `lead: ${candidates.length} candidates, ` +
      `${bundle.filter((b) => b.decision_category === "LOW_QUALITY").length} classifier-rejected, ` +
      `${followers.length} intra-batch-merged, ` +
      `${dispatches.length} to dispatch (${etRescueCount} et_rescue)`,
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
        et_was_second_source: r.et_was_second_source === true,   // ADR-0004: ET earned source #2
        et_corroboration: r.et_corroboration || null,            // ET snapshot for the decision record
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
      et_rescue_dispatched: etRescueCount,
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
