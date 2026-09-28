// Promotion — fire_enrichment_chain
//
// After PROC_PROMOTION_APPLY writes new FCT_TRENDS rows, fan out an
// HTTP POST per newly-promoted trend_id to the dispatcher endpoint.
// The dispatcher then runs sources → enrichment → write synchronously.
//
// Fire-and-forget: we don't await the chain results (each takes 3-5min;
// blocking would push promotion's wall time past its lambda timeout).
// Errors land in the dispatcher's own $errors stream.
//
// Retry (CRMA-1032): the same fan-out also re-dispatches stuck trends from
// q_unenriched_trends — promoted earlier, chain failed, still no `initial`
// ledger row. ./enrichment_targets.mjs decides which ones are due this run
// (once a day per trend, iteration 1 only). It is a sibling in this SAME
// step dir, which is the only import shape Pipedream bundles.
//
// Replaces the legacy STG_ENRICHMENT_QUEUE + cron-poll mechanism.
//
// Input: apply_result (the row from CALL PROC_PROMOTION_APPLY) — its
// `results` array contains one entry per decision; PROMOTE_NEW entries
// with status='ok' have a `target_trend_id` set to the newly-created
// FCT_TRENDS row.

import {
  extractPromotedTrendIds,
  selectRetryTrendIds,
  buildDispatchTargets,
} from "./enrichment_targets.mjs";

const FANOUT_CONCURRENCY = 5;
const PER_CALL_TIMEOUT_MS = 30_000; // we're not waiting for completion, just for the POST to dispatch

export default defineComponent({
  props: {
    apply_result: { type: "any" },
    unenriched_rows: {
      type: "any",
      label: "Unenriched trends",
      description: "Rows from q_unenriched_trends: TREND_ID, HOURS_SINCE_PROMOTED",
      optional: true,
    },
    iteration: { type: "string", optional: true },
    dry_run: { type: "string", optional: true },
    dispatcher_url: {
      type: "string",
      label: "Dispatcher endpoint URL",
      description: "HTTP endpoint of dispatcher-p_8rCBgnl that runs sources → enrichment → write per trend_id",
    },
  },
  async run({ $ }) {
    const promotedIds = extractPromotedTrendIds(this.apply_result);
    const retryIds = selectRetryTrendIds(this.unenriched_rows, {
      iteration: this.iteration,
      dryRun: this.dry_run,
    });
    const targets = buildDispatchTargets(promotedIds, retryIds);
    const retryCount = targets.filter((t) => t.reason === "retry").length;

    if (targets.length === 0) {
      console.log("fire_enrichment_chain: no newly-promoted or retry-due trends to enrich");
      $.export("$summary", "0 dispatched");
      return { dispatched_count: 0, trend_ids: [], retry_trend_ids: [] };
    }

    const trendIds = targets.map((t) => t.trend_id);
    const retryTrendIds = targets.filter((t) => t.reason === "retry").map((t) => t.trend_id);

    if (!this.dispatcher_url || /PLACEHOLDER/i.test(this.dispatcher_url)) {
      console.log(`fire_enrichment_chain: dispatcher_url not configured (got '${this.dispatcher_url}') — skipping fanout`);
      $.export("$summary", `${targets.length} to enrich but dispatcher not configured`);
      return { dispatched_count: 0, trend_ids: trendIds, retry_trend_ids: retryTrendIds, error: "dispatcher_url not configured" };
    }

    console.log(
      `fire_enrichment_chain: dispatching ${targets.length} trend(s) (${retryCount} retries) → ${this.dispatcher_url}`,
    );
    const dispatched = [];
    const errors = [];

    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const idx = cursor++;
        const { trend_id, reason } = targets[idx];
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
        try {
          // Fire-and-forget: we POST and resolve immediately on response
          // headers (or on the connection accepting the body). The dispatcher
          // workflow runs the chain in its own lambda; we just need it to
          // accept the request.
          const resp = await fetch(this.dispatcher_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trend_id }),
            signal: ctrl.signal,
          });
          dispatched.push({ trend_id, reason, status: resp.status, ok: resp.ok });
          if (!resp.ok) {
            const text = await resp.text();
            console.log(`fire_enrichment_chain: ${trend_id} [${reason}] → HTTP ${resp.status}: ${text.slice(0, 200)}`);
          } else {
            console.log(`fire_enrichment_chain: ${trend_id} [${reason}] → dispatched (${resp.status})`);
          }
        } catch (e) {
          const msg = e.name === "AbortError" ? `timeout after ${PER_CALL_TIMEOUT_MS}ms` : e.message;
          errors.push({ trend_id, reason, error: msg });
          console.log(`fire_enrichment_chain: ${trend_id} [${reason}] → error: ${msg}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const workerCount = Math.min(FANOUT_CONCURRENCY, targets.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker.call(this)));

    const okCount = dispatched.filter((d) => d.ok).length;
    $.export("$summary", `${okCount}/${targets.length} dispatched, ${retryCount} retries (${errors.length} errors)`);

    return {
      dispatched_count: okCount,
      total_attempted: targets.length,
      trend_ids: trendIds,
      retry_trend_ids: retryTrendIds,
      results: dispatched,
      errors,
    };
  },
});
