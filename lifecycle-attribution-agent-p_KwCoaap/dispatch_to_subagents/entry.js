// Lifecycle Attribution Agent (sweeper) — dispatch_to_subagents
//
// Fire-and-forget POST per active trend. Each subagent reasons about
// candidate signals and commits confirmed attributions independently via
// INSERT INTO FCT_TREND_SIGNALS. The sweeper does not wait for or aggregate results.
//
// Dispatch is PACED with a bounded worker pool (DISPATCH_CONCURRENCY) rather
// than firing every trend at once. Each subagent's first action is a Snowflake
// query (q_trend_context) on the shared TREND_AGENT_WH connection; an uncapped
// fan-out of ~30 simultaneous subagents saturated the Pipedream SQL proxy /
// cold X-Small warehouse and surfaced as synchronized bursts of "Error
// contacting database" on that first query (only the first — once warm, the
// rest of a run's queries succeed). Capping concurrency keeps simultaneous
// first-query connections low so the warehouse warms on wave 1 and the proxy
// isn't flooded.
//
// Why the cap lives HERE (the caller), not on the subagent: the subagent's
// trigger is a native hi_* HTTP interface, and Pipedream does NOT event-queue
// native HTTP/cron/SDK/email triggers (only dc_* event sources). So there is no
// subagent-side concurrency knob to turn — backpressure has to be applied here.
// (The backfill driver scripts/attribution_backfill.sh already self-paces in
// batches of 6 for the same reason; this brings the hourly sweeper in line.)
//
// Wave spacing falls out of the abort: the dispatcher never reads the response
// body, and the subagent's $.respond() only fires after its ~1-3 min Gemini
// step, so every POST runs to PER_DISPATCH_TIMEOUT_MS and aborts (the subagent
// completes server-side regardless of client disconnect — that's how today's
// attributions get committed at all). A worker slot therefore frees ~one
// timeout after it starts, by which point that subagent's Snowflake phase has
// cleared, so successive waves don't overlap their first queries. At
// DISPATCH_CONCURRENCY=6 and the sweep_cap=30 default that's ~5 waves (~50s);
// even at the sweep_cap=100 max it stays inside the agent's 180s lambda_timeout.

const PER_DISPATCH_TIMEOUT_MS = 10_000;
const DISPATCH_CONCURRENCY = 6;

// Bounded-concurrency map: at most `n` invocations of `fn` in flight at once.
// Output order matches `items`. Per-item errors are captured (Promise.allSettled
// shape), so a single failed dispatch never rejects the whole batch.
async function pmapSettled(items, n, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

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
      `attr-sweep: paced dispatch of ${trends.length} trends ` +
      `(concurrency=${DISPATCH_CONCURRENCY}, ${PER_DISPATCH_TIMEOUT_MS}ms/wave) to ${this.subagent_url}`
    );

    const t0 = Date.now();
    const url = this.subagent_url;

    const settled = await pmapSettled(trends, DISPATCH_CONCURRENCY, async (t) => {
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
    });

    const run_duration_ms = Date.now() - t0;
    const dispatched = settled.filter((s) => s.status === "fulfilled").length;
    const errors = settled.filter((s) => s.status === "rejected").length;

    console.log(
      `attr-sweep: dispatched ${dispatched}/${trends.length} in ${run_duration_ms}ms ` +
      `(${errors} did not respond before abort — expected for trends that run the LLM; ` +
      `subagents commit independently, check FCT_TREND_SIGNALS in 1-3 min).`
    );
    $.export("$summary", `dispatched ${trends.length} @ concurrency ${DISPATCH_CONCURRENCY}`);

    return {
      dispatched_count: dispatched,
      error_count: errors,
      attempted: trends.length,
      concurrency: DISPATCH_CONCURRENCY,
      run_duration_ms,
      dispatch_results: settled.map((s, i) => ({
        trend_id: trends[i].trend_id,
        status: s.status,
        ...(s.status === "fulfilled" ? { http_status: s.value.status } : { reason: String(s.reason).slice(0, 200) }),
      })),
    };
  },
});
