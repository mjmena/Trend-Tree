// Distillation Revisit Lead — select_next_batch
//
// SELECT the next PENDING batch for this chain (lowest BATCH_INDEX).
// Returns:
//   - the batch payload to dispatch (cluster_rows, signal_ids_json,
//     batch_index, total_batches, signal_count) when one is found, or
//   - { is_done: true } when the chain has no PENDING rows left.
//
// dispatch_to_cluster_agent reads is_done and returns without suspending
// when the chain is exhausted; finalize_or_continue then runs cursor
// MERGE + summary log on this same execution.

import snowflake from "snowflake-sdk";

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
    event: { type: "any" },
    prepare_result: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const prep = this.prepare_result || {};

    // Start mode + 0 batches — short-circuit without hitting Snowflake.
    if (ev.is_start && prep.total_batches === 0) {
      console.log("select_next_batch: start mode produced 0 batches");
      $.export("$summary", "0 batches in chain");
      return {
        is_done: true,
        chain_id: ev.chain_id,
        agent_session_id: ev.agent_session_id,
        total_batches: 0,
      };
    }

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
      const rows = await execute(
        conn,
        `SELECT BATCH_INDEX, TOTAL_BATCHES, CLUSTER_ROWS, SIGNAL_IDS_JSON, SIGNAL_COUNT
         FROM MCC_RAW.MARKETING_DEV.STG_REVISIT_BATCH_QUEUE
         WHERE CHAIN_ID = ? AND STATUS = 'PENDING'
         ORDER BY BATCH_INDEX ASC
         LIMIT 1`,
        [ev.chain_id],
      );

      if (!rows || rows.length === 0) {
        console.log(`select_next_batch: no PENDING batch for chain=${ev.chain_id}`);
        $.export("$summary", "chain done");
        return {
          is_done: true,
          chain_id: ev.chain_id,
          agent_session_id: ev.agent_session_id,
          total_batches: prep.total_batches ?? null,
        };
      }

      const r = rows[0];
      // CLUSTER_ROWS is a VARIANT — driver returns it parsed already.
      const cluster_rows = Array.isArray(r.CLUSTER_ROWS)
        ? r.CLUSTER_ROWS
        : (typeof r.CLUSTER_ROWS === "string" ? JSON.parse(r.CLUSTER_ROWS) : []);

      console.log(
        `select_next_batch: chain=${ev.chain_id} batch=${r.BATCH_INDEX}/${r.TOTAL_BATCHES} ` +
        `signals=${r.SIGNAL_COUNT}`,
      );
      $.export("$summary", `batch ${r.BATCH_INDEX + 1}/${r.TOTAL_BATCHES}`);

      return {
        is_done: false,
        chain_id: ev.chain_id,
        agent_session_id: ev.agent_session_id,
        batch_index: Number(r.BATCH_INDEX),
        total_batches: Number(r.TOTAL_BATCHES),
        signal_count: Number(r.SIGNAL_COUNT),
        signal_ids_json: r.SIGNAL_IDS_JSON,
        cluster_rows,
      };
    } finally {
      await destroy(conn);
    }
  },
});
