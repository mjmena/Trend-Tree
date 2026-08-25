// Tests for services/lib/sourcing_poll.mjs (CRMA-778, epic CRMA-772).
// Run: scripts/test_services_lib.sh  (node --test services/lib/*.test.mjs)
//
// The anti-join itself is SQL and is tested against real fixtures in
// test/sourcing_poll.test.sql — a node test cannot prove which trends Snowflake
// returns. What is proved here is everything the tick decides on its own: how
// big a claim it will take, when it stops starting work, and what it reports.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasBudgetRemaining,
  normalizePollRequest,
  POLL_BATCH_LIMIT,
  POLL_WALL_CLOCK_BUDGET_MS,
  STALE_RUNNING_MINUTES,
  summarizePoll,
  summarizeRun,
} from "./sourcing_poll.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const run = (over = {}) => ({
  decision: "completed",
  outcome: "matched",
  sourcing_run_id: "run-1",
  candidates: [{ selected: true }, { selected: false }],
  ...over,
});

// ---------------------------------------------------------------------------
// Constants sanity — these three are the contract CRMA-778 settled on, and
// each is load-bearing somewhere outside this file.
// ---------------------------------------------------------------------------

test("the settled constants match the story: 25 trends a tick, a 30-minute staleness window, and a budget under the 900s request timeout", () => {
  assert.equal(POLL_BATCH_LIMIT, 25);
  assert.equal(STALE_RUNNING_MINUTES, 30);
  assert.ok(
    POLL_WALL_CLOCK_BUDGET_MS < 900_000,
    "the budget must leave room for the in-flight trend to finish before Cloud Run's timeout kills the request",
  );
});

// ---------------------------------------------------------------------------
// normalizePollRequest — a caller may narrow a tick, never widen it
// ---------------------------------------------------------------------------

test("an empty body claims the full batch, so Cloud Scheduler can POST {} and get the intended behaviour", () => {
  assert.equal(normalizePollRequest({}).limit, POLL_BATCH_LIMIT);
  assert.equal(normalizePollRequest(null).limit, POLL_BATCH_LIMIT);
  assert.equal(normalizePollRequest(undefined).limit, POLL_BATCH_LIMIT);
});

test("a caller may narrow the claim, which is how a human watches a small batch before letting a full tick run", () => {
  assert.equal(normalizePollRequest({ limit: 3 }).limit, 3);
  assert.equal(normalizePollRequest({ limit: 1 }).limit, 1);
});

test("a caller asking for MORE than the batch limit is capped, not honoured — batch size follows the request timeout, not caller preference", () => {
  assert.equal(normalizePollRequest({ limit: 500 }).limit, POLL_BATCH_LIMIT);
});

test("a limit that is not a positive integer is refused outright rather than coerced into a surprising claim size", () => {
  assert.throws(() => normalizePollRequest({ limit: 0 }), RangeError);
  assert.throws(() => normalizePollRequest({ limit: -5 }), RangeError);
  assert.throws(() => normalizePollRequest({ limit: 2.5 }), RangeError);
  assert.throws(() => normalizePollRequest({ limit: "many" }), RangeError);
});

// ---------------------------------------------------------------------------
// hasBudgetRemaining — the guard that keeps a tick from being killed mid-run
// ---------------------------------------------------------------------------

test("the budget is open at the start of a tick and closed once it has elapsed", () => {
  assert.equal(hasBudgetRemaining({ startedAtMs: 0, nowMs: 0, budgetMs: 1000 }), true);
  assert.equal(hasBudgetRemaining({ startedAtMs: 0, nowMs: 999, budgetMs: 1000 }), true);
  assert.equal(hasBudgetRemaining({ startedAtMs: 0, nowMs: 1000, budgetMs: 1000 }), false);
  assert.equal(hasBudgetRemaining({ startedAtMs: 0, nowMs: 5000, budgetMs: 1000 }), false);
});

// ---------------------------------------------------------------------------
// summarizeRun — one trend, reduced to what a tick's reader can act on
// ---------------------------------------------------------------------------

test("a matched run reports its selected count separately from the candidates it considered and rejected", () => {
  const s = summarizeRun("t-1", run());
  assert.equal(s.trend_id, "t-1");
  assert.equal(s.outcome, "matched");
  assert.equal(s.selected_count, 1);
  assert.equal(s.candidate_count, 2);
});

test("a freshness decline reports outcome 'not_sourced' and carries its reason, so a stale catalog is legible in the tick receipt", () => {
  const s = summarizeRun("t-2", { decision: "declined", reason: "catalog MAX(LAST_SEEN_AT) is 9 days old" });
  assert.equal(s.decision, "declined");
  assert.equal(s.outcome, "not_sourced");
  assert.match(s.error_message, /9 days old/);
  assert.equal(s.selected_count, 0);
});

test("the full candidate array is NOT carried into the summary — 25 of them would bloat a tick's response, and they are already in FCT_TREND_SOURCING_CANDIDATES", () => {
  const s = summarizeRun("t-3", run());
  assert.equal(s.candidates, undefined);
});

// ---------------------------------------------------------------------------
// summarizePoll — the tick receipt
// ---------------------------------------------------------------------------

test("outcomes are tallied per kind and selected products summed across the whole tick", () => {
  const runs = [
    summarizeRun("t-1", run()),
    summarizeRun("t-2", run({ candidates: [{ selected: true }, { selected: true }] })),
    summarizeRun("t-3", run({ outcome: "no_match", candidates: [] })),
  ];
  const r = summarizePoll({ claimed: 3, runs, budgetExhausted: false });

  assert.deepEqual(r.outcomes, { matched: 2, no_match: 1 });
  assert.equal(r.selected_products, 3);
  assert.equal(r.processed, 3);
  assert.equal(r.remaining, 0);
  assert.equal(r.budget_exhausted, false);
});

test("a declined run is counted as 'declined', never folded into 'not_sourced' — a stale catalog must stay distinguishable from a selector that read the pool and rejected it", () => {
  const runs = [
    summarizeRun("t-1", { decision: "declined", reason: "stale catalog" }),
    summarizeRun("t-2", run({ outcome: "no_match", candidates: [] })),
  ];
  const r = summarizePoll({ claimed: 2, runs, budgetExhausted: false });

  assert.deepEqual(r.outcomes, { declined: 1, no_match: 1 });
});

test("a tick cut short by its budget reports what it never started, so the gap is visible rather than silently dropped", () => {
  const runs = [summarizeRun("t-1", run())];
  const r = summarizePoll({ claimed: 25, runs, budgetExhausted: true });

  assert.equal(r.claimed, 25);
  assert.equal(r.processed, 1);
  assert.equal(r.remaining, 24);
  assert.equal(r.budget_exhausted, true);
});

test("an empty claim is a valid, quiet tick — nothing to source is the steady state once the backlog has drained", () => {
  const r = summarizePoll({ claimed: 0, runs: [], budgetExhausted: false });

  assert.equal(r.claimed, 0);
  assert.equal(r.processed, 0);
  assert.equal(r.remaining, 0);
  assert.deepEqual(r.outcomes, {});
  assert.equal(r.selected_products, 0);
});
