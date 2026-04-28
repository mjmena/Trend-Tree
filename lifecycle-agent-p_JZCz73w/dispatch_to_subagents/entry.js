// Lifecycle Agent (sweeper) — dispatch_to_subagents
//
// Fans out N parallel POSTs to the lifecycle-subagent endpoint, one per
// due trend. Aggregates the subagent responses into the decisions array
// that PROC_LIFECYCLE_APPLY consumes.
//
// Cloned from distillation-revisit-p_o7CWWZl/dispatch_to_subagents/entry.js
// — same concurrency cap, per-call timeout, and budget aggregation pattern.

const FANOUT_CONCURRENCY = 5;
const PER_CALL_TIMEOUT_MS = 480_000;  // subagent has 600s lambda; allow most of that

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
      return {
        skipped: true,
        decisions_json: "[]",
        decisions_count: 0,
        ok_count: 0,
        error_count: 0,
        cost_usd: 0,
        run_duration_ms: 0,
        subagent_results: [],
      };
    }

    const trends = (this.due_rows || []).map((r) => ({
      trend_id: r.TREND_ID,
      trend_topic: r.TREND_TOPIC,
      lifecycle_status: r.LIFECYCLE_STATUS,
      heat: r.HEAT,
    }));

    if (trends.length === 0) {
      console.log("lcy-sweep: no due trends");
      return {
        decisions_json: "[]",
        decisions_count: 0,
        ok_count: 0,
        error_count: 0,
        cost_usd: 0,
        run_duration_ms: 0,
        subagent_results: [],
      };
    }

    if (ev.dry_run) {
      console.log(`lcy-sweep: dry_run=true; would dispatch ${trends.length} trends`);
      $.export("$summary", `dry_run: ${trends.length} trends would dispatch`);
      return {
        decisions_json: "[]",
        decisions_count: 0,
        ok_count: 0,
        error_count: 0,
        cost_usd: 0,
        run_duration_ms: 0,
        skipped: "dry_run",
        subagent_results: [],
      };
    }

    console.log(
      `lcy-sweep: dispatching ${trends.length} trends to ${this.subagent_url} ` +
      `(concurrency=${FANOUT_CONCURRENCY}, write_live=${ev.write_live})`
    );

    const t0 = Date.now();
    const results = [];
    let cursor = 0;

    const url = this.subagent_url;
    const chain_id = ev.chain_id;
    const dry_run = false;
    const budget = ev.budget_per_subagent_usd;
    const write_live = !!ev.write_live;

    async function worker() {
      while (cursor < trends.length) {
        const idx = cursor++;
        const t = trends[idx];
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
        const tStart = Date.now();
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              trend_id: t.trend_id,
              chain_id,
              dry_run,
              budget_usd: budget,
              write_live,
            }),
            signal: ctrl.signal,
          });
          const text = await resp.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
          results.push({
            trend_id: t.trend_id,
            ok: resp.ok,
            status: resp.status,
            duration_ms: Date.now() - tStart,
            response: parsed,
          });
          if (!resp.ok) {
            console.log(`lcy-sweep: trend ${t.trend_id} → HTTP ${resp.status}`);
          }
        } catch (e) {
          const msg = e.name === "AbortError" ? `timeout after ${PER_CALL_TIMEOUT_MS}ms` : e.message;
          results.push({
            trend_id: t.trend_id,
            ok: false,
            error: msg,
            duration_ms: Date.now() - tStart,
          });
          console.log(`lcy-sweep: trend ${t.trend_id} → error: ${msg}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const workerCount = Math.min(FANOUT_CONCURRENCY, trends.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const run_duration_ms = Date.now() - t0;

    // Build the decisions array for PROC_LIFECYCLE_APPLY. Only include
    // results that came back with a parseable lifecycle_decision.
    const decisions = [];
    let totalCost = 0;
    let okCount = 0;
    for (const r of results) {
      const resp = r.response || {};
      if (Number.isFinite(resp.llm_cost_estimate)) totalCost += resp.llm_cost_estimate;
      if (resp.lifecycle_decision && r.ok) {
        okCount += 1;
        decisions.push({
          trend_id: r.trend_id,
          agent_session_id: resp.agent_session_id,
          chain_id: resp.chain_id || chain_id,
          heat_base: resp.heat_base,
          lifecycle_decision: resp.lifecycle_decision,
          llm_token_usage: resp.llm_token_usage,
          llm_cost_estimate: resp.llm_cost_estimate,
          agent_telemetry: resp.agent_telemetry,
        });
      }
    }

    const errorCount = results.filter((r) => !r.ok || !(r.response && r.response.lifecycle_decision)).length;

    console.log(
      `lcy-sweep: ${decisions.length} decisions / ${trends.length} dispatched ` +
      `(${okCount} with decision, ${errorCount} errors/no-decision) ` +
      `in ${run_duration_ms}ms; total subagent cost=$${totalCost.toFixed(4)}`
    );
    $.export("$summary", `${decisions.length}/${trends.length} decisions, $${totalCost.toFixed(3)}`);

    return {
      decisions_json: JSON.stringify(decisions),
      decisions_count: decisions.length,
      ok_count: okCount,
      error_count: errorCount,
      cost_usd: totalCost,
      run_duration_ms,
      subagent_results: results,
    };
  },
});
