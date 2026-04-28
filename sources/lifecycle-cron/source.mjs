// lifecycle-cron — emits a tick on each timer fire for the lifecycle sweeper.
//
// One instance configured at 1h interval. The lifecycle-agent workflow's
// q_select_due_trends step picks up trends whose NEXT_LIFECYCLE_EVAL_AT
// is past, so the cron just needs to fire reliably; selection logic is in
// SQL, not here.
//
// Component published to Pipedream as sc_TBD (key: lifecycle_cron, v0.0.1).

export default {
  name: "Lifecycle_cron",
  version: "0.0.1",
  key: "lifecycle_cron",
  description: "1h timer for the lifecycle agent sweeper. Selection logic lives in q_select_due_trends, not here.",
  props: {
    timer: "$.interface.timer",
  },
  type: "source",
  methods: {},
  async run() {
    this.$emit({ kind: "lifecycle_tick" }, { summary: "lifecycle tick", ts: Date.now() });
  },
};
