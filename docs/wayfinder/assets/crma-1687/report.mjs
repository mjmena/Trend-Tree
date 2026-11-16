// CRMA-1687 step 3: price every run in out/ and write out/report.md.
//
// Cost per eval counts thinking tokens at the output rate (the bill), and also
// the way production computes it (thinking left out). Per-day figures scale the
// mean, empty-pool trends at $0 included, to EVALS_PER_DAY. A one-request run is
// also priced on a Gemini batch (50% of standard), and Flash also at its
// 2027-01-01 rates.
//
//   node docs/wayfinder/assets/crma-1687/report.mjs pro-loop pro-1req flash-1req ...

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RATES_PER_M } from "./lib/gemini.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVALS_PER_DAY = 720; // sweep_cap 30 × 24 hourly sweeps
const labels = process.argv.slice(2);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const usd = (n, d = 4) => `$${n.toFixed(d)}`;
const costAt = (r, rate) =>
  (r.accounting.input_tokens / 1e6) * rate.input +
  ((r.accounting.candidates_tokens + r.accounting.thoughts_tokens) / 1e6) * rate.output;

const lines = [
  "# CRMA-1687: the attribution agent's cost per eval and per day",
  "",
  `Sample: N eligible trends frozen once (\`out/snapshot.jsonl\`). Per day = mean × ${EVALS_PER_DAY} evals. Thinking tokens billed at the output rate.`,
  "",
  "| Run | Model | Shape | n (called) | Mean / eval | Median / eval | Mean as production records it | Per day, standard | Per day, Gemini batch | Per day, batch at 2027 rates | Mean input tok | Mean output tok | Mean thinking tok | Mean turns | No answer | Budget stops | MAX_TOKENS |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
let sampleN = 0;
const metrics = {};
for (const label of labels) {
  const rows = new Map();
  for (const l of readFileSync(join(HERE, "out", `run-${label}.jsonl`), "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (!r.error) rows.set(r.trend_id, r);
  }
  const all = [...rows.values()];
  sampleN = Math.max(sampleN, all.length);
  const called = all.filter((r) => !r.skipped);
  const model = all[0].model;
  const mode = all[0].mode;
  const cost = all.map((r) => r.accounting.cost_with_thinking);
  const deployed = all.map((r) => r.accounting.cost_as_deployed);
  const perDay = mean(cost) * EVALS_PER_DAY;
  const batch = mode === "oneshot" ? perDay / 2 : null;
  const after = RATES_PER_M[model]?.after;
  const batch2027 = mode === "oneshot" && after ? (mean(all.map((r) => costAt(r, after))) * EVALS_PER_DAY) / 2 : null;
  const m = {
    label, model, mode, n: all.length, called: called.length,
    mean_eval: mean(cost), median_eval: median(cost), mean_as_deployed: mean(deployed),
    per_day_standard: perDay, per_day_batch: batch, per_day_batch_2027: batch2027,
    mean_input: mean(called.map((r) => r.accounting.input_tokens)),
    mean_output: mean(called.map((r) => r.accounting.candidates_tokens)),
    mean_thinking: mean(called.map((r) => r.accounting.thoughts_tokens)),
    mean_turns: mean(called.map((r) => r.turns)),
    no_answer: called.filter((r) => !Array.isArray(r.emission?.attributions)).length,
    budget_stops: called.filter((r) => r.stop_reason === "budget_exhausted").length,
    max_tokens: called.filter((r) => (r.finish_reasons || []).includes("MAX_TOKENS")).length,
    mean_attributed: mean(called.map((r) => r.emission?.attributions?.length ?? 0)),
  };
  metrics[label] = m;
  lines.push(`| ${label} | ${model} | ${mode === "loop" ? "tool loop" : "one request"} | ${m.n} (${m.called}) | ${usd(m.mean_eval)} | ${usd(m.median_eval)} | ${usd(m.mean_as_deployed)} | ${usd(perDay, 2)} | ${batch == null ? "—" : usd(batch, 2)} | ${batch2027 == null ? "—" : usd(batch2027, 2)} | ${m.mean_input.toFixed(0)} | ${m.mean_output.toFixed(0)} | ${m.mean_thinking.toFixed(0)} | ${m.mean_turns.toFixed(2)} | ${m.no_answer} | ${m.budget_stops} | ${m.max_tokens} |`);
}
lines[2] = lines[2].replace("N eligible", `${sampleN} eligible`);
lines.push("", "Mean attributed per called trend (a count, not a precision measure; precision is CRMA-1690):", "");
for (const m of Object.values(metrics)) lines.push(`- ${m.label}: ${m.mean_attributed.toFixed(2)} (${(m.mean_attributed * m.called).toFixed(0)} links)`);
writeFileSync(join(HERE, "out", "report.md"), lines.join("\n") + "\n");
writeFileSync(join(HERE, "out", "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
console.log(lines.join("\n"));
