// Promotion Lead — normalize_event
//
// Both the HTTP trigger and the scheduled cron trigger land here. Normalizes
// the trigger payload into a single shape used by every downstream step:
//
//   {
//     chain_id,               // groups all iterations of one run
//     iteration,              // pass number within the chain
//     max_iterations,         // hard stop for self-loop (default 2)
//     budget_usd,             // total LLM budget across the chain
//     budget_remaining_usd,   // budget left for this iteration onward
//     dry_run,                // if true, no subagent dispatches and no DB writes
//     max_candidates,         // cap on candidates per run (default 15)
//   }
//
// For HTTP self-retrigger calls, fields come from the POST body.
// For scheduled/manual runs with no body, defaults seed a fresh chain.

import { randomUUID } from "crypto";

const DEFAULTS = {
  max_iterations: 2,
  budget_usd: 1.50,
  dry_run: false,
  max_candidates: 15,
  max_candidates_cap: 50,
};

function coerceBool(v, fallback) {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return fallback;
}

function coerceNum(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default defineComponent({
  name: "Promotion: normalize event",
  description: "Normalize HTTP body / scheduled event into a common payload shape",
  version: "0.0.2",
  props: {
    trigger_event: {
      type: "any",
      label: "Full trigger event",
      description: "steps.trigger.event — shape varies by trigger type",
    },
  },
  async run() {
    const body =
      this.trigger_event?.body ??
      this.trigger_event ??
      {};

    const chain_id = body.chain_id || `chain-${randomUUID()}`;
    const iteration = Math.max(1, coerceNum(body.iteration, 1));
    const max_iterations = Math.max(1, coerceNum(body.max_iterations, DEFAULTS.max_iterations));
    const budget_usd = Math.max(0, coerceNum(body.budget_usd, DEFAULTS.budget_usd));
    const budget_remaining_usd = Math.max(
      0,
      coerceNum(body.budget_remaining_usd, budget_usd),
    );
    const dry_run = coerceBool(body.dry_run, DEFAULTS.dry_run);
    const max_candidates = Math.min(
      DEFAULTS.max_candidates_cap,
      Math.max(1, coerceNum(body.max_candidates, DEFAULTS.max_candidates)),
    );

    const out = {
      chain_id,
      iteration,
      max_iterations,
      budget_usd,
      budget_remaining_usd,
      dry_run,
      max_candidates,
    };

    console.log(
      `promotion event: chain=${chain_id} iter=${iteration}/${max_iterations} budget=$${budget_remaining_usd.toFixed(2)}/$${budget_usd.toFixed(2)} dry_run=${dry_run} max_candidates=${max_candidates}`,
    );

    return out;
  },
});
