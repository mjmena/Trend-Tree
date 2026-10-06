// Tests for the CRMA-1031 saturation guard: RED streaks and the Slack gate.
// Run: node --test audit-agent-p_xMC9nm3/run_audit_agent/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStreaks, applySaturation } from "./saturation.mjs";

// One q_audit_history row. History is newest first.
const run = (date, redAreas, { kind = "cron", status } = {}) => ({
  EVALUATED_AT: `${date} 13:01:00`,
  TRIGGER_KIND: kind,
  OVERALL_STATUS: status || (redAreas.length ? "RED" : "GREEN"),
  RED_AREAS: redAreas,
});

test("a first-day RED has a streak of 1", () => {
  const history = [run("2026-10-05", []), run("2026-10-04", ["catalog"])];
  const out = computeStreaks({ redAreas: ["tiktok"], history, triggerKind: "cron" });
  assert.deepEqual(out.streaks, { tiktok: 1 });
});

test("an unchanged RED adds 1 to the streak of the earlier scheduled runs", () => {
  const history = [
    run("2026-10-05", ["catalog", "governance"]),
    run("2026-10-04", ["catalog", "governance"]),
    run("2026-10-03", ["catalog"]),
    run("2026-10-02", []),
  ];
  const out = computeStreaks({ redAreas: ["catalog", "governance"], history, triggerKind: "cron" });
  assert.deepEqual(out.streaks, { catalog: 4, governance: 3 });
});

test("an area that clears and returns starts again at 1", () => {
  const history = [
    run("2026-10-05", []),
    run("2026-10-04", ["workflow_health"]),
    run("2026-10-03", ["workflow_health"]),
  ];
  const out = computeStreaks({ redAreas: ["workflow_health"], history, triggerKind: "cron" });
  assert.deepEqual(out.streaks, { workflow_health: 1 });
});

test("HTTP runs in the history are ignored: they neither extend nor break a streak", () => {
  const history = [
    run("2026-10-05", [], { kind: "http" }),
    run("2026-10-05", ["tiktok"]),
    run("2026-10-04", ["tiktok"], { kind: "http" }),
    run("2026-10-04", ["tiktok"]),
    run("2026-10-03", []),
  ];
  const out = computeStreaks({ redAreas: ["tiktok"], history, triggerKind: "cron" });
  assert.deepEqual(out.streaks, { tiktok: 3 });
});

test("an HTTP run does not count toward a streak: it reports the scheduled streak so far", () => {
  const history = [run("2026-10-05", ["tiktok"]), run("2026-10-04", ["tiktok"]), run("2026-10-03", [])];
  const out = computeStreaks({ redAreas: ["tiktok", "enrichment"], history, triggerKind: "http" });
  assert.deepEqual(out.streaks, { tiktok: 2, enrichment: 0 });
});

test("RED_AREAS may arrive as a JSON string, and area names compare without case or padding", () => {
  const history = [
    { ...run("2026-10-05", []), RED_AREAS: '["Catalog ", "governance"]' },
    { ...run("2026-10-04", []), RED_AREAS: null },
  ];
  const out = computeStreaks({ redAreas: ["catalog"], history, triggerKind: "cron" });
  assert.deepEqual(out.streaks, { catalog: 2 });
});

test("no history at all: every RED area is on day 1 and there is no previous run", () => {
  for (const history of [[], undefined, null]) {
    const out = computeStreaks({ redAreas: ["tiktok"], history, triggerKind: "cron" });
    assert.deepEqual(out.streaks, { tiktok: 1 });
    assert.equal(out.previous, null);
  }
});

test("previous is the latest scheduled run, with its status and RED areas", () => {
  const history = [
    run("2026-10-05", ["tiktok"], { kind: "http" }),
    run("2026-10-04", ["tiktok", "catalog"]),
    run("2026-10-03", []),
  ];
  const out = computeStreaks({ redAreas: [], history, triggerKind: "cron" });
  assert.deepEqual(out.previous, {
    evaluated_at: "2026-10-04 13:01:00",
    overall_status: "RED",
    red_areas: ["catalog", "tiktok"],
  });
});

// ── The Slack gate, through applySaturation ──────────────────────────────

const report = (status, redAreas, extra = {}) => ({
  overall_status: status,
  alerts: redAreas.map((area) => ({ severity: "RED", area, summary: `${area} is red` })),
  slack_summary_md: "body",
  ...extra,
});

const gate = (rep, history, opts = {}) =>
  applySaturation(rep, { history, triggerKind: "cron", force: false, ...opts }).saturation.slack;

test("gate: an unchanged RED set with no weekly boundary sends no DM, and says why", () => {
  const history = [
    run("2026-10-05", ["catalog", "governance"]),
    run("2026-10-04", ["catalog", "governance"]),
    run("2026-10-03", ["catalog"]),
  ];
  const g = gate(report("RED", ["governance", "catalog"]), history);
  assert.equal(g.send, false);
  assert.equal(g.reason, "RED set unchanged since 2026-10-04 (catalog streak 4, governance streak 3)");
});

test("gate: a new RED area sends the DM", () => {
  const history = [run("2026-10-05", ["catalog"]), run("2026-10-04", ["catalog"])];
  const g = gate(report("RED", ["catalog", "tiktok"]), history);
  assert.equal(g.send, true);
  assert.equal(g.reason, "RED areas changed: +tiktok");
});

test("gate: a RED area that clears while another stays RED sends the DM", () => {
  const history = [run("2026-10-05", ["catalog", "governance"])];
  const g = gate(report("RED", ["catalog"]), history);
  assert.equal(g.send, true);
  assert.equal(g.reason, "RED areas changed: -governance");
});

test("gate: RED to YELLOW sends the DM", () => {
  const history = [run("2026-10-05", ["tiktok"])];
  const g = gate(report("YELLOW", []), history);
  assert.equal(g.send, true);
  assert.equal(g.reason, "status changed: RED → YELLOW");
});

test("gate: a recovery to GREEN sends the DM", () => {
  const history = [run("2026-10-05", [], { status: "YELLOW" })];
  const g = gate(report("GREEN", []), history);
  assert.equal(g.send, true);
  assert.equal(g.reason, "status changed: YELLOW → GREEN");
});

test("gate: a streak of 7 sends the weekly reminder; a streak of 8 does not", () => {
  const days = ["05", "04", "03", "02", "01"].map((d) => run(`2026-10-${d}`, ["catalog"]));
  const sixRuns = [...days, run("2026-09-30", ["catalog"])];
  const sevenRuns = [...sixRuns, run("2026-09-29", ["catalog"])];

  const atSeven = gate(report("RED", ["catalog"]), sixRuns);
  assert.equal(atSeven.send, true);
  assert.equal(atSeven.reason, "weekly reminder: catalog RED for 7 scheduled runs");

  assert.equal(gate(report("RED", ["catalog"]), sevenRuns).send, false);
});

test("gate: an HTTP run sends no weekly reminder, because it adds nothing to the streak", () => {
  const history = ["05", "04", "03", "02", "01"].map((d) => run(`2026-10-${d}`, ["catalog"]));
  history.push(run("2026-09-30", ["catalog"]), run("2026-09-29", ["catalog"]));
  const g = gate(report("RED", ["catalog"]), history, { triggerKind: "http" });
  assert.equal(g.send, false);
  assert.match(g.reason, /catalog streak 7/);
});

test("gate: force_slack=true sends the DM even when nothing changed", () => {
  const history = [run("2026-10-05", [])];
  const g = gate(report("GREEN", []), history, { force: true });
  assert.deepEqual(g, { send: true, reason: "force_slack=true" });
});

test("gate: GREEN after GREEN and YELLOW after YELLOW send no DM", () => {
  const green = gate(report("GREEN", []), [run("2026-10-05", [])]);
  assert.equal(green.send, false);
  assert.equal(green.reason, "status GREEN unchanged from the 2026-10-05 run, no RED area");

  const yellow = gate(report("YELLOW", []), [run("2026-10-05", [], { status: "YELLOW" })]);
  assert.equal(yellow.send, false);
});

test("gate: with no earlier scheduled run, the old rule applies: any status but GREEN sends", () => {
  const httpOnly = [run("2026-10-05", ["tiktok"], { kind: "http" })];
  for (const history of [[], undefined, httpOnly]) {
    assert.equal(gate(report("RED", ["tiktok"]), history).send, true);
    assert.equal(gate(report("YELLOW", []), history).send, true);
    assert.equal(gate(report("GREEN", []), history).send, false);
  }
  assert.match(gate(report("RED", ["tiktok"]), []).reason, /no earlier scheduled run/);
});

// ── What applySaturation writes into the report ──────────────────────────

test("apply: each RED alert carries streak_days; other alerts are left alone", () => {
  const history = [run("2026-10-05", ["catalog"]), run("2026-10-04", ["catalog"])];
  const rep = {
    overall_status: "RED",
    alerts: [
      { severity: "RED", area: "Catalog", summary: "stale" },
      { severity: "WARN", area: "ingestion", summary: "low" },
      { severity: "RED", area: "tiktok", summary: "stale" },
    ],
    slack_summary_md: "body",
  };
  const out = applySaturation(rep, { history, triggerKind: "cron", force: false });
  assert.deepEqual(out.alerts, [
    { severity: "RED", area: "Catalog", summary: "stale", streak_days: 3 },
    { severity: "WARN", area: "ingestion", summary: "low" },
    { severity: "RED", area: "tiktok", summary: "stale", streak_days: 1 },
  ]);
  assert.deepEqual(out.saturation.red_areas, ["catalog", "tiktok"]);
  assert.deepEqual(out.saturation.streaks, { catalog: 3, tiktok: 1 });
  assert.equal(out.saturation.previous_run.evaluated_at, "2026-10-05 13:01:00");
});

test("apply: the Slack summary opens with each RED area and its streak; a new RED reads 'new'", () => {
  const history = [run("2026-10-05", ["catalog"]), run("2026-10-04", ["catalog"])];
  const out = applySaturation(report("RED", ["tiktok", "catalog"]), { history, triggerKind: "cron", force: false });
  assert.equal(out.slack_summary_md, "*RED areas:* catalog (day 3) · tiktok (new)\n\nbody");
});

test("apply: an HTTP run shows a RED that the last scheduled run did not have as 'new'", () => {
  const history = [run("2026-10-05", ["catalog"])];
  const out = applySaturation(report("RED", ["tiktok", "catalog"]), { history, triggerKind: "http", force: false });
  assert.equal(out.alerts.find((a) => a.area === "tiktok").streak_days, 0);
  assert.match(out.slack_summary_md, /^\*RED areas:\* catalog \(day 1\) · tiktok \(new\)/);
});

test("apply: with no RED alert the Slack summary is unchanged", () => {
  const out = applySaturation(report("YELLOW", []), { history: [], triggerKind: "cron", force: false });
  assert.equal(out.slack_summary_md, "body");
  assert.deepEqual(out.saturation.red_areas, []);
});

test("apply: a RED alert with no area is tracked under 'unknown'", () => {
  const rep = { overall_status: "RED", alerts: [{ severity: "RED", summary: "?" }] };
  const out = applySaturation(rep, { history: [], triggerKind: "cron", force: false });
  assert.equal(out.alerts[0].streak_days, 1);
  assert.deepEqual(out.saturation.red_areas, ["unknown"]);
});

test("apply does not mutate its input, and tolerates a missing report", () => {
  const rep = report("RED", ["tiktok"]);
  const copy = structuredClone(rep);
  applySaturation(rep, { history: [run("2026-10-05", ["tiktok"])], triggerKind: "cron", force: false });
  assert.deepEqual(rep, copy);

  const empty = applySaturation(undefined, { history: [], triggerKind: "cron", force: false });
  assert.deepEqual(empty.saturation.red_areas, []);
});
