// Distillation Lead — normalize_event
//
// Both the cron trigger and a manual HTTP POST land here. Produces a
// normalized inputs object used by every downstream step. For HTTP
// self-retrigger calls (Phase 1 doesn't use these yet, but the chain_id /
// iteration / budget primitives are wired so we can flip on a workflow-
// level loop later if needed), fields come from the POST body. For
// scheduled cron runs with no body, defaults seed a fresh chain.

import { randomUUID } from "crypto";

const DEFAULTS = {
  cursor_name: "distillation_main",
  max_iterations: 1,           // Phase 1: single-pass loop per cron tick
  budget_usd: 5.0,             // hard cap for the lead's API spend per run
  per_call_max_tokens: 8192,
  thinking_budget_tokens: 5000,
  dry_run: false,
};

// Downstream SQL steps paste these IDs inside quotes (CRMA-1445).
function checkId(name, v) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error(`invalid ${name}: ${JSON.stringify(v).slice(0, 80)}`);
  return v;
}

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
  props: {
    trigger_event: { type: "any" },
  },
  async run() {
    const body = this.trigger_event?.body ?? this.trigger_event ?? {};

    const cursor_name = String(body.cursor_name || DEFAULTS.cursor_name).replace(/[^a-zA-Z0-9_-]/g, "");
    const chain_id = checkId("chain_id", body.chain_id || `chain-${randomUUID()}`);
    const agent_session_id = checkId("agent_session_id", body.agent_session_id || `sess-${randomUUID()}`);
    const iteration = Math.max(1, coerceNum(body.iteration, 1));
    const max_iterations = Math.max(1, coerceNum(body.max_iterations, DEFAULTS.max_iterations));
    const budget_usd = Math.max(0, coerceNum(body.budget_usd, DEFAULTS.budget_usd));
    const budget_remaining_usd = Math.max(0, coerceNum(body.budget_remaining_usd, budget_usd));
    const per_call_max_tokens = coerceNum(body.per_call_max_tokens, DEFAULTS.per_call_max_tokens);
    const thinking_budget_tokens = coerceNum(body.thinking_budget_tokens, DEFAULTS.thinking_budget_tokens);
    const dry_run = coerceBool(body.dry_run, DEFAULTS.dry_run);

    const out = {
      cursor_name,
      chain_id,
      agent_session_id,
      iteration,
      max_iterations,
      budget_usd,
      budget_remaining_usd,
      per_call_max_tokens,
      thinking_budget_tokens,
      dry_run,
    };

    console.log(
      `distillation event: cursor=${cursor_name} chain=${chain_id} session=${agent_session_id} iter=${iteration}/${max_iterations} budget=$${budget_remaining_usd.toFixed(2)}/$${budget_usd.toFixed(2)} dry_run=${dry_run}`,
    );

    return out;
  },
});
