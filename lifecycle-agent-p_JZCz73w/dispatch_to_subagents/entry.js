// Lifecycle Agent (sweeper) — dispatch_to_subagents
//
// Fire-and-forget POST per due trend. Each subagent commits its own
// decision via PROC_LIFECYCLE_APPLY at the end of its run — the sweeper
// does NOT wait for or aggregate decisions.
//
// Why fire-and-forget: Pipedream's customResponse HTTP triggers return
// 400 if $.respond() isn't called within ~5s. Lifecycle subagents take
// 30-80s (LLM agent loop). If the sweeper waits for responses, it gets
// 400s and never collects decisions. Inverting the commit pattern lets
// each subagent run on its own timeline.

const PER_DISPATCH_TIMEOUT_MS = 15_000;  // tolerate Pipedream's 400 + a bit more

export default defineComponent({
  props: {
    event: { type: "object" },
    due_rows: { type: "any" },
    subagent_url: { type: "string" },
  },
  async run({ $ }) {
    const ev = this.event || {};

    if (!this.subagent_url || /PLACEHOLDER/i.test(this.subagent_url)) {
      console.log(`lcy-sweep: subagent_url not configured (${this.subagent_url}) — skipping fanout`);
      $.export("$summary", "subagent_url not configured");
      return { skipped: true, dispatched_count: 0, error_count: 0, run_duration_ms: 0 };
    }

    const trends = (this.due_rows || []).map((r) => ({
      trend_id: r.TREND_ID,
      heat: r.HEAT,
    }));

    if (trends.length === 0) {
      console.log("lcy-sweep: no due trends");
      return { dispatched_count: 0, error_count: 0, run_duration_ms: 0 };
    }

    if (ev.dry_run) {
      console.log(`lcy-sweep: dry_run=true; would dispatch ${trends.length} trends`);
      $.export("$summary", `dry_run: ${trends.length} trends would dispatch`);
      return { skipped: "dry_run", dispatched_count: 0, error_count: 0, run_duration_ms: 0 };
    }

    console.log(
      `lcy-sweep: fire-and-forget dispatch of ${trends.length} trends to ${this.subagent_url} ` +
      `(write_live=${ev.write_live}); subagents commit themselves via PROC_LIFECYCLE_APPLY`
    );

    const t0 = Date.now();
    const url = this.subagent_url;
    const payload = (t) => ({
      trend_id: t.trend_id,
      chain_id: ev.chain_id,
      budget_usd: ev.budget_per_subagent_usd,
      write_live: !!ev.write_live,
    });

    // Fire all in parallel. We `await` so the lambda doesn't exit before
    // requests are sent, but we don't care about response bodies — Pipedream
    // returns 400 fast for slow workflows; that's fine, the trigger event
    // was emitted and the subagent runs to completion on its own.
    const settled = await Promise.allSettled(
      trends.map(async (t) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PER_DISPATCH_TIMEOUT_MS);
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload(t)),
            signal: ctrl.signal,
          });
          // Drain the body so the connection closes cleanly.
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
      `lcy-sweep: dispatched ${dispatched}/${trends.length} trends in ${run_duration_ms}ms ` +
      `(${errors} dispatch errors). Subagents commit independently — check FCT_TREND_LIFECYCLE_HISTORY in 1-3 minutes.`
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
