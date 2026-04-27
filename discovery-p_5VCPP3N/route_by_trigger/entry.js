// Discovery — route_by_trigger
//
// First step of the workflow. Reads the trigger event and decides which
// discover_* steps should actually run.
//
// Sources of `model`, in priority order:
//   1. steps.trigger.event.model       — timer source emit payload
//   2. steps.trigger.event.body.model  — HTTP trigger request body
// If neither is one of gemini/grok/chatgpt, fall back to all three.
//
// Each discover_* step short-circuits with empty proposals if its model
// isn't in models_to_run. This is what unlocks per-model cadence
// independence — one workflow, three cron sources, one routing decision —
// AND per-model HTTP fires for ad-hoc testing/backfill.

const VALID_MODELS = ["gemini", "grok", "chatgpt"];

export default defineComponent({
  async run({ steps, $ }) {
    const ev = steps.trigger?.event || {};
    const triggerModel = ev.model ?? ev.body?.model;
    const models_to_run = VALID_MODELS.includes(triggerModel)
      ? [triggerModel]
      : VALID_MODELS;

    console.log(`Routing: trigger=${triggerModel || "(none)"}, models_to_run=${models_to_run.join(",")}`);
    $.export("$summary", `models: ${models_to_run.join(", ")}`);
    return { models_to_run };
  },
});
