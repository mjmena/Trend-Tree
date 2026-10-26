// Tests for the CRMA-1670 editorial-counts grading helper.
// Run: node --test audit-agent-p_xMC9nm3/run_audit_agent/
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEditorialCounts, applyEditorialFinding } from "./editorial_counts.mjs";

const row = (promotions, stuck) => ({
  EDITORIAL_PROMOTIONS_24H: promotions,
  EDITORIAL_STUCK_CANDIDATES: stuck,
});

test("GREEN with zero stuck candidates; both counts carried", () => {
  const g = gradeEditorialCounts([row(3, 0)]);
  assert.equal(g.status, "GREEN");
  assert.equal(g.promotions_24h, 3);
  assert.equal(g.stuck_candidates, 0);
});

test("GREEN with 0/0 before any nomination exists", () => {
  assert.deepEqual(gradeEditorialCounts([row(0, 0)]), { status: "GREEN", promotions_24h: 0, stuck_candidates: 0 });
});

test("RED on any stuck candidate", () => {
  assert.equal(gradeEditorialCounts([row(0, 1)]).status, "RED");
});

test("RED when the query returned no row or a NULL stuck count (fail safe)", () => {
  assert.equal(gradeEditorialCounts([]).status, "RED");
  assert.equal(gradeEditorialCounts(undefined).status, "RED");
  assert.equal(gradeEditorialCounts([row(0, null)]).status, "RED");
});

test("apply GREEN: adds report.editorial, leaves alerts, status and Slack text alone", () => {
  const base = { overall_status: "GREEN", alerts: [], slack_summary_md: "hi" };
  const out = applyEditorialFinding(base, gradeEditorialCounts([row(2, 0)]));
  assert.deepEqual(out.editorial, { status: "GREEN", promotions_24h: 2, stuck_candidates: 0 });
  assert.equal(out.overall_status, "GREEN");
  assert.deepEqual(out.alerts, []);
  assert.equal(out.slack_summary_md, "hi");
});

test("apply RED: one editorial alert, GREEN report becomes RED, Slack line added", () => {
  const base = { overall_status: "GREEN", alerts: [], slack_summary_md: "all good" };
  const out = applyEditorialFinding(base, gradeEditorialCounts([row(1, 2)]));
  assert.equal(out.overall_status, "RED");
  assert.equal(out.editorial.stuck_candidates, 2);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].area, "editorial");
  assert.equal(out.alerts[0].severity, "RED");
  assert.match(out.slack_summary_md, /^all good\n\n🔴 \*Editorial\*/);
});

test("apply does not mutate its input", () => {
  const base = { overall_status: "GREEN", alerts: [] };
  applyEditorialFinding(base, gradeEditorialCounts([row(0, 5)]));
  assert.deepEqual(base, { overall_status: "GREEN", alerts: [] });
});
