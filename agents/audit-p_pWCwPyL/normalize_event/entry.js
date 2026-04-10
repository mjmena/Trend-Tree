// Audit Agent — normalize_event
//
// Both the HTTP trigger (hi_wWHgdBQ) and the scheduled trigger (ti_WmT1Aen)
// land here. This step normalizes the trigger payload into a single shape
// used by every downstream step:
//
//   {
//     chain_id,               // groups all iterations of one run
//     iteration,              // pass number within the chain
//     max_iterations,         // hard stop for self-loop
//     budget_usd,             // total LLM budget across the chain
//     budget_remaining_usd,   // budget left for this iteration onward
//     dry_run,                // if true, llm_plan proposes nothing to act on
//   }
//
// For HTTP self-retrigger calls, fields come from the POST body.
// For scheduled/manual runs with no body, defaults seed a fresh chain.

import { randomUUID } from "crypto";

const DEFAULTS = {
  max_iterations: 5,
  budget_usd: 0.50,
  dry_run: false,
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
  name: "Audit: normalize event",
  description: "Normalize HTTP body / scheduled event into a common payload shape",
  version: "0.0.1",
  props: {
    trigger_event: {
      type: "any",
      label: "Full trigger event",
      description: "steps.trigger.event — shape varies by trigger type",
    },
  },
  async run() {
    const body =
      this.trigger_event?.body ??      // HTTP trigger
      this.trigger_event ??            // scheduled trigger passes the event through
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

    const out = {
      chain_id,
      iteration,
      max_iterations,
      budget_usd,
      budget_remaining_usd,
      dry_run,
    };

    console.log(
      `audit event: chain=${chain_id} iter=${iteration}/${max_iterations} budget=$${budget_remaining_usd.toFixed(2)}/$${budget_usd.toFixed(2)} dry_run=${dry_run}`,
    );

    return out;
  },
});
