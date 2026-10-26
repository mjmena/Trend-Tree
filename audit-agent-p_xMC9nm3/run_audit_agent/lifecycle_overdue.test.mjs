// Run: node --test audit-agent-p_xMC9nm3/run_audit_agent/lifecycle_overdue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeLifecycleOverdue, applyLifecycleOverdueFinding } from "./lifecycle_overdue.mjs";

const freshness = (count, maxMinutes = null) => [
  { AREA: "lifecycle", KEY: "all_24h", COUNT_24H: 900, MINUTES_SINCE_LAST: 3 },
  { AREA: "lifecycle", KEY: "overdue_6h", COUNT_24H: count, MINUTES_SINCE_LAST: maxMinutes },
  { AREA: "promotion", KEY: "all", COUNT_24H: 4, MINUTES_SINCE_LAST: 60 },
];

test("GREEN when no live trend is more than 6h past its next evaluation", () => {
  const g = gradeLifecycleOverdue(freshness(0));
  assert.equal(g.status, "GREEN");
  assert.equal(g.overdue_count, 0);
});

test("YELLOW when one trend is overdue, with the worst lateness in hours", () => {
  const g = gradeLifecycleOverdue(freshness(1, 450));
  assert.equal(g.status, "YELLOW");
  assert.equal(g.overdue_count, 1);
  assert.equal(g.max_hours_past_due, 7.5);
});

test("YELLOW when the overdue row is missing or NULL, not read as zero", () => {
  assert.equal(gradeLifecycleOverdue([]).status, "YELLOW");
  assert.equal(gradeLifecycleOverdue(undefined).status, "YELLOW");
  const g = gradeLifecycleOverdue(freshness(null));
  assert.equal(g.status, "YELLOW");
  assert.equal(g.overdue_count, null);
});

test("apply GREEN: adds report.lifecycle_overdue, leaves the rest alone", () => {
  const base = { overall_status: "GREEN", alerts: [], slack_summary_md: "ok" };
  const out = applyLifecycleOverdueFinding(base, gradeLifecycleOverdue(freshness(0)));
  assert.equal(out.lifecycle_overdue.status, "GREEN");
  assert.equal(out.overall_status, "GREEN");
  assert.deepEqual(out.alerts, []);
  assert.equal(out.slack_summary_md, "ok");
});

test("apply YELLOW on a GREEN report: one alert, YELLOW overall, a Slack line", () => {
  const base = { overall_status: "GREEN", alerts: [], slack_summary_md: "ok" };
  const out = applyLifecycleOverdueFinding(base, gradeLifecycleOverdue(freshness(452, 600)));
  assert.equal(out.overall_status, "YELLOW");
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].severity, "YELLOW");
  assert.equal(out.alerts[0].area, "lifecycle");
  assert.match(out.alerts[0].summary, /452/);
  assert.match(out.slack_summary_md, /^ok\n\n🟡 \*Lifecycle\*: 452/);
});

test("apply YELLOW never de-escalates a RED report", () => {
  const base = { overall_status: "RED", alerts: [{ area: "cost" }] };
  const out = applyLifecycleOverdueFinding(base, gradeLifecycleOverdue(freshness(3, 400)));
  assert.equal(out.overall_status, "RED");
  assert.equal(out.alerts.length, 2);
});

test("apply does not mutate its input", () => {
  const base = { overall_status: "GREEN", alerts: [] };
  applyLifecycleOverdueFinding(base, gradeLifecycleOverdue(freshness(5, 400)));
  assert.deepEqual(base, { overall_status: "GREEN", alerts: [] });
});
