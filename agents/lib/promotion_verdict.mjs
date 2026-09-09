// promotion_verdict.mjs — the distillation-verdict contract (CRMA-1029).
//
// One pure function, resolveDistillationVerdict(verdict, dedupTarget) →
// { verdict, isDuplicateOf, dedupTarget, promptVerdict }. It is the single
// place that decides which verdict strings the promotion subagent accepts
// and where the dedup target comes from.
//
// =====================================================================
// IMPORTANT: This file is the SOURCE OF TRUTH. Pipedream GitHub-synced
// workflows do not bundle cross-file imports, so the deployed copy is
// INLINED in the subagent step:
//   - promotion-agent-p_yKCmm9r/handle_request/entry.js
// Keep the two in exact sync. This module exists so the contract can be
// unit-tested (promotion_verdict.test.mjs) without the Pipedream runtime.
// =====================================================================
//
// Two writers, two shapes. Distillation writes the BARE "DUPLICATE_OF" into
// STG_TREND_CANDIDATES.VERDICT and carries the target in the separate
// DEDUP_OF_TREND_ID column (tool schema: enum ["REAL_TREND","DUPLICATE_OF"]).
// Older rows and the promotion system prompt use the CONCATENATED
// "DUPLICATE_OF_<trend_id>". Both must resolve: the subagent used to test
// startsWith("DUPLICATE_OF_") only, so every bare verdict threw and its
// candidate was re-dispatched forever (CRMA-1029).

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;

export const ALLOWED_VERDICTS = new Set(["REAL_TREND", "NOISE", "CATEGORY_TOO_BROAD"]);
export const DUPLICATE_OF = "DUPLICATE_OF";
export const DUPLICATE_OF_PREFIX = "DUPLICATE_OF_";
export const UNKNOWN_TARGET = "UNKNOWN";

export function sanitizeId(s) {
  if (!s) return "";
  const v = String(s);
  return SHORT_ID_OK.test(v) ? v : "";
}

// Resolve one candidate's verdict.
//   verdict     : STG_TREND_CANDIDATES.VERDICT, either shape
//   dedupTarget : body.distillation_dedup_target (from DEDUP_OF_TREND_ID)
//
// Returns:
//   verdict       — the raw trimmed string, preserved for FCT_PROMOTION_AUDIT
//   isDuplicateOf — true for either duplicate shape
//   dedupTarget   — sanitized trend id, or null when none is usable
//   promptVerdict — what the system prompt sees (see below)
//
// Throws on a missing or unrecognized verdict. It does NOT throw when a
// duplicate verdict has no usable target: throwing here is what stuck
// cand-7jl1o8r7mt8quxk5 in a retry loop, because the subagent died before
// writing PROMOTED_AT or REJECTED_AT — the exact condition the lead
// re-dispatches on. With a null target the agent still has the neighbor
// pool and decides for itself.
export function resolveDistillationVerdict(verdict, dedupTarget) {
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
