// Ecomm Agent — the poll tick (CRMA-778, epic CRMA-772).
//
// Cloud Scheduler cannot enumerate trends, so it fires ONE request and the
// service owns the loop. This module is that loop: claim a batch via the
// anti-join, then source each claimed trend through exactly the same
// fetchContext -> runSourcing path a manual POST /source takes. There is no
// second sourcing implementation here, and there must never be one — a poll
// that sourced differently from a manual fire would make every manual
// reproduction of a poll bug meaningless.
//
// The loop is SEQUENTIAL. Concurrency is tempting (25 trends x ~20s is most of
// a tick's budget) but each run opens roughly five Snowflake connections of its
// own — see the known follow-up in snowflake.mjs — so a parallel batch would
// multiply that against a warehouse the whole pipeline shares, to save time the
// budget already accounts for.

import { randomUUID } from "node:crypto";
import {
  hasBudgetRemaining,
  POLL_WALL_CLOCK_BUDGET_MS,
  STALE_RUNNING_MINUTES,
  summarizePoll,
  summarizeRun,
} from "../lib/sourcing_poll.mjs";
import { fetchContext } from "./fetch_context.mjs";
import { fetchPollBatch } from "./fetch_poll_batch.mjs";
import { normalizeEvent, TIER } from "./normalize_event.mjs";
import { runSourcing } from "./run_sourcing.mjs";

// { config, limit, now?, budgetMs? } -> the tick receipt (see summarizePoll).
export async function runPoll({ config, limit, now = () => Date.now(), budgetMs = POLL_WALL_CLOCK_BUDGET_MS }) {
  const startedAtMs = now();

  // One chain id for the whole tick, so every run it fires can be recovered
  // together from STG_AGENT_RUN_COSTS and the ledger afterwards. Each trend
  // still gets its own agent_session_id, generated per run by normalizeEvent.
  const chain_id = `ecomm-poll-${randomUUID()}`;

  const batch = await fetchPollBatch({
    connOpts: config.snowflake,
    tier: TIER,
    staleMinutes: STALE_RUNNING_MINUTES,
    limit,
  });
  console.log(`ecomm-agent poll: chain=${chain_id} claimed=${batch.length} limit=${limit}`);

  const runs = [];
  let budgetExhausted = false;

  for (const claim of batch) {
    if (!hasBudgetRemaining({ startedAtMs, nowMs: now(), budgetMs })) {
      // Stop STARTING work; the trends left unclaimed keep no state and the
      // next tick re-claims them, because nothing was written for them here.
      budgetExhausted = true;
      console.log(
        `ecomm-agent poll: chain=${chain_id} wall-clock budget spent after ${runs.length}/${batch.length}; leaving the rest for the next tick`,
      );
      break;
    }

    runs.push(await sourceOne(config, claim.trend_id, chain_id));
  }

  const receipt = summarizePoll({ claimed: batch.length, runs, budgetExhausted });
  console.log(
    `ecomm-agent poll: chain=${chain_id} processed=${receipt.processed}/${receipt.claimed} ` +
      `outcomes=${JSON.stringify(receipt.outcomes)} selected_products=${receipt.selected_products}`,
  );
  return { ...receipt, chain_id };
}

// One trend, never allowed to abort the tick. runSourcing() already converts
// its own failures into a recorded 'failed' header and returns a receipt, so
// reaching this catch means something outside the run broke — most plausibly
// fetchContext losing Snowflake. That is worth recording against the trend and
// moving on: the trend has no header from this attempt, so the next tick simply
// re-claims it.
async function sourceOne(config, trend_id, chain_id) {
  try {
    const evt = normalizeEvent({ trend_id, chain_id });
    const ctx = await fetchContext({ connOpts: config.snowflake, trend_id: evt.trend_id, tier: evt.tier });
    const result = await runSourcing({ connOpts: config.snowflake, apiKey: config.geminiApiKey, evt, ctx });
    return summarizeRun(trend_id, result);
  } catch (err) {
    console.error(`ecomm-agent poll: trend=${trend_id} threw outside the run: ${err.stack || err.message}`);
    return summarizeRun(trend_id, {
      decision: "failed",
      outcome: "failed",
      error_message: String(err.message || err),
    });
  }
}
