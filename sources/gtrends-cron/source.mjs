// gtrends-cron — emits a tick on each timer fire for the gtrends-poller.
//
// One instance configured at daily interval. The gtrends-poller workflow
// iterates ACTIVE trends and pulls their Google Trends interest curves
// into FCT_TREND_GTRENDS_DAILY. Lifecycle reads that table as prefetched
// context — never invokes Google Trends live.
//
// Component published to Pipedream as sc_TBD (key: gtrends_cron, v0.0.1).

export default {
  name: "GTrends_cron",
  version: "0.0.1",
  key: "gtrends_cron",
  description: "Daily timer for the gtrends-poller. Iterates ACTIVE trends and pulls their Google Trends interest curves.",
  props: {
    timer: "$.interface.timer",
  },
  type: "source",
  methods: {},
  async run() {
    this.$emit({ kind: "gtrends_tick" }, { summary: "gtrends tick", ts: Date.now() });
  },
};
