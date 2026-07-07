// Tests for the promotion candidate classifier (ADR-0004, issue #60).
// Run: node --test agents/lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCandidate } from "./promotion_gate.mjs";

const cand = (over = {}) => ({
  SOURCE_BREAKDOWN: {},
  CONFIDENCE: 0.8,
  SPECIFICITY_SCORE: 0.8,
  CLUSTER_SIZE: 5,
  ...over,
});

test("multi-family → route_normal", () => {
  const r = classifyCandidate(cand({ SOURCE_BREAKDOWN: { bluesky: 3, gdelt: 2 } }));
  assert.equal(r.action, "route_normal");
  assert.equal(r.source_families, 2);
});

test("single-family high-conf/high-spec → route_et_rescue", () => {
  const r = classifyCandidate(cand({ SOURCE_BREAKDOWN: { bluesky: 4 }, CONFIDENCE: 0.7, SPECIFICITY_SCORE: 0.6 }));
  assert.equal(r.action, "route_et_rescue");
  assert.equal(r.source_families, 1);
});

test("single-family low-confidence → reject", () => {
  const r = classifyCandidate(cand({ SOURCE_BREAKDOWN: { bluesky: 4 }, CONFIDENCE: 0.4, SPECIFICITY_SCORE: 0.9 }));
  assert.equal(r.action, "reject");
});

test("single-family low-specificity → reject", () => {
  const r = classifyCandidate(cand({ SOURCE_BREAKDOWN: { bluesky: 4 }, CONFIDENCE: 0.9, SPECIFICITY_SCORE: 0.3 }));
  assert.equal(r.action, "reject");
});

test("τ is inclusive: exactly 0.5/0.5 single-family → route_et_rescue", () => {
  const r = classifyCandidate(cand({ SOURCE_BREAKDOWN: { gdelt: 2 }, CONFIDENCE: 0.5, SPECIFICITY_SCORE: 0.5 }));
  assert.equal(r.action, "route_et_rescue");
});

test("same-platform variants (amazon_movers + amazon_trends) count as ONE family", () => {
  // Two amazon keys but one family → single-family bucket, so ET-rescue when above τ.
  const r = classifyCandidate(cand({ SOURCE_BREAKDOWN: { amazon_movers: 3, amazon_trends: 2 } }));
  assert.equal(r.source_families, 1);
  assert.equal(r.action, "route_et_rescue");
});

test("distinct discovery LLMs count as independent families → route_normal", () => {
  const r = classifyCandidate(cand({ SOURCE_BREAKDOWN: { agent_gemini_discovery: 2, agent_grok_discovery: 1 } }));
  assert.equal(r.source_families, 2);
  assert.equal(r.action, "route_normal");
});

test("dropped cluster_size branch: low CLUSTER_SIZE no longer forces reject", () => {
  // Old gate hard-rejected cluster_size<2. Now cluster_size is irrelevant to the
  // decision — a 2-family candidate routes normal regardless of cluster_size.
  const lowCluster = classifyCandidate(cand({ SOURCE_BREAKDOWN: { bluesky: 1, gdelt: 1 }, CLUSTER_SIZE: 1 }));
  assert.equal(lowCluster.action, "route_normal");
  // And a big cluster with one family + low conf still rejects — cluster_size
  // never rescues it, proving the branch's removal changed no reject outcome.
  const bigCluster = classifyCandidate(cand({ SOURCE_BREAKDOWN: { bluesky: 50 }, CLUSTER_SIZE: 50, CONFIDENCE: 0.2 }));
  assert.equal(bigCluster.action, "reject");
});

test("missing confidence/specificity default to 0 → single-family reject", () => {
  const r = classifyCandidate({ SOURCE_BREAKDOWN: { bluesky: 3 } });
  assert.equal(r.action, "reject");
});
