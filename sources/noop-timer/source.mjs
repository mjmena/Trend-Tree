// noop-timer — emits an empty event on each timer tick.
//
// Used as a generic "wake up this workflow on a schedule" source. Each
// instance configures its own interval via configured_props.timer.
// Workflows that want cron-firing attach this source's dc_xxx ID in their
// triggers list; Pipedream sync writes it through.
//
// Component published to Pipedream as sc_jdiAW2jR (key: noop_timer, v0.0.1).
// To revise: bump the version, `pd publish source.mjs --json`, then either
// re-instantiate fresh sources OR PUT existing source instances to point at
// the new component_id.

export default {
  name: "Noop_timer",
  version: "0.0.1",
  key: "noop_timer",
  description: "Emits an empty event on each timer tick. Used as a generic cron source for workflows that want to be triggered on a schedule.",
  props: {
    timer: "$.interface.timer",
  },
  type: "source",
  methods: {},
  async run(event) {
    this.$emit(
      { event },
      {
        summary: "noop tick",
        ts: Date.now(),
      },
    );
  },
};
