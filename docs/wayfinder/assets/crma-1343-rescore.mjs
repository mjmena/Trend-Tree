// CRMA-1343: re-score the adopt bar under the settled rules, with no new
// vendor calls. Re-composes every case in crma-1222-results.jsonl from its
// stored Request A answers under CRMA-1223's rules, merges Request B from
// CRMA-1332's signal_frequency arm, and scores the result through the
// unchanged crma-1222-score.mjs (CRMA-1231's four ground-truth rules).
// Writes crma-1343-scorecard.json.
//
// CRMA-1223's changes to crma-1222-run.mjs's compose():
//   1. pair_sameness: when `unsettled` is not the top level, take the heavier
//      of P(same_thing) and P(different_thing). evidence_quality keeps rounding.
//   2. No confidence is routed on.
//   3. Merge target = highest P(same_thing). Two or more same_thing
//      neighbours merge into the OLDER trend (and raise the flag).
//   4. Both recurrence Nouls cut at 0.5; the override needs both.
//
// Run: node crma-1343-rescore.mjs  (TREND_CREATED_FILE optional, see below)

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { familyDelta } from "./crma-1222-family.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const readJsonl = (f) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const cases = JSON.parse(readFileSync(join(HERE, "crma-1222-cases.json"), "utf8"));
const results = readJsonl(join(HERE, "crma-1222-results.jsonl"));
const ORACLE_FILE = join(HERE, "crma-1332-oracle-signal_frequency.jsonl");
const oracleIds = new Set(readJsonl(ORACLE_FILE).filter((o) => !o.error).map((o) => o.audit_id));

// FCT_TRENDS.CREATED_AT for every neighbour that ties as same_thing with
// another -- the "merge into the older" rule. Without it the script falls
// back to the P(same_thing) ranking and reports which cases that affects.
const TREND_CREATED_FILE = join(HERE, "crma-1343-trend-created.json");
const trendCreated = existsSync(TREND_CREATED_FILE) ? JSON.parse(readFileSync(TREND_CREATED_FILE, "utf8")) : {};

const EQ_LABELS = ["not_a_topic", "needs_corroboration", "stands_alone"];
const PS_LABELS = ["different_thing", "unsettled", "same_thing"];
const NOUL_CUT = 0.5, FLAG_COUNT = 2;

const roundScore = (score, labels) => labels[Math.max(0, Math.min(labels.length - 1, Math.round(score)))];

const tally = { multi_same_thing: [], older_unknown: [] };

function pairVerdict(ps) {
  const p = ps.probabilities;
  const [p0, p1, p2] = [p["0"], p["1"], p["2"]];
  if (p1 >= p0 && p1 >= p2) return "unsettled";
  if (p2 > p0) return "same_thing";
  if (p0 > p2) return "different_thing";
  return "unsettled"; // extremes tie: nothing is heavier
}

// Pair level, every stored pair: reproduces CRMA-1223's 45 unsettled / 29
// lean same_thing / merges found 33 -> 54 of 70 as a check on pairVerdict().
function pairTally() {
  const t = { pairs: 0, rounded_unsettled: 0, split_to_same_thing: 0, split_to_different_thing: 0, extreme_ties: 0, incumbent_merge_pairs: 0, merges_found_rounded: 0, merges_found_heavier: 0 };
  for (const r of results) {
    if (r.error || !r.answers) continue;
    const c = cases[r.audit_id];
    c.neighbors.forEach((n, i) => {
      const ps = r.answers[`pair_sameness__n${i}`];
      if (!ps) return;
      t.pairs++;
      const rounded = roundScore(ps.score, PS_LABELS), v = pairVerdict(ps);
      if (rounded === "unsettled") {
        t.rounded_unsettled++;
        if (v === "same_thing") t.split_to_same_thing++;
        else if (v === "different_thing") t.split_to_different_thing++;
        else if (ps.probabilities["0"] === ps.probabilities["2"]) t.extreme_ties++;
      }
      if (c.ledger.DECISION === "MERGE_INTO_EXISTING" && c.ledger.PROMOTED_TO === n.trend_id) {
        t.incumbent_merge_pairs++;
        if (rounded === "same_thing") t.merges_found_rounded++;
        if (v === "same_thing") t.merges_found_heavier++;
      }
    });
  }
  return t;
}

function compose(r, arm) {
  const c = cases[r.audit_id];
  const answers = r.answers;
  const suffix = arm === "bare" ? "__bare" : "";
  const eq = answers.evidence_quality;
  const eqVerdict = roundScore(eq.score, EQ_LABELS);

  if (eqVerdict === "not_a_topic") {
    return { decision: "REJECT", decision_category: "LOW_QUALITY", decision_rule: "not_a_topic_reject", target_trend_id: null, eq_verdict: eqVerdict, eq_confidence: eq.confidence };
  }

  const neighborResults = c.neighbors.map((n, i) => {
    const ps = answers[`pair_sameness__n${i}`];
    return {
      trend_id: n.trend_id, trend_topic: n.trend_topic,
      psVerdict: pairVerdict(ps), psScore: ps.score, psConfidence: ps.confidence, pSame: ps.probabilities["2"],
      recurring: answers[`is_same_recurring_topic__n${i}${suffix}`]?.noul ?? null,
      deservesOwnRow: answers[`recurrence_deserves_own_row__n${i}${suffix}`]?.noul ?? null,
      narrower: answers[`is_narrower_instance__n${i}${suffix}`]?.noul ?? null,
    };
  });

  const sameThing = neighborResults.filter((n) => n.psVerdict === "same_thing");
  if (sameThing.length) {
    sameThing.sort((a, b) => b.pSame - a.pSame);
    let top = sameThing[0];
    const flagged = sameThing.length >= FLAG_COUNT;
    if (flagged && arm === "criteria") {
      const known = sameThing.every((n) => trendCreated[n.trend_id]);
      tally.multi_same_thing.push({ audit_id: r.audit_id, trend_ids: sameThing.map((n) => n.trend_id), older_known: known });
      if (known) top = [...sameThing].sort((a, b) => trendCreated[a.trend_id].localeCompare(trendCreated[b.trend_id]))[0];
      else tally.older_unknown.push(r.audit_id);
    } else if (flagged) {
      const known = sameThing.every((n) => trendCreated[n.trend_id]);
      if (known) top = [...sameThing].sort((a, b) => trendCreated[a.trend_id].localeCompare(trendCreated[b.trend_id]))[0];
    }
    if ((top.recurring ?? 0) >= NOUL_CUT && (top.deservesOwnRow ?? 0) >= NOUL_CUT) {
      return {
        decision: "PROMOTE_NEW", decision_category: "CONFIRM_NEW", decision_rule: "recurrence_blocked_merge",
        target_trend_id: null, blocked_neighbor: top.trend_id, eq_verdict: eqVerdict, neighbor_results: neighborResults,
      };
    }
    return {
      decision: "MERGE_INTO_EXISTING", decision_category: "MISSED_DUPLICATE", decision_rule: "neighbour_merge",
      target_trend_id: top.trend_id, eq_verdict: eqVerdict,
      multiple_same_thing: flagged ? sameThing.map((s) => s.trend_id) : null,
      neighbor_results: neighborResults,
    };
  }

  if (eqVerdict === "stands_alone") {
    return { decision: "PROMOTE_NEW", decision_category: "CONFIRM_NEW", decision_rule: "stands_alone_promote", target_trend_id: null, eq_verdict: eqVerdict, neighbor_results: neighborResults };
  }
  return { decision: null, decision_category: null, decision_rule: "oracle_decided", target_trend_id: null, eq_verdict: eqVerdict, unscored_reason: "et_unavailable", neighbor_results: neighborResults };
}

const recomposed = results.map((r) => {
  if (r.error || !r.answers) return r;
  return { ...r, composed_criteria: compose(r, "criteria"), composed_bare: compose(r, "bare") };
});

// Every case the new composition sends to the oracle must already have a
// stored oracle answer -- otherwise it would need a new vendor call.
const missingOracle = recomposed.filter((r) => !r.error && r.composed_criteria?.decision_rule === "oracle_decided" && !oracleIds.has(r.audit_id));
if (missingOracle.length) throw new Error(`oracle answers missing for ${missingOracle.map((r) => r.audit_id).join(", ")}`);

const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "crma-1343-"));
const resultsFile = join(tmp, "results.jsonl"), cardFile = join(tmp, "scorecard.json");
writeFileSync(resultsFile, recomposed.map((r) => JSON.stringify(r)).join("\n") + "\n");
execFileSync("node", [join(HERE, "crma-1222-score.mjs")], {
  env: { ...process.env, RESULTS_FILE: resultsFile, ORACLE_FILE, SCORECARD_FILE: cardFile },
  stdio: ["ignore", "ignore", "inherit"],
});
const card = JSON.parse(readFileSync(cardFile, "utf8"));

// ---- Mismatches grouped by mechanism, with the (a3) group split out ----
const AI_AGENTS = ["chatgpt", "gemini", "grok"];
function familyGroup(auditId) {
  const fams = familyDelta(cases[auditId].source_breakdown_raw).fixed_families;
  if (fams.length < 2) return "one_family";
  return fams.every((f) => AI_AGENTS.includes(f)) ? "multi_ai_agent" : "other_multi";
}
function mechanism(m) {
  const rule = m.composed.decision_rule;
  if (m.decision_match && !m.target_match) return "merge_target_differs";
  if (rule === "oracle_decided") return `oracle_decided_${m.composed_decision === "PROMOTE_NEW" ? "promote" : "reject"}_${familyGroup(m.audit_id)}`;
  return rule;
}
const mechanisms = {};
for (const m of card.adopt_bar.mismatches) {
  const key = `${m.ledger_decision} -> ${m.composed_decision} | ${mechanism(m)}`;
  (mechanisms[key] ||= []).push({ audit_id: m.audit_id, candidate_id: m.candidate_id, stratum: m.stratum, trend_topic: cases[m.audit_id].candidate.trend_topic });
}
const a3 = card.adopt_bar.mismatches.filter((m) => m.composed.decision_rule === "oracle_decided" && m.composed_decision === "REJECT" && familyGroup(m.audit_id) === "multi_ai_agent");

const outsideAdoptBar = new Set([
  ...card.rule1_tombstone.detail, ...card.rule2_needs_signal_cohort.detail,
  ...card.rule3_level0_hand_inspect, ...card.rule4_family_mismatch,
].map((r) => r.audit_id));
for (const r of recomposed) if (r.source_data_empty) outsideAdoptBar.add(r.audit_id);
const a3Population = recomposed.filter((r) => !r.error && r.composed_criteria?.decision_rule === "oracle_decided" && familyGroup(r.audit_id) === "multi_ai_agent");

const out = {
  rules: "CRMA-1223 (heavier extreme, P(same_thing) target, older-trend flag, 0.5 Noul cuts) + CRMA-1332 signal_frequency oracle",
  recomposition: {
    pairs: pairTally(),
    multi_same_thing_cases: tally.multi_same_thing,
    older_trend_unknown: tally.older_unknown,
  },
  bucket_counts: card.bucket_counts,
  adopt_bar: {
    matches: card.adopt_bar.matches, scored: card.adopt_bar.scored_population, rate: card.adopt_bar.match_rate,
    without_a3: {
      matches: card.adopt_bar.matches, scored: card.adopt_bar.scored_population - a3.length,
      rate: card.adopt_bar.matches / (card.adopt_bar.scored_population - a3.length),
    },
  },
  mismatches_by_mechanism: Object.fromEntries(Object.entries(mechanisms).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, { n: v.length, cases: v }])),
  a3: {
    mismatches_accounted: a3.length,
    oracle_route_population_all_buckets: a3Population.length,
    in_adopt_bar_population: a3Population.filter((r) => !outsideAdoptBar.has(r.audit_id)).length,
  },
  rule1_tombstone: `${card.rule1_tombstone.matches}/${card.rule1_tombstone.n}`,
  rule2_needs_signal_agrees: `${card.rule2_needs_signal_cohort.agrees_with_eventual}/${card.rule2_needs_signal_cohort.n}`,
  rule3_level0: card.rule3_level0_hand_inspect.map((r) => ({ audit_id: r.audit_id, ledger_decision: r.ledger_decision })),
  rule4_family_mismatch: {
    n: card.rule4_family_mismatch.length,
    caught_defect: card.rule4_family_mismatch.filter((r) => r.caught_defect).length,
  },
  recurrence_overrides_fired: card.recurrence_overrides_fired.length,
  mismatches: card.adopt_bar.mismatches.map((m) => ({
    audit_id: m.audit_id, candidate_id: m.candidate_id, stratum: m.stratum,
    ledger_decision: m.ledger_decision, ledger_target: m.ledger_target,
    composed_decision: m.composed_decision, composed_target: m.composed_target,
    decision_rule: m.composed.decision_rule, eq_verdict: m.composed.eq_verdict,
    family_group: familyGroup(m.audit_id), mechanism: mechanism(m),
  })),
};

writeFileSync(join(HERE, "crma-1343-scorecard.json"), JSON.stringify(out, null, 2));
const { mismatches, ...summary } = out;
summary.mismatches_by_mechanism = Object.fromEntries(Object.entries(out.mismatches_by_mechanism).map(([k, v]) => [k, v.n]));
console.log(JSON.stringify(summary, null, 2));
