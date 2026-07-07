// promotion_gate.mjs — the promotion candidate classifier (ADR-0004).
//
// One pure function, classifyCandidate(c) → { action, reason, flags,
// source_families }, plus the source-family helpers it composes. This is the
// gate the promotion lead runs before any LLM dispatch.
//
// =====================================================================
// IMPORTANT: This file is the SOURCE OF TRUTH. Pipedream GitHub-synced
// workflows do not bundle cross-file imports, so the deployed copy is
// INLINED in the lead step:
//   - promotion-p_xMC99jg/run_lead_agent/entry.js
// Keep the two in exact sync. This module exists so the classifier can be
// unit-tested (promotion_gate.test.mjs) without the Pipedream runtime.
// =====================================================================

// τ for the ET-rescue routing pre-filter. Starts at 0.5/0.5 (mirrors
// SOFT_THRESHOLDS) — a tunable knob. `confidence` and `specificity_score`
// become load-bearing here: they now gate the single-family bucket.
export const ET_TAU = {
  min_confidence: 0.5,
  min_specificity: 0.5,
};

export const SOFT_THRESHOLDS = {
  min_confidence: 0.5,
  min_specificity: 0.5,
};

// Group SOURCE_BREAKDOWN keys into families. Two source variants from the same
// platform (e.g. amazon_movers + amazon_trends) count as ONE family — they
// don't constitute independent corroboration. Discovery LLMs stay INDEPENDENT:
// three different model architectures hitting the same trend is genuine
// cross-corroboration, not a single-platform burst.
export function sourceFamilyOf(sourceName) {
  const s = String(sourceName || "").toLowerCase();
  if (s.startsWith("amazon")) return "amazon";
  if (s === "agent_gemini_discovery") return "agent_gemini_discovery";
  if (s === "agent_grok_discovery") return "agent_grok_discovery";
  if (s === "agent_chatgpt_discovery") return "agent_chatgpt_discovery";
  if (s.startsWith("google_trends")) return "google_trends";
  if (s === "wikimedia") return "wikimedia";
  return s; // bluesky, gdelt, tiktok, pinterest, etc. — each their own family
}

export function distinctSourceFamilies(sourceBreakdown) {
  if (!sourceBreakdown || typeof sourceBreakdown !== "object") return new Set();
  const families = new Set();
  for (const k of Object.keys(sourceBreakdown)) {
    families.add(sourceFamilyOf(k));
  }
  return families;
}

export function qualityFlags(c) {
  const flags = [];
  const conf = c.CONFIDENCE ?? 0;
  const spec = c.SPECIFICITY_SCORE ?? 0;
  if (conf < SOFT_THRESHOLDS.min_confidence) flags.push(`low_confidence:${conf}`);
  if (spec < SOFT_THRESHOLDS.min_specificity) flags.push(`low_specificity:${spec}`);
  return flags;
}

// Pure classifier — the single gate.
//   action: 'reject' | 'route_normal' | 'route_et_rescue'
//   - route_normal    : ≥2 independent source families — promote path unchanged
//   - route_et_rescue : exactly one family BUT confidence ≥ τ AND specificity ≥ τ
//   - reject          : one family AND below τ (no oracle rescue merited)
// The old `cluster_size < 2` hard branch is DROPPED (distillation enforces ≥2
// signals via schema minItems:2 + a hard guard, so it could never fire).
export function classifyCandidate(c) {
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
