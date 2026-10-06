// Tests for the CRMA-1031 workflow_health severity grader.
// Run: node --test audit-agent-p_xMC9nm3/run_audit_agent/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeWorkflowErrors, buildWorkflowHealthRows } from "./workflow_health.mjs";

const wf = (workflow_name, errors_24h_count, extra = {}) => ({
  workflow_name,
  errors_24h_count,
  errors_24h_truncated: false,
  ...extra,
});

test("lifecycle-subagent with 10 errors over 588 runs grades WARN, not RED", () => {
  const g = gradeWorkflowErrors(wf("lifecycle-subagent", 10), 588);
  assert.equal(g.severity, "WARN");
  assert.equal(g.rule, "rate");
  assert.equal(g.error_rate_pct, 1.7);
});

test("lifecycle-subagent with 40 errors over 588 runs grades RED", () => {
  const g = gradeWorkflowErrors(wf("lifecycle-subagent", 40), 588);
  assert.equal(g.severity, "RED");
  assert.equal(g.rule, "rate");
  assert.equal(g.error_rate_pct, 6.8);
});

test("a low-volume workflow with 10 errors still grades RED, on the count rule", () => {
  // promotion-agent read exactly 10 on eight days in 2026-09: a real outage.
  const g = gradeWorkflowErrors(wf("promotion-agent", 10), 588);
  assert.equal(g.severity, "RED");
  assert.equal(g.rule, "count");
  assert.equal(g.error_rate_pct, null);
});

test("the count rule keeps its tiers: INFO 1-2, WARN 3-9, RED 10 and above", () => {
  const sev = (n) => gradeWorkflowErrors(wf("sources", n)).severity;
  assert.deepEqual([1, 2, 3, 9, 10, 57].map(sev), ["INFO", "INFO", "WARN", "WARN", "RED", "RED"]);
});

test("a workflow with no errors has no severity", () => {
  assert.equal(gradeWorkflowErrors(wf("sources", 0)).severity, null);
  assert.equal(gradeWorkflowErrors(wf("lifecycle-subagent", 0), 588).severity, null);
});

test("the rate rule turns RED at exactly 5% of the runs", () => {
  assert.equal(gradeWorkflowErrors(wf("lifecycle-subagent", 29), 600).severity, "WARN");
  assert.equal(gradeWorkflowErrors(wf("lifecycle-subagent", 30), 600).severity, "RED");
});

test("one error on a fan-out subagent is WARN: errors exist below 5%", () => {
  assert.equal(gradeWorkflowErrors(wf("lifecycle-attribution-subagent", 1), 700).severity, "WARN");
});

test("a fan-out subagent with no run volume falls back to the count rule and says so", () => {
  for (const runs of [undefined, null, 0, NaN, -3]) {
    const g = gradeWorkflowErrors(wf("lifecycle-attribution-subagent", 10), runs);
    assert.equal(g.severity, "RED");
    assert.equal(g.rule, "count");
    assert.equal(g.error_rate_pct, null);
    assert.match(g.note, /run volume unavailable/);
  }
  assert.equal(gradeWorkflowErrors(wf("lifecycle-attribution-subagent", 2), null).severity, "INFO");
});

test("a truncated count on a fan-out subagent grades RED: the true rate is unknown", () => {
  // 100 errors over 5,000 runs reads as 2%, but 100 is only a floor.
  const g = gradeWorkflowErrors(wf("lifecycle-subagent", 100, { errors_24h_truncated: true }), 5000);
  assert.equal(g.severity, "RED");
  assert.match(g.note, /at least 100 errors/);
});

test("the note of a rate grade states the count, the runs and the rate", () => {
  const g = gradeWorkflowErrors(wf("lifecycle-subagent", 10), 588);
  assert.equal(g.note, "10 errors over 588 runs = 1.7% (RED at >= 5%)");
});

// ── The rows of the PIPEDREAM WORKFLOW HEALTH block ──────────────────────

const err = (i) => ({ ts_iso: `2026-10-06T0${i}:00:00.000Z`, code: "Error", msg: `boom ${i}`, cell_id: `c_${i}`, event_id: `e${i}` });

test("block row: lifecycle-subagent runs are the ledger inserts plus the errors", () => {
  // A failed run writes no ledger row: 578 inserts + 10 errors = 588 runs.
  const [row] = buildWorkflowHealthRows(
    [wf("lifecycle-subagent", 10, { workflow_id: "p_gYC562o", errors_24h: [err(1), err(2), err(3), err(4)], fetch_error: null })],
    { lifecycleInserts24h: 578 },
  );
  assert.deepEqual(row, {
    workflow_name: "lifecycle-subagent",
    workflow_id: "p_gYC562o",
    errors_24h_count: 10,
    severity: "WARN",
    severity_rule: "rate",
    severity_note: "10 errors over 588 runs = 1.7% (RED at >= 5%)",
    top_errors: [
      { ts_iso: "2026-10-06T01:00:00.000Z", code: "Error", msg: "boom 1", cell_id: "c_1" },
      { ts_iso: "2026-10-06T02:00:00.000Z", code: "Error", msg: "boom 2", cell_id: "c_2" },
      { ts_iso: "2026-10-06T03:00:00.000Z", code: "Error", msg: "boom 3", cell_id: "c_3" },
    ],
    fetch_error: null,
  });
});

test("block row: lifecycle-subagent with no successful run and 4 errors grades RED", () => {
  const [row] = buildWorkflowHealthRows([wf("lifecycle-subagent", 4)], { lifecycleInserts24h: 0 });
  assert.equal(row.severity, "RED");
  assert.equal(row.severity_note, "4 errors over 4 runs = 100% (RED at >= 5%)");
});

test("block row: lifecycle-subagent falls back to the count rule when the ledger count is missing", () => {
  for (const lifecycleInserts24h of [undefined, null]) {
    const [row] = buildWorkflowHealthRows([wf("lifecycle-subagent", 10)], { lifecycleInserts24h });
    assert.equal(row.severity, "RED");
    assert.equal(row.severity_rule, "count");
  }
});

test("block row: lifecycle-attribution-subagent has no run volume, so it grades on the count rule", () => {
  const [row] = buildWorkflowHealthRows([wf("lifecycle-attribution-subagent", 10)], { lifecycleInserts24h: 578 });
  assert.equal(row.severity, "RED");
  assert.equal(row.severity_rule, "count");
  assert.match(row.severity_note, /run volume unavailable/);
});

test("block row: a workflow with no errors carries no severity fields", () => {
  const [row] = buildWorkflowHealthRows(
    [wf("sources", 0, { workflow_id: "p_7NCy36w", errors_24h: [], fetch_error: null })],
    { lifecycleInserts24h: 578 },
  );
  assert.deepEqual(row, {
    workflow_name: "sources",
    workflow_id: "p_7NCy36w",
    errors_24h_count: 0,
    top_errors: [],
    fetch_error: null,
  });
});

test("block row: a truncated count and a failed detail request are both shown", () => {
  const [row] = buildWorkflowHealthRows(
    [wf("promotion-agent", 100, { errors_24h_truncated: true, detail_error: "status 500" })],
    {},
  );
  assert.equal(row.errors_24h_truncated, true);
  assert.equal(row.detail_error, "status 500");
  assert.equal(row.severity, "RED");
});
