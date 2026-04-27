// discovery-cron — emits a {model} payload on each timer tick.
//
// Per-model timer for the Discovery workflow. Three instances (one per
// LLM model) are attached as triggers; each instance configures its own
// interval + model name. The workflow's route_by_trigger step reads
// event.model and only invokes the matching discover_* step.
//
// This is what unlocks per-model cadence independence: bumping Gemini
// to hourly while keeping Grok at 4h is a single PUT /v1/sources call,
// no code change.
//
// Component published to Pipedream as sc_TBD (key: discovery_cron, v0.0.1).

export default {
  name: "Discovery_cron",
  version: "0.0.1",
  key: "discovery_cron",
  description: "Per-model timer for the Discovery workflow. Each instance configures its own model identifier (gemini|grok|chatgpt) and interval.",
  props: {
    timer: "$.interface.timer",
    model: {
      type: "string",
      label: "Model identifier",
      description: "Which discovery model this timer fires (gemini|grok|chatgpt)",
      options: ["gemini", "grok", "chatgpt"],
    },
  },
  type: "source",
  methods: {},
  async run() {
    this.$emit(
      { model: this.model },
      { summary: `tick: ${this.model}`, ts: Date.now() },
    );
  },
};
