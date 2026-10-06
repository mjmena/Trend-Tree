// CRMA-1332: score each oracle keyword arm through crma-1222-score.mjs (the
// same code that produced CRMA-1222's 69/136), then break the oracle route
// down by vendor-aware family count -- the 1-family and the 2+-family
// (multi-AI-agent) groups from CRMA-1222 (a3) -- and list every same_concept
// match for the hand check. Writes crma-1332-scorecard.json.
//
// Run: node crma-1332-score.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { familyDelta } from "./crma-1222-family.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(HERE, "crma-1222-cases.json"), "utf8"));
const readJsonl = (f) => readFileSync(join(HERE, f), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

const ARMS = {
  trend_topic: "crma-1222-oracle-results.jsonl",
  signal_frequency: "crma-1332-oracle-signal_frequency.jsonl",
  jev_selected: "crma-1332-oracle-jev_selected.jsonl",
  hand_written_ceiling: "crma-1332-oracle-hand_written_ceiling.jsonl",
};

function scoreArm(oracleFile) {
  const out = join(HERE, `.crma-1332-tmp-scorecard.json`);
  execFileSync("node", [join(HERE, "crma-1222-score.mjs")], {
    env: { ...process.env, ORACLE_FILE: join(HERE, oracleFile), SCORECARD_FILE: out },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const card = JSON.parse(readFileSync(out, "utf8"));
  execFileSync("rm", ["-f", out]);
  return card;
}

// The adopt-bar scorecard only lists mismatches, so rebuild the oracle-route
// population from the oracle file itself plus the case's bucket.
function breakdown(oracleRecords, card) {
  const mismatchIds = new Set(card.adopt_bar.mismatches.map((m) => m.audit_id));
  const excluded = new Set([
    ...card.rule1_tombstone.detail.map((r) => r.audit_id),
    ...card.rule2_needs_signal_cohort.detail.map((r) => r.audit_id),
    ...card.rule4_family_mismatch.map((r) => r.audit_id),
  ]);
  const groups = { one_family: { n: 0, matched: 0, promoted: 0 }, multi_ai_agent: { n: 0, matched: 0, promoted: 0 }, other_multi: { n: 0, matched: 0, promoted: 0 } };
  for (const o of oracleRecords) {
    if (o.error || excluded.has(o.audit_id)) continue;
    const c = cases[o.audit_id];
    const fams = familyDelta(c.source_breakdown_raw).fixed_families;
    const g = fams.length < 2 ? "one_family" : fams.every((f) => ["chatgpt", "gemini", "grok"].includes(f)) ? "multi_ai_agent" : "other_multi";
    groups[g].n++;
    if (!mismatchIds.has(o.audit_id)) groups[g].matched++;
    if (o.decision === "PROMOTE_NEW") groups[g].promoted++;
  }
  return groups;
}

function keywordStats(oracleRecords) {
  const kw = oracleRecords.flatMap((o) => (o.keyword_from_crma_1222 || !o.keywords ? [] : o.keywords));
  const nullQueryCases = oracleRecords.filter((o) => !o.error && !o.keyword_from_crma_1222 && o.oracle_keyword_source !== "candidate_query");
  return {
    keyword_calls: kw.length,
    et_any_result: kw.filter((k) => k.et_matched).length,
    et_result_above_floor: kw.filter((k) => k.survivors > 0).length,
    null_query_cases: nullQueryCases.length,
    null_query_cases_promoted: nullQueryCases.filter((o) => o.decision === "PROMOTE_NEW").length,
  };
}

function sameConceptMatches(arm, oracleRecords) {
  const rows = [];
  for (const o of oracleRecords) {
    for (const a of o.oracle_answers || []) {
      if (a.verdict !== "same_concept") continue;
      const c = cases[o.audit_id];
      rows.push({
        arm, audit_id: o.audit_id, candidate_id: o.candidate_id,
        trend_topic: c.candidate.trend_topic, sent_keyword: a.from_keyword ?? o.oracle_keyword,
        keyword_source: o.keyword_from_crma_1222 ? o.oracle_keyword_source : arm,
        et_keyword: a.keyword, absolute_volume: a.absolute_volume,
        score: a.score, confidence: a.confidence, ledger_decision: c.ledger.DECISION,
      });
    }
  }
  return rows;
}

const result = { arms: {}, same_concept_matches: [] };
for (const [arm, file] of Object.entries(ARMS)) {
  const records = readJsonl(file);
  const card = scoreArm(file);
  result.arms[arm] = {
    adopt_bar: { matches: card.adopt_bar.matches, scored: card.adopt_bar.scored_population, rate: card.adopt_bar.match_rate },
    errors: records.filter((o) => o.error).length,
    oracle_route_in_adopt_bar: breakdown(records, card),
    oracle_promotions_total: records.filter((o) => o.decision === "PROMOTE_NEW").length,
    keyword_stats: arm === "trend_topic" ? null : keywordStats(records),
    rule1: `${card.rule1_tombstone.matches}/${card.rule1_tombstone.n}`,
    rule2_agrees: `${card.rule2_needs_signal_cohort.agrees_with_eventual}/${card.rule2_needs_signal_cohort.n}`,
    oracle_cost_usd: records.reduce((s, o) => s + (o.cost_usd || 0), 0),
  };
  result.same_concept_matches.push(...sameConceptMatches(arm, records));
}

writeFileSync(join(HERE, "crma-1332-scorecard.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.arms, null, 2));
console.log(`same_concept matches for hand check: ${result.same_concept_matches.length}`);
