// Distillation Lead — normalize_event
//
// Both the cron trigger and a manual HTTP POST land here. Produces a
// normalized inputs object used by every downstream step. For HTTP calls,
// fields come from the POST body. For scheduled cron runs with no body,
// defaults seed a fresh chain.

import { randomUUID } from "crypto";

const DEFAULT_CURSOR_NAME = "distillation_main";

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

    const cursor_name = String(body.cursor_name || DEFAULT_CURSOR_NAME).replace(/[^a-zA-Z0-9_-]/g, "");
    const chain_id = String(body.chain_id || `chain-${randomUUID()}`).slice(0, 64);
    const agent_session_id = String(body.agent_session_id || `sess-${randomUUID()}`).slice(0, 64);
    const iteration = Math.max(1, coerceNum(body.iteration, 1));

    console.log(
      `distillation event: cursor=${cursor_name} chain=${chain_id} session=${agent_session_id} iter=${iteration}`,
    );

    return { cursor_name, chain_id, agent_session_id, iteration };
  },
});
