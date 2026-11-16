// CRMA-1690 step 3: score the candidate model against Pro's own run-to-run
// agreement, by CRMA-1689's pass bar, and write out/report.md + out/score.json.
//
// A link is one (trend_id, signal_id) pair. Pro ran twice (A, B) on the frozen
// snapshot; the candidate ran once (C). With no ground truth, "agrees with a Pro
// run" stands in for "correct":
//
//   Pro self-agreement S  = mean(|A∩B| / |A|, |A∩B| / |B|)
//   candidate precision P = mean(|C∩A| / |C|, |C∩B| / |C|)
//   candidate recall    R = mean(|C∩A| / |A|, |C∩B| / |B|)
//
// A signal id outside the trend's candidate pool is a false link (CRMA-1461).
// A called trend whose answer did not parse to an `attributions` array is
// unparseable and contributes no links. Empty-pool trends are not scored.
//
// Gates (CRMA-1689): P >= S - 0.05, R >= S - 0.25, unparseable <= 2% of called
// trends, and A and B together hold at least 40 links (else INCONCLUSIVE).
//
//   node docs/wayfinder/assets/crma-1690/score.mjs pro-a pro-b flash

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [labelA, labelB, labelC] = process.argv.slice(2);
if (!labelC) throw new Error("usage: score.mjs <pro-a> <pro-b> <candidate>");

const readJsonl = (f) => readFileSync(join(HERE, "out", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const snapshot = readJsonl("snapshot.jsonl").filter((s) => s.candidate_count > 0);
const pools = new Map(snapshot.map((s) => [s.trend_id, new Set(s.context.candidate_signals.map((c) => c.signal_id))]));

function load(label) {
  const rows = new Map(readJsonl(`run-${label}.jsonl`).filter((r) => !r.error).map((r) => [r.trend_id, r]));
  const links = new Map();
  let unparseable = 0;
  let offPool = 0;
  let model = null;
  for (const s of snapshot) {
    const r = rows.get(s.trend_id);
    model ??= r?.model;
    const list = r?.emission?.attributions;
    if (!Array.isArray(list)) { unparseable++; continue; }
    for (const a of list) {
      if (!pools.get(s.trend_id).has(a.signal_id)) offPool++;
      links.set(`${s.trend_id}|${a.signal_id}`, a.link_type);
    }
  }
  return { label, model, links, unparseable, offPool, missing: snapshot.filter((s) => !rows.has(s.trend_id)).length };
}

const inter = (x, y) => [...x.keys()].filter((k) => y.has(k)).length;
const ratio = (n, d) => (d ? n / d : 0);
const A = load(labelA);
const B = load(labelB);
const C = load(labelC);
const ab = inter(A.links, B.links);
const ca = inter(C.links, A.links);
const cb = inter(C.links, B.links);

const S = (ratio(ab, A.links.size) + ratio(ab, B.links.size)) / 2;
const P = (ratio(ca, C.links.size) + ratio(cb, C.links.size)) / 2;
const R = (ratio(ca, A.links.size) + ratio(cb, B.links.size)) / 2;
const unparseableRate = ratio(C.unparseable, snapshot.length);
const enough = A.links.size + B.links.size >= 40;

const gates = {
  precision: { value: P, bar: S - 0.05, pass: P >= S - 0.05 },
  recall: { value: R, bar: S - 0.25, pass: R >= S - 0.25 },
  unparseable: { value: unparseableRate, bar: 0.02, pass: unparseableRate <= 0.02 },
};
const verdict = !enough ? "INCONCLUSIVE" : Object.values(gates).every((g) => g.pass) ? "PASS" : "FAIL";

// link_type agreement on the links the candidate shares with a Pro run (reported, not gated).
let typeSame = 0;
let typeShared = 0;
for (const [k, t] of C.links) {
  for (const ref of [A, B]) if (ref.links.has(k)) { typeShared++; if (ref.links.get(k) === t) typeSame++; }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const lines = [
  "# CRMA-1690: the attribution comparison in the one-request shape",
  "",
  `Snapshot: ${snapshot.length} trends with a non-empty pool (\`out/snapshot.jsonl\`). Pro ran twice, the candidate once. Pass bar: CRMA-1689.`,
  "",
  "| Run | Model | Links | Off-pool links | Unparseable | Missing rows |",
  "| --- | --- | --- | --- | --- | --- |",
  ...[A, B, C].map((r) => `| ${r.label} | ${r.model} | ${r.links.size} | ${r.offPool} | ${r.unparseable} | ${r.missing} |`),
  "",
  `Overlap: ${labelA}∩${labelB} = ${ab}, ${labelC}∩${labelA} = ${ca}, ${labelC}∩${labelB} = ${cb}.`,
  "",
  "| Measure | Value | Bar | Result |",
  "| --- | --- | --- | --- |",
  `| Pro self-agreement S | ${pct(S)} | — | — |`,
  `| ${labelC} precision P | ${pct(P)} | ≥ S − 5 pts = ${pct(gates.precision.bar)} | ${gates.precision.pass ? "pass" : "FAIL"} |`,
  `| ${labelC} recall R | ${pct(R)} | ≥ S − 25 pts = ${pct(gates.recall.bar)} | ${gates.recall.pass ? "pass" : "FAIL"} |`,
  `| ${labelC} unparseable | ${pct(unparseableRate)} | ≤ 2% | ${gates.unparseable.pass ? "pass" : "FAIL"} |`,
  `| Pro links, A + B | ${A.links.size + B.links.size} | ≥ 40 | ${enough ? "enough" : "too few"} |`,
  "",
  `**Verdict: ${verdict}.** link_type agrees with Pro on ${typeSame} of ${typeShared} shared links (reported, not gated).`,
];
writeFileSync(join(HERE, "out", "report.md"), lines.join("\n") + "\n");
writeFileSync(join(HERE, "out", "score.json"), JSON.stringify({
  verdict, S, P, R, unparseable_rate: unparseableRate, gates,
  links: { [labelA]: A.links.size, [labelB]: B.links.size, [labelC]: C.links.size },
  overlap: { ab, ca, cb }, off_pool: { [labelA]: A.offPool, [labelB]: B.offPool, [labelC]: C.offPool },
  link_type: { same: typeSame, shared: typeShared },
}, null, 2) + "\n");
console.log(lines.join("\n"));
