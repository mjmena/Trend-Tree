// Discovery — route_by_trigger
//
// First step of the workflow. Reads the trigger event and decides which
// discover_* steps should actually run. Three model-specific timer
// sources (sources/discovery-cron) emit { model: <gemini|grok|chatgpt> };
// the HTTP trigger emits a regular HTTP body with no model field.
//
// - Source-triggered: run only the matching model
// - HTTP-triggered (or any unknown shape): run all three models
//
// Each discover_* step short-circuits with empty proposals if its model
// isn't in models_to_run. This is what unlocks per-model cadence
// independence — one workflow, three cron sources, one routing decision.

const VALID_MODELS = ["gemini", "grok", "chatgpt"];

export default defineComponent({
  async run({ steps, $ }) {
    const triggerModel = steps.trigger?.event?.model;
    const models_to_run = VALID_MODELS.includes(triggerModel)
      ? [triggerModel]
      : VALID_MODELS;

    console.log(`Routing: trigger=${triggerModel || "(none)"}, models_to_run=${models_to_run.join(",")}`);
    $.export("$summary", `models: ${models_to_run.join(", ")}`);
    return { models_to_run };
  },
});
