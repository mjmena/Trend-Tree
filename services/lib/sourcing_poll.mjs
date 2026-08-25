// Ecomm Agent — the poll's pure logic (CRMA-778, epic CRMA-772).
//
// Everything here is side-effect free and time-injectable, for the same reason
// services/lib/sourcing_run.mjs is: the Snowflake read and the batch loop live
// in services/ecomm-agent/ where the SQL tests reach them, and the decisions
// those two make live here where node:test reaches them without a database.
//
// The poll exists because Cloud Scheduler cannot enumerate trends. It fires one
// tick at POST /poll and the SERVICE owns the loop — see the endpoint's own
// header in server.mjs. This module owns three decisions inside that loop:
// how many trends a tick may claim, when a tick must stop starting new work,
// and what a finished tick reports.

// The tick's claim size. Bounded because a tick is one HTTP request against a
// 900s Cloud Run timeout, and an unbounded first tick would try to drain the
// entire ~443-trend backlog in one request and be killed mid-batch.
export const POLL_BATCH_LIMIT = 25;

// A 'running' header older than this is stale and re-takeable. PROC_SOURCING_APPLY
// deliberately does NOT dedupe or expire concurrent 'running' headers for a
// (TREND_ID, TIER) — its own header comment names that as the poll's job — so
// this constant is the only thing standing between a crashed run and a trend
// parked forever. It is spent in the anti-join (see sql/sourcing_poll_query.sql).
export const STALE_RUNNING_MINUTES = 30;

// Stop STARTING new trends once a tick has been running this long. Deliberately
// well under the service's 900s request timeout: the check happens before each
// trend, and the trend already in flight still needs its own ~20s to finish and
// write its ledger rows. Being killed by Cloud Run mid-run is the one outcome
// worth engineering against, because it leaves a 'running' header that then has
// to age out through STALE_RUNNING_MINUTES before anything retries it.
export const POLL_WALL_CLOCK_BUDGET_MS = 600_000;

// A tick's claim may be narrowed by the caller, never widened. A human firing a
// one-off `{"limit": 3}` to watch a small batch is the reason this exists; a
// caller asking for 500 is refused rather than honoured, because the batch size
// is a property of the request timeout, not a caller preference.
export function normalizePollRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  let limit = POLL_BATCH_LIMIT;

  if (b.limit !== undefined && b.limit !== null) {
    const n = Number(b.limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`limit must be a positive integer; got ${JSON.stringify(b.limit)}`);
    }
    limit = Math.min(n, POLL_BATCH_LIMIT);
  }

  return { limit };
}

// True while the tick may start another trend. Time is a parameter, not a
// Date.now() call, so the budget is testable without waiting ten minutes.
export function hasBudgetRemaining({ startedAtMs, nowMs, budgetMs = POLL_WALL_CLOCK_BUDGET_MS }) {
  return nowMs - startedAtMs < budgetMs;
}

// One finished trend, reduced to the fields a tick's caller can act on. The
// full receipt (with every candidate) is deliberately NOT carried here: 25 of
// them would make a tick's response enormous, and the candidates are already
// persisted in FCT_TREND_SOURCING_CANDIDATES, which is where anything reading
// them should read them.
export function summarizeRun(trend_id, result) {
  const r = result || {};
  const candidates = Array.isArray(r.candidates) ? r.candidates : [];
  return {
    trend_id,
    decision: r.decision || "unknown",
    outcome: r.outcome || (r.decision === "declined" ? "not_sourced" : null),
    sourcing_run_id: r.sourcing_run_id || null,
    selected_count: candidates.filter((c) => c.selected).length,
    candidate_count: candidates.length,
    error_message: r.error_message ?? r.reason ?? null,
  };
}

// The tick receipt. `remaining` is what the tick claimed but never started —
// non-zero only when the wall-clock budget cut the loop short — and it is
// reported rather than retried in-process, because the next tick's anti-join
// will re-claim exactly those trends anyway.
export function summarizePoll({ claimed, runs, budgetExhausted }) {
  const outcomes = {};
  let selectedProducts = 0;

  for (const run of runs) {
    // A declined run has no outcome of its own — the catalog freshness gate
    // stopped it before a header was ever written — so it is counted under its
    // decision instead. Folding it into 'not_sourced' would make a stale
    // catalog indistinguishable from a selector that read the pool and
    // rejected it, which is the exact distinction a tick's reader needs.
    const key = run.decision === "declined" ? "declined" : run.outcome || run.decision;
    outcomes[key] = (outcomes[key] || 0) + 1;
    selectedProducts += run.selected_count;
  }

  return {
    claimed,
    processed: runs.length,
    remaining: claimed - runs.length,
    budget_exhausted: Boolean(budgetExhausted),
    outcomes,
    selected_products: selectedProducts,
    runs,
  };
}
