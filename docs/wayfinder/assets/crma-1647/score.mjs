// CRMA-1647 step 4: score the candidate against Pro's noise floor with the
// four gates CRMA-1646 decided, and report cost per eval for each model.
//
//   node docs/wayfinder/assets/crma-1647/score.mjs [--a=pro-a] [--b=pro-b] [--c=flash]
//   → out/report.md, out/metrics.json  (--out=report-x writes out/report-x.md + out/report-x.json)
//
// Definitions (CRMA-1646, plus the readings this file had to pick):
//   noise floor     agreement between Pro run A and Pro run B
//   candidate       mean of its agreement with A and with B
//   hard strata     dormant + reenrich + gd_hold + change (100 trends)
//   status change   emitted status differs from the snapshot's current status
//   retirement      emitted status = RETIRED (a proposal; the proc confirms it
//                   only on the second consecutive one)
//   false proposal  the candidate proposes where neither Pro run did
//   miss            the candidate does not propose where at least one Pro run did
//   interval bucket ≤ 6 h, 7–24 h, > 24 h on next_eval_in_hours, all 120 trends
//   no emission     counts as a disagreement on every output, and is reported

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const LABELS = { a: arg("a", "pro-a"), b: arg("b", "pro-b"), c: arg("c", "flash") };
const OUT = arg("out", null);
const HARD = new Set(["dormant", "reenrich", "gd_hold", "change"]);

function load(label) {
  const rows = readFileSync(join(HERE, "out", `run-${label}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byId = new Map();
  for (const r of rows) if (!r.error) byId.set(r.trend_id, r); // last good row wins
  return byId;
}
const runs = Object.fromEntries(Object.entries(LABELS).map(([k, l]) => [k, load(l)]));
const snapshot = readFileSync(join(HERE, "out", "snapshot.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const trends = snapshot.filter((s) => runs.a.has(s.trend_id) && runs.b.has(s.trend_id) && runs.c.has(s.trend_id));
const missing = snapshot.length - trends.length;

const out = (k, id) => {
  const e = runs[k].get(id)?.emission;
  if (!e) return null;
  const h = Number(e.next_eval_in_hours);
  return {
    status: e.status ?? null,
    bucket: !Number.isFinite(h) ? null : h <= 6 ? "≤6h" : h <= 24 ? "7–24h" : ">24h",
    retire: e.status === "RETIRED",
    reenrich: e.request_re_enrichment === true,
  };
};
const agree = (x, y, f) => x != null && y != null && x[f] != null && x[f] === y[f];
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

function agreement(set, f) {
  const n = set.length;
  const ab = set.filter((s) => agree(out("a", s.trend_id), out("b", s.trend_id), f)).length;
  const ca = set.filter((s) => agree(out("c", s.trend_id), out("a", s.trend_id), f)).length;
  const cb = set.filter((s) => agree(out("c", s.trend_id), out("b", s.trend_id), f)).length;
  return { n, floor: pct(ab, n), candidate: pct((ca + cb) / 2, n) };
}
const changeRate = (k, set) => pct(set.filter((s) => out(k, s.trend_id) && out(k, s.trend_id).status !== s.current_status).length, set.length);
const rate = (k, f, set) => pct(set.filter((s) => out(k, s.trend_id)?.[f]).length, set.length);

const hard = trends.filter((s) => HARD.has(s.stratum));
const controls = trends.filter((s) => s.stratum === "control");

// Gate 1: status
const g1 = agreement(hard, "status");
const ctl = { pro: (changeRate("a", controls) + changeRate("b", controls)) / 2, candidate: changeRate("c", controls) };
const g1pass = g1.candidate >= g1.floor - 5 && ctl.candidate <= 2 * ctl.pro;

// Gate 2: retirement
const ret = (k, id) => out(k, id)?.retire === true;
const falseProps = trends.filter((s) => ret("c", s.trend_id) && !ret("a", s.trend_id) && !ret("b", s.trend_id));
const misses = trends.filter((s) => !ret("c", s.trend_id) && (ret("a", s.trend_id) || ret("b", s.trend_id)));
const proDisagree = trends.filter((s) => ret("a", s.trend_id) !== ret("b", s.trend_id)).length;
const g2pass = falseProps.length === 0 && misses.length <= proDisagree + 1;

// Gate 3: interval bucket
const g3 = agreement(trends, "bucket");
const g3pass = g3.candidate >= g3.floor - 10;

// Gate 4: re-enrichment rate
const reRate = { pro: (rate("a", "reenrich", trends) + rate("b", "reenrich", trends)) / 2, candidate: rate("c", "reenrich", trends) };
const g4ratio = reRate.pro ? Math.round((100 * reRate.candidate) / reRate.pro) / 100 : null;
const g4pass = g4ratio === null ? reRate.candidate === 0 : g4ratio >= 0.5 && g4ratio <= 2;
const reAgree = agreement(trends, "reenrich");

// Cost per eval
const median = (xs) => { const s = [...xs].sort((p, q) => p - q); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const mean = (xs) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null);
const r4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000);
function cost(k) {
  const rows = trends.map((s) => runs[k].get(s.trend_id));
  const acc = rows.map((r) => r.accounting);
  const truth = acc.map((a) => a.cost_with_thinking);
  return {
    label: LABELS[k], model: rows[0]?.model,
    mean_usd: r4(mean(truth)), median_usd: r4(median(truth)),
    median_usd_as_production_records: r4(median(acc.map((a) => a.cost_as_deployed))),
    median_batch_usd: r4(median(truth) / 2),
    per_day_600_batch_usd: Math.round(mean(truth) * 0.5 * 600 * 100) / 100,
    median_input_tokens: median(acc.map((a) => a.input_tokens)),
    median_output_tokens: median(acc.map((a) => a.candidates_tokens)),
    median_thinking_tokens: median(acc.map((a) => a.thoughts_tokens)),
    mean_turns: Math.round(mean(rows.map((r) => r.turns)) * 100) / 100,
    no_emission: rows.filter((r) => !r.emission).length,
    budget_stops: rows.filter((r) => r.stop_reason === "budget_exhausted").length,
  };
}
const costs = ["a", "b", "c"].map(cost);

const strata = [...new Set(trends.map((s) => s.stratum))].map((st) => {
  const set = trends.filter((s) => s.stratum === st);
  return { stratum: st, ...agreement(set, "status") };
});

const metrics = {
  labels: LABELS, trends_scored: trends.length, trends_missing_a_run: missing,
  gates: {
    status: { ...g1, control_change_rate: ctl, pass: g1pass },
    retirement: { false_proposals: falseProps.map((s) => s.trend_id), misses: misses.map((s) => s.trend_id), pro_disagreements: proDisagree, pass: g2pass },
    interval_bucket: { ...g3, pass: g3pass },
    re_enrichment: { rate: reRate, ratio: g4ratio, per_trend_agreement: reAgree, pass: g4pass },
  },
  all_gates_pass: g1pass && g2pass && g3pass && g4pass,
  status_by_stratum: strata, costs,
};
writeFileSync(join(HERE, "out", OUT ? `${OUT}.json` : "metrics.json"), JSON.stringify(metrics, null, 2));

const yes = (b) => (b ? "**pass**" : "**FAIL**");
const md = `# CRMA-1647 shadow comparison: ${LABELS.c} vs Pro

${trends.length} trends scored${missing ? ` (${missing} missing a run, excluded)` : ""}. Noise floor = Pro run A vs Pro run B. Candidate = mean agreement with A and B.

| Gate | Noise floor | Candidate | Bar | Result |
| --- | --- | --- | --- | --- |
| 1. Status, hard strata (n=${g1.n}) | ${g1.floor}% | ${g1.candidate}% | ≥ floor − 5 | ${yes(g1.candidate >= g1.floor - 5)} |
| 1. Status change rate, controls (n=${controls.length}) | ${ctl.pro}% | ${ctl.candidate}% | ≤ 2× Pro | ${yes(ctl.candidate <= 2 * ctl.pro)} |
| 2. False retirement proposals | — | ${falseProps.length} | 0 | ${yes(falseProps.length === 0)} |
| 2. Missed retirement proposals | ${proDisagree} Pro disagreements | ${misses.length} | ≤ ${proDisagree + 1} | ${yes(misses.length <= proDisagree + 1)} |
| 3. Interval bucket (n=${g3.n}) | ${g3.floor}% | ${g3.candidate}% | ≥ floor − 10 | ${yes(g3pass)} |
| 4. Re-enrichment rate | ${reRate.pro}% | ${reRate.candidate}% | 0.5×–2× (ratio ${g4ratio ?? "n/a"}) | ${yes(g4pass)} |

**All gates: ${metrics.all_gates_pass ? "pass" : "FAIL"}.** Re-enrichment per-trend agreement (report only): floor ${reAgree.floor}%, candidate ${reAgree.candidate}%.

## Status agreement by stratum

| Stratum | n | Noise floor | Candidate |
| --- | --- | --- | --- |
${strata.map((s) => `| ${s.stratum} | ${s.n} | ${s.floor}% | ${s.candidate}% |`).join("\n")}

## Cost per eval (standard API, thinking tokens included)

| Run | Model | Mean | Median | Median as production records it | Median on a Gemini batch | 600 evals/day on a batch | Input tok | Output tok | Thinking tok | Mean turns | No emission | Budget stops |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${costs.map((c) => `| ${c.label} | ${c.model} | $${c.mean_usd} | $${c.median_usd} | $${c.median_usd_as_production_records} | $${c.median_batch_usd} | $${c.per_day_600_batch_usd} | ${c.median_input_tokens} | ${c.median_output_tokens} | ${c.median_thinking_tokens} | ${c.mean_turns} | ${c.no_emission} | ${c.budget_stops} |`).join("\n")}
`;
writeFileSync(join(HERE, "out", OUT ? `${OUT}.md` : "report.md"), md);
console.log(md);
