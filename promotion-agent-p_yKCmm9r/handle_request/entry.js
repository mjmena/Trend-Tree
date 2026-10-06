// Promotion Subagent — handle_request
//
// Validates the lead's POST body (one promotion candidate per call) and
// pre-computes display-ready blocks for the system prompt's mustache vars.
//
// Request body (from promotion-p_xMC99jg/run_lead_agent):
//   {
//     candidate_id, candidate_topic, distillation_verdict,
//     distillation_dedup_target, distillation_reasoning,
//     cluster_size, source_count, confidence, specificity_score,
//     bucket, source_breakdown,
//     candidate_vector,                            // 1024-dim float array (passed through to apply on PROMOTE_NEW)
//     neighbor_pool: [
//       {trend_id, topic, similarity, cluster_size, heat, age_days,
//        last_update, summary, category, sample_signals: [{title,domain,timestamp}]}
//     ],
//     chain_id, iteration, dry_run
//   }

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;

function sanitizeId(s) {
  if (!s) return "";
  const v = String(s);
  return SHORT_ID_OK.test(v) ? v : "";
}

// ── Inlined from agents/lib/promotion_verdict.mjs (source of truth — keep
// in sync; Pipedream synced steps cannot import across files) ──────────
//
// Two writers, two shapes. Distillation writes the BARE "DUPLICATE_OF" and
// carries the target in the separate DEDUP_OF_TREND_ID column. Older rows
// and the promotion system prompt use "DUPLICATE_OF_<trend_id>". Both must
// resolve: this step used to test startsWith("DUPLICATE_OF_") only, so every
// bare verdict threw and its candidate was re-dispatched forever (CRMA-1029).

const ALLOWED_VERDICTS = new Set(["REAL_TREND", "NOISE", "CATEGORY_TOO_BROAD"]);
const DUPLICATE_OF = "DUPLICATE_OF";
const DUPLICATE_OF_PREFIX = "DUPLICATE_OF_";
const UNKNOWN_TARGET = "UNKNOWN";

// Throws on a missing or unrecognized verdict. It does NOT throw when a
// duplicate verdict has no usable target: throwing here is what stuck
// cand-7jl1o8r7mt8quxk5 in a retry loop, because this step died before
// writing PROMOTED_AT or REJECTED_AT — the exact condition the lead
// re-dispatches on.
function resolveDistillationVerdict(verdict, dedupTarget) {
  const raw = String(verdict || "").trim();
  if (!raw) throw new Error("missing 'distillation_verdict'");

  const isDuplicateOf = raw === DUPLICATE_OF || raw.startsWith(DUPLICATE_OF_PREFIX);
  if (!ALLOWED_VERDICTS.has(raw) && !isDuplicateOf) {
    throw new Error(`unknown distillation_verdict '${raw}'`);
  }

  // The body target is authoritative — the lead reads it straight from
  // DEDUP_OF_TREND_ID. The suffix is only a fallback for the legacy shape.
  let target = null;
  if (isDuplicateOf) {
    const suffix = raw.startsWith(DUPLICATE_OF_PREFIX) ? raw.slice(DUPLICATE_OF_PREFIX.length) : "";
    target = sanitizeId(dedupTarget) || sanitizeId(suffix) || null;
  }

  // sql/seed_prompts_promotion.sql routes the agent on four branches:
  // verdict == 'REAL_TREND', starts with 'DUPLICATE_OF_', in ('NOISE',
  // 'CATEGORY_TOO_BROAD'), and a DEFER catch-all. A bare "DUPLICATE_OF"
  // matches none of the first three, so it lands on the catch-all and burns
  // its 3 defers before the forced REJECT. Emit the canonical concatenated
  // form so the duplicate branch fires for every shape, with no
  // DIM_LLM_PROMPT migration. dedup_of_trend_id is absent from the
  // distillation tool schema's `required` list, so the target really can be
  // missing — UNKNOWN keeps that candidate routable without inventing a
  // trend id, and fmtDistillationBlock tells the agent to find the match in
  // the neighbor pool.
  const promptVerdict = isDuplicateOf ? `${DUPLICATE_OF_PREFIX}${target || UNKNOWN_TARGET}` : raw;

  return { verdict: raw, isDuplicateOf, dedupTarget: target, promptVerdict };
}

function fmtNeighborBlock(n, idx) {
  const parts = [];
  parts.push(`### NEIGHBOR ${idx + 1} — sim=${(n.similarity ?? 0).toFixed(3)}, age=${n.age_days ?? "?"}d`);
  parts.push(`- trend_id: ${n.trend_id}`);
  parts.push(`- topic: "${(n.topic || "").replace(/\n/g, " ")}"`);
  if (n.summary) parts.push(`- summary: ${String(n.summary).slice(0, 240).replace(/\n/g, " ")}`);
  if (n.category) parts.push(`- category: ${n.category}`);
  if (n.cluster_size != null) parts.push(`- cluster_size: ${n.cluster_size}`);
  if (n.heat != null) parts.push(`- heat: ${n.heat}`);
  const samples = Array.isArray(n.sample_signals) ? n.sample_signals.slice(0, 3) : [];
  if (samples.length) {
    parts.push(`- recent_signals:`);
    for (const s of samples) {
      const t = (s.title || "").slice(0, 140).replace(/\n/g, " ");
      parts.push(`    • ${t}${s.domain ? ` (${s.domain})` : ""}`);
    }
  }
  return parts.join("\n");
}

function fmtCandidateBlock(b) {
  const parts = [];
  parts.push(`- candidate_id: ${b.candidate_id}`);
  parts.push(`- candidate_topic: "${(b.candidate_topic || "").replace(/\n/g, " ")}"`);
  parts.push(`- cluster_size: ${b.cluster_size}, source_count: ${b.source_count}`);
  parts.push(`- confidence: ${b.confidence}, specificity_score: ${b.specificity_score}`);
  parts.push(`- bucket: ${b.bucket || "?"}`);
  if (b.source_breakdown && typeof b.source_breakdown === "object") {
    const breakdown = Object.entries(b.source_breakdown)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    parts.push(`- source_breakdown: ${breakdown}`);
  }
  if (Array.isArray(b.quality_flags) && b.quality_flags.length > 0) {
    parts.push(`- quality_flags: [${b.quality_flags.join(", ")}]  ⚠ apply extra skepticism — defer if uncertain`);
  }
  return parts.join("\n");
}

function fmtDistillationBlock(b, resolved) {
  const parts = [];
  parts.push(`- verdict: ${resolved?.promptVerdict || b.distillation_verdict}`);
  if (b.distillation_dedup_target) {
    parts.push(`- suggested_dedup_target: ${b.distillation_dedup_target}`);
  } else if (resolved?.isDuplicateOf) {
    // Distillation called this a duplicate but never named the target, which
    // its tool schema permits. Say so plainly — otherwise the agent reads the
    // UNKNOWN sentinel in the verdict as a trend id and hunts for a row that
    // does not exist.
    parts.push(
      `- suggested_dedup_target: NONE SUPPLIED — distillation flagged this as a duplicate but did not name the trend. Find the matching trend in the neighbor pool yourself and merge into it; if no neighbor is the same topic, override to PROMOTE_NEW.`,
    );
  }
  const reason = (b.distillation_reasoning || "").trim();
  if (reason) parts.push(`- reasoning: ${reason.slice(0, 1200).replace(/\n/g, " ")}`);
  return parts.join("\n");
}

export default defineComponent({
  name: "Promotion Subagent: handle request",
  description: "Validate request body and pre-compute prompt blocks",
  version: "0.0.1",
  props: {
    trigger_event: { type: "any" },
  },
  async run() {
    const body = this.trigger_event?.body || {};

    const candidate_id = sanitizeId(body.candidate_id);
    if (!candidate_id) throw new Error("missing/invalid 'candidate_id' in request body");

    const candidate_topic = String(body.candidate_topic || "").trim();
    if (!candidate_topic) throw new Error("missing 'candidate_topic'");

    // The raw verdict is kept for FCT_PROMOTION_AUDIT; prompt_verdict is the
    // shape the system prompt routes on.
    const resolved_verdict = resolveDistillationVerdict(
      body.distillation_verdict,
      body.distillation_dedup_target,
    );
    const distillation_verdict = resolved_verdict.verdict;
    const distillation_dedup_target = resolved_verdict.dedupTarget;

    const neighbor_pool = Array.isArray(body.neighbor_pool) ? body.neighbor_pool.slice(0, 8) : [];
    // Filter out malformed neighbors but keep all valid ones
    const valid_neighbors = neighbor_pool.filter((n) => n && n.trend_id);

    const candidate_vector = Array.isArray(body.candidate_vector)
      ? body.candidate_vector
      : null;

    const chain_id = sanitizeId(body.chain_id) || "chain-unknown";
    const iteration = Math.max(1, Number(body.iteration) || 1);
    const dry_run = body.dry_run === true || body.dry_run === "true";

    // ET corroboration routing (ADR-0004). et_rescue = the lead classified this
    // as a single-source-family candidate above τ; the agent should look
    // candidate_query up in Exploding Topics and, if ET independently confirms
    // the concept with real volume, count ET as the missing second source family.
    const et_rescue = body.et_rescue === true || body.et_rescue === "true";
    const candidate_query = String(body.candidate_query || "").trim() || null;

    const candidate = {
      candidate_id,
      candidate_topic,
      candidate_query,
      et_rescue,
      distillation_verdict,
      distillation_dedup_target,
      distillation_reasoning: String(body.distillation_reasoning || ""),
      cluster_size: Number(body.cluster_size || 0),
      source_count: Number(body.source_count || 0),
      confidence: Number(body.confidence || 0),
      specificity_score: Number(body.specificity_score || 0),
      bucket: body.bucket || null,
      source_breakdown: body.source_breakdown || {},
      quality_flags: Array.isArray(body.quality_flags) ? body.quality_flags : [],
      candidate_vector,
    };

    const system_vars = {
      candidate_block: fmtCandidateBlock(candidate),
      distillation_recommendation_block: fmtDistillationBlock(candidate, resolved_verdict),
      neighbor_count: valid_neighbors.length,
      neighbor_blocks: valid_neighbors.map((n, i) => fmtNeighborBlock(n, i)).join("\n\n") || "(no surfaced neighbors above sim 0.50)",
      et_rescue_block: et_rescue
        ? `⚑ ET-RESCUE CANDIDATE. This candidate has only ONE independent source family, so it fails the two-source doctrine on signals alone. Its confidence/specificity cleared the routing threshold, so you MUST call verify_exploding_topics with the candidate_query ("${candidate_query || candidate_topic}") before deciding. If ET independently recognizes the SAME concept (your judgment — /database-search is fuzzy) AND it has meaningful absolute_volume, count ET as the second source family and PROMOTE_NEW; set et_was_second_source=true. If ET misses, returns a different concept, or the volume is trivial, this candidate stays single-family — REJECT it as you would today.`
        : "",
    };

    console.log(
      `subagent: candidate=${candidate_id} verdict=${distillation_verdict} neighbors=${valid_neighbors.length} chain=${chain_id} dry_run=${dry_run}`,
    );

    return {
      candidate,
      neighbor_pool: valid_neighbors,
      system_vars,
      chain_id,
      iteration,
      dry_run,
    };
  },
});
