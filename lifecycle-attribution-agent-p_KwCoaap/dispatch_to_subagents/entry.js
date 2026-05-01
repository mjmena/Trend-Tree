// Lifecycle Attribution Agent (sweeper) — dispatch_to_subagents
//
// Fire-and-forget POST per active trend. Each subagent reasons about
// candidate signals and commits confirmed attributions independently via
// INSERT INTO FCT_TREND_SIGNALS. The sweeper does not wait for or aggregate results.

const PER_DISPATCH_TIMEOUT_MS = 15_000;

export default defineComponent({
  props: {
    event: { type: "object" },
    active_rows: { type: "any" },
    subagent_url: { type: "string" },
  },
  async run({ $ }) {
    const ev = this.event || {};

    if (!this.subagent_url || /PLACEHOLDER/i.test(this.subagent_url)) {
      console.log(`attr-sweep: subagent_url not configured — skipping fanout`);
      $.export("$summary", "subagent_url not configured");
      return { skipped: true, dispatched_count: 0, error_count: 0, run_duration_ms: 0 };
    }

    const trends = (this.active_rows || []).map((r) => ({
      trend_id: r.TREND_ID,
      lifecycle_status: r.LIFECYCLE_STATUS,
    }));

    if (trends.length === 0) {
      console.log("attr-sweep: no active trends with vectors");
      return { dispatched_count: 0, error_count: 0, run_duration_ms: 0 };
    }

    if (ev.dry_run) {
      console.log(`attr-sweep: dry_run=true; would dispatch ${trends.length} trends`);
      $.export("$summary", `dry_run: ${trends.length} trends would dispatch`);
      return { skipped: "dry_run", dispatched_count: 0, error_count: 0, run_duration_ms: 0 };
    }

    console.log(
      `attr-sweep: fire-and-forget dispatch of ${trends.length} trends to ${this.subagent_url}`
    );

    const t0 = Date.now();
    const url = this.subagent_url;

    const settled = await Promise.allSettled(
      trends.map(async (t) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PER_DISPATCH_TIMEOUT_MS);
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              trend_id: t.trend_id,
              chain_id: ev.chain_id,
              budget_usd: ev.budget_per_subagent_usd,
            }),
            signal: ctrl.signal,
          });
          await resp.text().catch(() => "");
          return { trend_id: t.trend_id, status: resp.status };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    const run_duration_ms = Date.now() - t0;
    const dispatched = settled.filter((s) => s.status === "fulfilled").length;
    const errors = settled.filter((s) => s.status === "rejected").length;

    console.log(
      `attr-sweep: dispatched ${dispatched}/${trends.length} in ${run_duration_ms}ms ` +
      `(${errors} errors). Subagents commit independently — check FCT_TREND_SIGNALS in 1-3 min.`
    );
    $.export("$summary", `dispatched ${dispatched}/${trends.length}`);

    return {
      dispatched_count: dispatched,
      error_count: errors,
      attempted: trends.length,
      run_duration_ms,
      dispatch_results: settled.map((s, i) => ({
        trend_id: trends[i].trend_id,
        status: s.status,
        ...(s.status === "fulfilled" ? { http_status: s.value.status } : { reason: String(s.reason).slice(0, 200) }),
      })),
    };
  },
});
