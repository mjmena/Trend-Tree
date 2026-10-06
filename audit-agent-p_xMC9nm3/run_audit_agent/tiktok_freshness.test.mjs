// Tests for the CRMA-1338 tiktok-freshness grading helper.
// Run: node --test audit-agent-p_xMC9nm3/run_audit_agent/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_HOURS,
  gradeTiktokFreshness,
  applyTiktokFinding,
} from "./tiktok_freshness.mjs";

const row = (minutes, embedded24h = 0) => ({
  MINUTES_SINCE_LAST_EMBEDDED: minutes,
  EMBEDDED_24H: embedded24h,
});

test("the window is 25 hours: a failed 09:00 run shows RED at the 13:00 UTC audit", () => {
  assert.equal(WINDOW_HOURS, 25);
});

test("GREEN when the newest tiktok row embedded inside the window", () => {
  const g = gradeTiktokFreshness([row(4 * 60, 37)]);
  assert.equal(g.status, "GREEN");
  assert.equal(g.hours_since_last_embedded, 4);
  assert.equal(g.embedded_24h, 37);
});

test("GREEN at exactly the window edge", () => {
  assert.equal(gradeTiktokFreshness([row(WINDOW_HOURS * 60)]).status, "GREEN");
});

test("RED one minute past the window — a missed daily run", () => {
  assert.equal(gradeTiktokFreshness([row(WINDOW_HOURS * 60 + 1)]).status, "RED");
});

test("RED when no tiktok row ever embedded (NULL age), not read as 0 minutes", () => {
  const g = gradeTiktokFreshness([row(null)]);
  assert.equal(g.status, "RED");
  assert.equal(g.hours_since_last_embedded, null);
});

test("RED when the query returned no row at all", () => {
  assert.equal(gradeTiktokFreshness([]).status, "RED");
  assert.equal(gradeTiktokFreshness(undefined).status, "RED");
});

test("RED on a negative age (EMBEDDED_AT in the future)", () => {
  assert.equal(gradeTiktokFreshness([row(-5)]).status, "RED");
});

test("apply GREEN: adds report.tiktok, leaves alerts, status and Slack text alone", () => {
  const base = { overall_status: "YELLOW", alerts: [{ area: "cost" }], slack_summary_md: "hi" };
  const out = applyTiktokFinding(base, gradeTiktokFreshness([row(60, 5)]));
  assert.equal(out.tiktok.status, "GREEN");
  assert.equal(out.overall_status, "YELLOW");
  assert.deepEqual(out.alerts, [{ area: "cost" }]);
  assert.equal(out.slack_summary_md, "hi");
});

test("apply RED: one tiktok alert, escalates overall_status, adds a Slack line", () => {
  const base = { overall_status: "GREEN", alerts: [], slack_summary_md: "all good" };
  const out = applyTiktokFinding(base, gradeTiktokFreshness([row(27 * 60)]));
  assert.equal(out.tiktok.status, "RED");
  assert.equal(out.overall_status, "RED");
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].severity, "RED");
  assert.equal(out.alerts[0].area, "tiktok");
  assert.match(out.alerts[0].evidence, /EMBEDDED_AT/);
  assert.match(out.slack_summary_md, /^all good\n\n🔴 \*TikTok\*/);
});

test("apply does not mutate its input", () => {
  const base = { overall_status: "GREEN", alerts: [] };
  applyTiktokFinding(base, gradeTiktokFreshness([]));
  assert.deepEqual(base, { overall_status: "GREEN", alerts: [] });
});
