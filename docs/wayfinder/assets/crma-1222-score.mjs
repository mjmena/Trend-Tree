// Scores crma-1222-results.jsonl (Request A) merged with
// crma-1222-oracle-results.jsonl (Request B, the ET oracle -- CRMA-1255)
// against CRMA-1231's four ground-truth rules, producing
// crma-1222-scorecard.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFamilyOfBuggy, familyDelta } from "./crma-1222-family.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(HERE, "crma-1222-cases.json"), "utf8"));
const terminal = JSON.parse(readFileSync(join(HERE, "crma-1222-terminal-decisions.json"), "utf8"));
const results = readFileSync(join(HERE, "crma-1222-results.jsonl"), "utf8")
  .trim().split("\n").filter(Boolean).map(JSON.parse);

const ORACLE_FILE = join(HERE, "crma-1222-oracle-results.jsonl");
const oracleByAuditId = new Map();
if (existsSync(ORACLE_FILE)) {
  for (const line of readFileSync(ORACLE_FILE, "utf8").trim().split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    oracleByAuditId.set(o.audit_id, o);
  }
}
console.error(`oracle results loaded: ${oracleByAuditId.size}`);

// Merge Request B's decision into any Request-A composed object that was
// left unscored (decision_rule "oracle_decided", decision null). Applies
// identically to both Noul arms -- the oracle path never reads a recurrence
// noul, so composed_criteria and composed_bare agree here by construction.
function mergeOracle(r) {
  const o = oracleByAuditId.get(r.audit_id);
  if (!o || o.error) return; // script-level failure (not an ET miss) -- leave unscored
  for (const composed of [r.composed_criteria, r.composed_bare]) {
    if (composed?.decision_rule === "oracle_decided" && composed.decision == null) {
      composed.decision = o.decision;
      composed.decision_category = o.decision_category;
      composed.oracle = {
        keyword: o.oracle_keyword, keyword_source: o.oracle_keyword_source,
        et_matched: o.et_matched, et_total: o.et_total, et_error: o.et_error ?? null,
        survivors: o.survivors, jev_called: o.jev_called,
      };
    }
  }
}
for (const r of results) if (!r.error) mergeOracle(r);

const terminalByCid = new Map(terminal.map((r) => [r.CANDIDATE_ID, r]));

const S01 = "S01_turn_exhausted", S02 = "S02_defer_needs_signal";

const buckets = {
  rule1_tombstone: [],        // scored against eventual REJECT
  rule2_needs_signal: [],     // labeled cohort, not scored pass/fail
  rule3_level0: [],           // hand-inspect only
  rule4_family_mismatch: [],  // scored against re-derived family count
  et_unavailable: [],         // needs_corroboration, still unscored (no oracle result merged)
  source_data_gap: [],        // empty candidate.sources/signals in STG_TREND_CANDIDATES today
  normal: [],                 // ordinary adopt-bar population
};

for (const r of results) {
  if (r.error) { buckets.normal.push({ ...r, note: "API_ERROR" }); continue; }
  const c = cases[r.audit_id];
  const composed = r.composed_criteria;

  // Rule 3 takes priority: a not_a_topic verdict is hand-inspect-only, UNLESS
  // it's really a source-data-gap artifact (empty state -> trivially not_a_topic).
  if (r.source_data_empty) {
    buckets.source_data_gap.push({ audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum, composed });
    continue;
  }
  if (composed.eq_verdict === "not_a_topic") {
    buckets.rule3_level0.push({ audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum, ledger_decision: c.ledger.DECISION, composed });
    continue;
  }

  if (r.stratum === S01) {
    const term = terminalByCid.get(r.candidate_id);
    buckets.rule1_tombstone.push({
      audit_id: r.audit_id, candidate_id: r.candidate_id,
      eventual: term?.DECISION ?? null, composed_decision: composed.decision,
      match: composed.decision != null && term?.DECISION === composed.decision,
      unscored: composed.decision == null,
      composed,
    });
    continue;
  }
  if (r.stratum === S02) {
    const term = terminalByCid.get(r.candidate_id);
    buckets.rule2_needs_signal.push({
      audit_id: r.audit_id, candidate_id: r.candidate_id,
      eventual: term?.DECISION ?? null, composed_decision: composed.decision,
      agrees_with_eventual: composed.decision != null && term?.DECISION === composed.decision,
      unscored: composed.decision == null,
      composed,
    });
    continue;
  }

  // Rule 4: same-vendor family re-derivation.
  const delta = familyDelta(c.source_breakdown_raw);
  const ledgerImpliedSingleFamily = delta.buggy_count < 2; // what the OLD gate would have seen
  if (delta.disagrees && !ledgerImpliedSingleFamily) {
    // buggy said >=2 (went to subagent normally), fixed says 1 (same vendor twice) --
    // exactly CRMA-1220's "43 promoted on same-vendor corroboration" class.
    buckets.rule4_family_mismatch.push({
      audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum,
      ledger_decision: c.ledger.DECISION, composed, delta,
      caught_defect: composed.eq_verdict !== "stands_alone", // did Jev's evidence_quality NOT treat it as independently standing?
    });
    continue;
  }

  if (composed.eq_verdict === "needs_corroboration" && composed.decision == null) {
    buckets.et_unavailable.push({ audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum, ledger_decision: c.ledger.DECISION, composed });
    continue;
  }

  buckets.normal.push({
    audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum,
    ledger_decision: c.ledger.DECISION, ledger_target: c.ledger.PROMOTED_TO || null,
    composed_decision: composed.decision, composed_target: composed.target_trend_id,
    decision_match: composed.decision === c.ledger.DECISION,
    target_match: composed.decision !== "MERGE_INTO_EXISTING" || composed.target_trend_id === c.ledger.PROMOTED_TO,
    eq_confidence: composed.eq_verdict,
    composed,
  });
}

// ---- Fit test 4: confidence separation ----
// "known-easy" = S06_ge080_all (unambiguous high-sim) + S11_none (no pool).
// "known-ambiguous" = S07_contested_not_merge + S08_contested_merge (the 0.70-0.80 band).
function confidenceStats(rows) {
  const eqConf = rows.map((r) => r.answers?.evidence_quality?.confidence).filter((x) => x != null);
  const topPairConf = rows
    .map((r) => {
      const nrs = r.composed_criteria?.neighbor_results;
      if (!nrs || !nrs.length) return null;
      return Math.max(...nrs.map((n) => n.psConfidence ?? 0));
    })
    .filter((x) => x != null);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return { n: rows.length, mean_eq_confidence: mean(eqConf), mean_top_pair_confidence: mean(topPairConf) };
}
const easyRows = results.filter((r) => !r.error && ["S06_ge080_all", "S11_none_PROMOTE_NEW", "S11_none_REJECT"].includes(r.stratum));
const ambigRows = results.filter((r) => !r.error && ["S07_contested_not_merge", "S08_contested_merge"].includes(r.stratum));
const fitTest4 = { easy: confidenceStats(easyRows), ambiguous: confidenceStats(ambigRows) };

// ---- Near-synonym case ----
const cottage1 = results.find((r) => r.candidate_id === "cand-gyzc2tofmteds12q");
const cottage2 = results.find((r) => r.candidate_id === "cand-kbzkbavbmtdo1pum");

// ---- Criteria vs bare arm comparison for the 3 nouls ----
function armDelta() {
  const deltas = { is_same_recurring_topic: [], recurrence_deserves_own_row: [], is_narrower_instance: [] };
  for (const r of results) {
    if (r.error || !r.answers) continue;
    for (const key of Object.keys(r.answers)) {
      const m = key.match(/^(is_same_recurring_topic|recurrence_deserves_own_row|is_narrower_instance)__n(\d+)$/);
      if (!m) continue;
      const [, base, idx] = m;
      const bareKey = `${base}__n${idx}__bare`;
      if (!(bareKey in r.answers)) continue;
      deltas[base].push({
        audit_id: r.audit_id, n: Number(idx),
        criteria: r.answers[key].noul, bare: r.answers[bareKey].noul,
        abs_delta: Math.abs(r.answers[key].noul - r.answers[bareKey].noul),
      });
    }
  }
  const summary = {};
  for (const [k, v] of Object.entries(deltas)) {
    const abs = v.map((d) => d.abs_delta);
    summary[k] = {
      n_pairs: v.length,
      mean_abs_delta: abs.length ? abs.reduce((s, x) => s + x, 0) / abs.length : null,
      max_abs_delta: abs.length ? Math.max(...abs) : null,
      big_flips: v.filter((d) => d.abs_delta >= 0.3).length, // crosses a provisional cut band
    };
  }
  return summary;
}

// ---- Recurrence-override firing rate ----
const recurrenceOverrides = results
  .filter((r) => !r.error && r.composed_criteria?.decision_rule === "recurrence_blocked_merge")
  .map((r) => ({ audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum, blocked_neighbor: r.composed_criteria.blocked_neighbor }));

// ---- Cost / latency ----
const okResults = results.filter((r) => !r.error);
const totalCost = okResults.reduce((s, r) => s + (r.cost_usd || 0), 0);
const meanCost = totalCost / (okResults.length || 1);
const meanDuration = okResults.reduce((s, r) => s + (r.duration_ms || 0), 0) / (okResults.length || 1);

// ---- Adopt-bar scorecard on the "normal" population ----
const normalScored = buckets.normal.filter((r) => !r.note);
const decisionMatches = normalScored.filter((r) => r.decision_match && r.target_match).length;

const scorecard = {
  total_cases: results.length,
  errors: results.filter((r) => r.error).length,
  bucket_counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  adopt_bar: {
    scored_population: normalScored.length,
    matches: decisionMatches,
    match_rate: normalScored.length ? decisionMatches / normalScored.length : null,
    mismatches: normalScored.filter((r) => !(r.decision_match && r.target_match)),
  },
  rule1_tombstone: {
    n: buckets.rule1_tombstone.length,
    matches: buckets.rule1_tombstone.filter((r) => r.match).length,
    unscored_et: buckets.rule1_tombstone.filter((r) => r.unscored).length,
    detail: buckets.rule1_tombstone,
  },
  rule2_needs_signal_cohort: {
    n: buckets.rule2_needs_signal.length,
    agrees_with_eventual: buckets.rule2_needs_signal.filter((r) => r.agrees_with_eventual).length,
    unscored_et: buckets.rule2_needs_signal.filter((r) => r.unscored).length,
    detail: buckets.rule2_needs_signal,
  },
  rule3_level0_hand_inspect: buckets.rule3_level0,
  rule4_family_mismatch: buckets.rule4_family_mismatch,
  et_unavailable_count: buckets.et_unavailable.length,
  source_data_gap_count: buckets.source_data_gap.length,
  fit_test_4_confidence_separation: fitTest4,
  near_synonym_case: {
    "cottage_cheese_A (S06_ge080_all)": cottage1 ? { composed: cottage1.composed_criteria, eq: cottage1.answers?.evidence_quality } : null,
    "cottage_cheese_B (S07a_et_earned_2nd)": cottage2 ? { composed: cottage2.composed_criteria, eq: cottage2.answers?.evidence_quality } : null,
  },
  arm_delta_criteria_vs_bare: armDelta(),
  recurrence_overrides_fired: recurrenceOverrides,
  cost_and_latency: {
    total_cost_usd: totalCost,
    mean_cost_usd_per_candidate: meanCost,
    mean_duration_ms: meanDuration,
    max_cost_usd: Math.max(...okResults.map((r) => r.cost_usd || 0)),
    min_cost_usd: Math.min(...okResults.map((r) => r.cost_usd || 0)),
  },
};

writeFileSync(join(HERE, "crma-1222-scorecard.json"), JSON.stringify(scorecard, null, 2));
console.log(JSON.stringify({
  total: scorecard.total_cases,
  buckets: scorecard.bucket_counts,
  adopt_bar_match_rate: scorecard.adopt_bar.match_rate,
  adopt_bar_scored: scorecard.adopt_bar.scored_population,
  rule1_matches: `${scorecard.rule1_tombstone.matches}/${scorecard.rule1_tombstone.n}`,
  rule2_agrees: `${scorecard.rule2_needs_signal_cohort.agrees_with_eventual}/${scorecard.rule2_needs_signal_cohort.n}`,
  rule3_level0_count: scorecard.rule3_level0_hand_inspect.length,
  rule4_family_mismatch_count: scorecard.rule4_family_mismatch.length,
  fit_test_4: scorecard.fit_test_4_confidence_separation,
  total_cost_usd: scorecard.cost_and_latency.total_cost_usd,
  mean_cost_usd: scorecard.cost_and_latency.mean_cost_usd_per_candidate,
  mean_duration_ms: scorecard.cost_and_latency.mean_duration_ms,
  recurrence_overrides: scorecard.recurrence_overrides_fired.length,
}, null, 2));
