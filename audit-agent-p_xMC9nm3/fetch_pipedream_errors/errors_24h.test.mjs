// Tests for the CRMA-1031 true-24h-error-count helper.
// Run: node --test audit-agent-p_xMC9nm3/fetch_pipedream_errors/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_LIMIT, buildErrors24h } from "./errors_24h.mjs";

const NOW = 1_791_300_000_000;
const HOUR = 3600_000;
const SINCE = NOW - 24 * HOUR;

// One $errors/event_summaries row, `hoursAgo` old. The API returns newest first.
const summary = (i, hoursAgo) => ({
  id: `${NOW - hoursAgo * HOUR}-${i}`,
  indexed_at_ms: NOW - hoursAgo * HOUR,
});

test("a workflow with 37 errors in 24h reports 37, not the old cap of 10", () => {
  const summaries = [
    ...Array.from({ length: 37 }, (_, i) => summary(i, 1 + i * 0.5)),
    ...Array.from({ length: 20 }, (_, i) => summary(100 + i, 30 + i)),
  ];
  const out = buildErrors24h({ summaries, sinceMs: SINCE });
  assert.equal(out.errors_24h_count, 37);
  assert.equal(out.errors_24h.length, 37);
  assert.equal(out.errors_24h_truncated, false);
});

test("a full page that sits wholly inside 24h is truncated: the true count is at least 100", () => {
  const summaries = Array.from({ length: PAGE_LIMIT }, (_, i) => summary(i, i * 0.2));
  const out = buildErrors24h({ summaries, sinceMs: SINCE });
  assert.equal(out.errors_24h_count, 100);
  assert.equal(out.errors_24h_truncated, true);
});

test("the newest errors carry code, msg and cell_id from the detail rows; the rest carry null", () => {
  const summaries = [summary(0, 1), summary(1, 2), summary(2, 3)];
  const detailed = [
    {
      ...summaries[0],
      event: {
        error: { code: "Error", msg: "Gemini fetch failed (turn 2): socket hang up" },
        original_context: { cell_id: "c_abc123" },
      },
    },
  ];
  const out = buildErrors24h({ summaries, detailed, sinceMs: SINCE });
  assert.equal(out.errors_24h_count, 3);
  assert.deepEqual(
    out.errors_24h.map((e) => [e.code, e.msg, e.cell_id]),
    [
      ["Error", "Gemini fetch failed (turn 2): socket hang up", "c_abc123"],
      [null, null, null],
      [null, null, null],
    ],
  );
});

test("a detail msg longer than 400 characters is cut to 400", () => {
  const summaries = [summary(0, 1)];
  const detailed = [{ ...summaries[0], event: { error: { msg: "x".repeat(900) } } }];
  const out = buildErrors24h({ summaries, detailed, sinceMs: SINCE });
  assert.equal(out.errors_24h[0].msg.length, 400);
});

test("a row with no timestamp counts as inside the window", () => {
  const out = buildErrors24h({ summaries: [{ id: "no-ts" }, summary(1, 30)], sinceMs: SINCE });
  assert.equal(out.errors_24h_count, 1);
  assert.equal(out.errors_24h[0].event_id, "no-ts");
});

test("no rows at all is a count of 0", () => {
  assert.equal(buildErrors24h({ summaries: [], sinceMs: SINCE }).errors_24h_count, 0);
  assert.equal(buildErrors24h({ summaries: undefined, sinceMs: SINCE }).errors_24h_count, 0);
});

test("a full page whose oldest row is older than 24h is a true count", () => {
  const summaries = [
    ...Array.from({ length: 99 }, (_, i) => summary(i, i * 0.2)),
    summary(99, 25),
  ];
  const out = buildErrors24h({ summaries, sinceMs: SINCE });
  assert.equal(out.errors_24h_count, 99);
  assert.equal(out.errors_24h_truncated, false);
});
