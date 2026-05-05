// attribution-cron — emits a tick on each timer fire for the signal attribution sweeper.
//
// One instance configured at 1h interval. The attribution-agent workflow's
// q_select_active_trends step selects active (non-RETIRED/DORMANT) trends;
// selection logic lives in SQL, not here.

export default {
  name: "Attribution_cron",
  version: "0.0.1",
  key: "attribution_cron",
  description: "1h timer for the signal attribution agent sweeper.",
  props: {
    timer: "$.interface.timer",
  },
  type: "source",
  methods: {},
  async run() {
    this.$emit({ kind: "attribution_tick" }, { summary: "attribution tick", ts: Date.now() });
  },
};
