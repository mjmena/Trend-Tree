// Distillation Revisit Lead — finalize_or_continue
//
// Decides whether this run is done (ran the last batch — finalize the
// chain) or there's more PENDING work (fire the next run by self-POSTing
// to the lead's HTTP trigger and then $.flow.exit so this lambda ends
// cleanly).
//
// Branches:
//   - More PENDING for chain_id → fire-and-forget POST to
//     LEAD_HTTP_URL with {mode:"continue", chain_id, agent_session_id}
//     then $.flow.exit("fired_next_batch"). The next run picks up at
//     normalize_event with is_continue=true.
//   - No PENDING → aggregate metrics from STG_REVISIT_BATCH_QUEUE for
//     this chain (sum candidates, costs, durations; count DONE vs FAILED)
//     and MERGE STG_DISTILLATION_CURSOR. Log the chain summary.
//
// Why fire-and-forget: the agent_http source returns 400 to manual curl
// despite the workflow firing successfully (Issue #24 / memory note);
// the trigger fires regardless. We don't await a useful response.

import snowflake from "snowflake-sdk";

const SELF_POST_TIMEOUT_MS = 30_000;

function connect(opts) {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts);
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}

function execute(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows)),
    });
  });
}

function destroy(conn) {
  return new Promise((resolve) => conn.destroy(() => resolve()));
}

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    lead_http_url: { type: "string", label: "Revisit lead HTTP trigger URL (for self-POST)" },
    event: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};

    const auth = this.snowflake.$auth;
    const conn = await connect({
      account: auth.account,
      username: auth.username,
      privateKey: auth.private_key,
      authenticator: "SNOWFLAKE_JWT",
      database: "MCC_RAW",
      schema: "MARKETING_DEV",
      role: "MARKETING_ENGINEER",
    });

    try {
      const pendingRows = await execute(
        conn,
        `SELECT COUNT(*) AS N
         FROM MCC_RAW.MARKETING_DEV.STG_REVISIT_BATCH_QUEUE
         WHERE CHAIN_ID = ? AND STATUS = 'PENDING'`,
        [ev.chain_id],
      );
      const pending = Number(pendingRows?.[0]?.N ?? 0);

      if (pending > 0) {
        // Fire next run; do NOT MERGE the cursor yet.
        if (!this.lead_http_url || /PLACEHOLDER/i.test(this.lead_http_url)) {
          throw new Error("lead_http_url is not configured");
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SELF_POST_TIMEOUT_MS);
        try {
          // Fire-and-forget; the agent_http source returns 400 to
          // manual POSTs but still triggers the workflow (memory note
          // / Issue #24). We log the response status for visibility.
          const resp = await fetch(this.lead_http_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "continue",
              chain_id: ev.chain_id,
              agent_session_id: ev.agent_session_id,
            }),
            signal: ctrl.signal,
          });
          console.log(
            `finalize_or_continue: fired next run for chain=${ev.chain_id} ` +
            `(${pending} PENDING remain) → HTTP ${resp.status}`,
          );
        } catch (e) {
          // A failed self-POST is not fatal — we surface and let the
          // run-history reflect it. The chain stays in PENDING and a
          // future cron tick or manual continue can pick it up.
          throw new Error(`finalize_or_continue self-POST failed: ${e.message}`);
        } finally {
          clearTimeout(timer);
        }

        $.export("$summary", `fired next run (${pending} PENDING)`);
        $.flow.exit("fired_next_batch");
        return; // unreachable; $.flow.exit terminates
      }

      // No PENDING → finalize the chain.
      const aggRows = await execute(
        conn,
        `SELECT
           COUNT(*)                               AS TOTAL_BATCHES,
           SUM(CASE WHEN STATUS = 'DONE'   THEN 1 ELSE 0 END) AS DONE_COUNT,
           SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) AS FAILED_COUNT,
           COALESCE(SUM(CANDIDATES_COUNT), 0)     AS CANDIDATES_TOTAL,
           COALESCE(SUM(SIGNAL_COUNT), 0)         AS SIGNALS_TOTAL,
           COALESCE(SUM(COST_USD), 0)             AS COST_TOTAL,
           COALESCE(SUM(RUN_DURATION_MS), 0)      AS DURATION_TOTAL_MS
         FROM MCC_RAW.MARKETING_DEV.STG_REVISIT_BATCH_QUEUE
         WHERE CHAIN_ID = ?`,
        [ev.chain_id],
      );
      const agg = aggRows?.[0] || {};
      const total_batches = Number(agg.TOTAL_BATCHES ?? 0);
      const done_count = Number(agg.DONE_COUNT ?? 0);
      const failed_count = Number(agg.FAILED_COUNT ?? 0);
      const candidates_total = Number(agg.CANDIDATES_TOTAL ?? 0);
      const signals_total = Number(agg.SIGNALS_TOTAL ?? 0);
      const cost_total = Number(agg.COST_TOTAL ?? 0);
      const duration_total_ms = Number(agg.DURATION_TOTAL_MS ?? 0);

      // MERGE cursor (same shape the legacy update_cursor wrote, but
      // with chain-aggregate values). LAST_SIGNAL_TS is set to NOW per
      // the legacy behavior — revisit isn't an incremental cursor, the
      // 48h pool window resets each run.
      await execute(
        conn,
        `MERGE INTO MCC_RAW.MARKETING_DEV.STG_DISTILLATION_CURSOR target
         USING (
           SELECT
             'distillation_revisit'::STRING        AS CURSOR_NAME,
             CURRENT_TIMESTAMP()::TIMESTAMP_NTZ    AS LAST_RUN_AT,
             CURRENT_TIMESTAMP()::TIMESTAMP_NTZ    AS LAST_SIGNAL_TS,
             ?::NUMBER                             AS RUN_DURATION_MS,
             ?::NUMBER                             AS SIGNAL_COUNT,
             ?::NUMBER                             AS CANDIDATE_COUNT,
             ?::FLOAT                              AS COST_USD
         ) source
         ON target.CURSOR_NAME = source.CURSOR_NAME
         WHEN MATCHED THEN UPDATE SET
           target.LAST_RUN_AT      = source.LAST_RUN_AT,
           target.LAST_SIGNAL_TS   = source.LAST_SIGNAL_TS,
           target.RUN_DURATION_MS  = source.RUN_DURATION_MS,
           target.SIGNAL_COUNT     = source.SIGNAL_COUNT,
           target.CANDIDATE_COUNT  = source.CANDIDATE_COUNT,
           target.COST_USD         = source.COST_USD
         WHEN NOT MATCHED THEN INSERT (
           CURSOR_NAME, LAST_RUN_AT, LAST_SIGNAL_TS, RUN_DURATION_MS, SIGNAL_COUNT, CANDIDATE_COUNT, COST_USD
         ) VALUES (
           source.CURSOR_NAME, source.LAST_RUN_AT, source.LAST_SIGNAL_TS,
           source.RUN_DURATION_MS, source.SIGNAL_COUNT, source.CANDIDATE_COUNT, source.COST_USD
         )`,
        [duration_total_ms, signals_total, candidates_total, cost_total],
      );

      console.log(
        `\n=== Revisit chain complete: ${ev.chain_id} ===\n` +
        `  total_batches=${total_batches} (DONE=${done_count} FAILED=${failed_count})\n` +
        `  signals=${signals_total} candidates=${candidates_total} ` +
        `cost=$${cost_total.toFixed(4)} duration=${duration_total_ms}ms`,
      );
      $.export(
        "$summary",
        `chain done: ${candidates_total} candidates from ${done_count}/${total_batches} batches`,
      );

      return {
        finalized: true,
        chain_id: ev.chain_id,
        agent_session_id: ev.agent_session_id,
        total_batches,
        done_count,
        failed_count,
        candidates_total,
        signals_total,
        cost_total,
        duration_total_ms,
      };
    } finally {
      await destroy(conn);
    }
  },
});
