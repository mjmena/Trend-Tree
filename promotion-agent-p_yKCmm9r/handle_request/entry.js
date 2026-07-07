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
const ALLOWED_VERDICTS = new Set(["REAL_TREND", "NOISE", "CATEGORY_TOO_BROAD"]);
const DUPLICATE_OF_PREFIX = "DUPLICATE_OF_";

function sanitizeId(s) {
  if (!s) return "";
  const v = String(s);
  return SHORT_ID_OK.test(v) ? v : "";
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

function fmtDistillationBlock(b) {
  const parts = [];
  parts.push(`- verdict: ${b.distillation_verdict}`);
  if (b.distillation_dedup_target) {
    parts.push(`- suggested_dedup_target: ${b.distillation_dedup_target}`);
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

    const distillation_verdict = String(body.distillation_verdict || "").trim();
    if (!distillation_verdict) throw new Error("missing 'distillation_verdict'");
    const isDuplicateOf = distillation_verdict.startsWith(DUPLICATE_OF_PREFIX);
    if (!ALLOWED_VERDICTS.has(distillation_verdict) && !isDuplicateOf) {
      throw new Error(`unknown distillation_verdict '${distillation_verdict}'`);
    }

    const distillation_dedup_target = isDuplicateOf
      ? sanitizeId(body.distillation_dedup_target || distillation_verdict.slice(DUPLICATE_OF_PREFIX.length))
      : null;

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
      distillation_recommendation_block: fmtDistillationBlock(candidate),
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
