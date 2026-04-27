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
// Replaces the legacy STG_ENRICHMENT_QUEUE + cron-poll mechanism.
//
// Input: apply_result (the row from CALL PROC_PROMOTION_APPLY) — its
// `results` array contains one entry per decision; PROMOTE_NEW entries
// with status='ok' have a `target_trend_id` set to the newly-created
// FCT_TRENDS row.

const FANOUT_CONCURRENCY = 5;
const PER_CALL_TIMEOUT_MS = 30_000; // we're not waiting for completion, just for the POST to dispatch

export default defineComponent({
  props: {
    apply_result: { type: "any" },
    dispatcher_url: {
      type: "string",
      label: "Dispatcher endpoint URL",
      description: "HTTP endpoint of dispatcher-p_8rCBgnl that runs sources → enrichment → write per trend_id",
    },
  },
  async run({ $ }) {
    const promotedIds = extractPromotedTrendIds(this.apply_result);
    if (promotedIds.length === 0) {
      console.log("fire_enrichment_chain: no newly-promoted trends to enrich");
      $.export("$summary", "0 dispatched");
      return { dispatched_count: 0, trend_ids: [] };
    }

    if (!this.dispatcher_url || /PLACEHOLDER/i.test(this.dispatcher_url)) {
      console.log(`fire_enrichment_chain: dispatcher_url not configured (got '${this.dispatcher_url}') — skipping fanout`);
      $.export("$summary", `${promotedIds.length} promoted but dispatcher not configured`);
      return { dispatched_count: 0, trend_ids: promotedIds, error: "dispatcher_url not configured" };
    }

    console.log(`fire_enrichment_chain: dispatching ${promotedIds.length} trend(s) → ${this.dispatcher_url}`);
    const dispatched = [];
    const errors = [];

    let cursor = 0;
    async function worker() {
      while (cursor < promotedIds.length) {
        const idx = cursor++;
        const trend_id = promotedIds[idx];
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
          dispatched.push({ trend_id, status: resp.status, ok: resp.ok });
          if (!resp.ok) {
            const text = await resp.text();
            console.log(`fire_enrichment_chain: ${trend_id} → HTTP ${resp.status}: ${text.slice(0, 200)}`);
          } else {
            console.log(`fire_enrichment_chain: ${trend_id} → dispatched (${resp.status})`);
          }
        } catch (e) {
          const msg = e.name === "AbortError" ? `timeout after ${PER_CALL_TIMEOUT_MS}ms` : e.message;
          errors.push({ trend_id, error: msg });
          console.log(`fire_enrichment_chain: ${trend_id} → error: ${msg}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const workerCount = Math.min(FANOUT_CONCURRENCY, promotedIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker.call(this)));

    const okCount = dispatched.filter((d) => d.ok).length;
    $.export("$summary", `${okCount}/${promotedIds.length} dispatched (${errors.length} errors)`);

    return {
      dispatched_count: okCount,
      total_attempted: promotedIds.length,
      trend_ids: promotedIds,
      results: dispatched,
      errors,
    };
  },
});

function extractPromotedTrendIds(apply_result) {
  // PROC_PROMOTION_APPLY returns a single VARIANT row; the SQL action
  // wraps it in either an array or a single object with the proc name as
  // the column key. Defensive parsing matches eval_and_retrigger's pattern.
  let parsed = null;
  try {
    let row = null;
    if (Array.isArray(apply_result) && apply_result.length > 0) row = apply_result[0];
    else if (apply_result && typeof apply_result === "object") row = apply_result;
    if (!row) return [];
    const value =
      row.PROC_PROMOTION_APPLY ??
      row.proc_promotion_apply ??
      Object.values(row)[0];
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (e) {
    console.log(`fire_enrichment_chain: could not parse apply_result: ${e.message}`);
    return [];
  }

  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  return results
    .filter((r) => r && r.status === "ok" && r.decision === "PROMOTE_NEW" && r.target_trend_id)
    .map((r) => r.target_trend_id);
}
