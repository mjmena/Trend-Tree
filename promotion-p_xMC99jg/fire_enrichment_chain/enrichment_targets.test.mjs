// Tests for the CRMA-1032 enrichment-retry selection helper.
// Run: node --test promotion-p_xMC99jg/fire_enrichment_chain/enrichment_targets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETRY_FIRST_HOUR,
  MAX_RETRIES_PER_RUN,
  extractPromotedTrendIds,
  isRetryDue,
  selectRetryTrendIds,
  buildDispatchTargets,
} from "./enrichment_targets.mjs";

const applyResult = (results) => [{ PROC_PROMOTION_APPLY: JSON.stringify({ results }) }];
const stuck = (trend_id, hours) => ({ TREND_ID: trend_id, HOURS_SINCE_PROMOTED: hours });

// ---------------------------------------------------------------------------
// extractPromotedTrendIds — unchanged behaviour, moved out of entry.mjs
// ---------------------------------------------------------------------------

test("extracts only ok PROMOTE_NEW decisions with a target_trend_id", () => {
  const ids = extractPromotedTrendIds(
    applyResult([
      { status: "ok", decision: "PROMOTE_NEW", target_trend_id: "t1" },
      { status: "ok", decision: "MERGE", target_trend_id: "t2" },
      { status: "error", decision: "PROMOTE_NEW", target_trend_id: "t3" },
      { status: "ok", decision: "PROMOTE_NEW" },
    ]),
  );
  assert.deepEqual(ids, ["t1"]);
});

test("accepts a single-object apply_result and an already-parsed VARIANT", () => {
  const ids = extractPromotedTrendIds({
    PROC_PROMOTION_APPLY: { results: [{ status: "ok", decision: "PROMOTE_NEW", target_trend_id: "t1" }] },
  });
  assert.deepEqual(ids, ["t1"]);
});

test("returns no ids for an empty or unparseable apply_result", () => {
  assert.deepEqual(extractPromotedTrendIds(undefined), []);
  assert.deepEqual(extractPromotedTrendIds([]), []);
  assert.deepEqual(extractPromotedTrendIds([{ PROC_PROMOTION_APPLY: "{not json" }]), []);
});

// ---------------------------------------------------------------------------
// isRetryDue — first retry at hour 6, then once every 24 hours
// ---------------------------------------------------------------------------

test("the first retry is due 6 hours after promotion, matching the audit's stuck threshold", () => {
  assert.equal(RETRY_FIRST_HOUR, 6);
  assert.equal(isRetryDue(5), false);
  assert.equal(isRetryDue(6), true);
});

test("the retry window is 3 hours wide, so one 3-hour promotion run lands in it", () => {
  assert.deepEqual([6, 7, 8, 9].map(isRetryDue), [true, true, true, false]);
});

test("the retry window repeats every 24 hours", () => {
  assert.deepEqual([29, 30, 32, 33].map(isRetryDue), [false, true, true, false]);
  assert.equal(isRetryDue(6 + 24 * 137), true);
});

test("a promotion run every 3 hours hits the window exactly once per day", () => {
  for (let start = 0; start < 3; start++) {
    const hits = [];
    for (let h = start; h < 6 + 24 * 3; h += 3) if (isRetryDue(h)) hits.push(h);
    assert.equal(hits.length, 3, `start=${start} hits=${hits}`);
  }
});

test("a 3-hour run at any fractional phase hits the window once per day", () => {
  for (const start of [0.1, 1.55, 2.95]) {
    const hits = [];
    for (let run = 0; run < 25; run++) {
      const h = start + run * 3;
      if (isRetryDue(h)) hits.push(h);
    }
    assert.equal(hits.length, 3, `start=${start} hits=${hits}`);
  }
});

test("accepts fractional hours from the minutes / 60 query column", () => {
  assert.equal(isRetryDue(5.99), false);
  assert.equal(isRetryDue(6.0), true);
  assert.equal(isRetryDue(8.99), true);
  assert.equal(isRetryDue(9.0), false);
});

test("coerces the Snowflake numeric string and rejects junk", () => {
  assert.equal(isRetryDue("30"), true);
  assert.equal(isRetryDue(null), false);
  assert.equal(isRetryDue("abc"), false);
});

// ---------------------------------------------------------------------------
// selectRetryTrendIds — gates and cap
// ---------------------------------------------------------------------------

test("selects stuck trends whose retry is due, in row order", () => {
  const ids = selectRetryTrendIds([stuck("a", 6), stuck("b", 12), stuck("c", 31)], { iteration: 1 });
  assert.deepEqual(ids, ["a", "c"]);
});

test("does not retry on a self-retriggered iteration, whose first-iteration chain is still running", () => {
  assert.deepEqual(selectRetryTrendIds([stuck("a", 6)], { iteration: 2 }), []);
  assert.deepEqual(selectRetryTrendIds([stuck("a", 6)], { iteration: "2" }), []);
});

test("does not retry on a dry run", () => {
  assert.deepEqual(selectRetryTrendIds([stuck("a", 6)], { iteration: 1, dryRun: true }), []);
  assert.deepEqual(selectRetryTrendIds([stuck("a", 6)], { iteration: 1, dryRun: "true" }), []);
});

test("caps retries per run so a pipeline-wide outage does not fan out at once", () => {
  const rows = Array.from({ length: MAX_RETRIES_PER_RUN + 3 }, (_, i) => stuck(`t${i}`, 6));
  assert.equal(selectRetryTrendIds(rows, { iteration: 1 }).length, MAX_RETRIES_PER_RUN);
});

test("the cap keeps the youngest due trends, so old failures cannot starve a new one", () => {
  const rows = [stuck("new", 6.5), ...Array.from({ length: 8 }, (_, i) => stuck(`old${i}`, 30 + 24 * i))];
  const ids = selectRetryTrendIds(rows, { iteration: 1 });
  assert.equal(ids[0], "new");
  assert.equal(ids.length, MAX_RETRIES_PER_RUN);
});

test("tolerates a missing or non-array query result", () => {
  assert.deepEqual(selectRetryTrendIds(undefined, { iteration: 1 }), []);
  assert.deepEqual(selectRetryTrendIds({}, { iteration: 1 }), []);
  assert.deepEqual(selectRetryTrendIds([{ HOURS_SINCE_PROMOTED: 6 }], { iteration: 1 }), []);
});

// ---------------------------------------------------------------------------
// buildDispatchTargets — promoted first, retries deduplicated
// ---------------------------------------------------------------------------

test("tags each target with why it is dispatched and drops duplicate retries", () => {
  assert.deepEqual(buildDispatchTargets(["p1"], ["r1", "p1"]), [
    { trend_id: "p1", reason: "promoted" },
    { trend_id: "r1", reason: "retry" },
  ]);
});
