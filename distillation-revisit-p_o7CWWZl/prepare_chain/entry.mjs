// Distillation Revisit Lead — prepare_chain
//
// Start mode (mode === "start"): one TCP-connected Snowflake session does
// all the start-only setup atomically:
//   1. SELECT the 48h discovery-signal pool (≤1600 rows).
//   2. CALL PROC_CLUSTER_SIGNAL_SUBSET(pool, 0.8) — Louvain communities.
//   3. Bin-pack communities into batches of ≤400 signals (greedy).
//   4. INSERT N PENDING rows into STG_REVISIT_BATCH_QUEUE.
//   5. UPDATE STG_EXTERNAL_SIGNALS to stamp this revisit session_id
//      across the entire pool, so future revisit runs skip these signals
//      and PROC_RELEASE_STALE_SIGNAL_CLAIMS leaves them alone.
//
// Continue mode (mode === "continue"): no-op return; the queue already
// holds this chain's rows. select_next_batch will pick the next PENDING.
//
// We co-locate this work in one TCP connection (a) to bypass the
// SQL-proxy's 256KB body cap on cluster_rows roundtrips and (b) so a
// failure between persisting the queue and claiming signals leaves a
// recoverable (or nothing) state — not "queue persisted but signals
// unclaimed and visible to the next cron tick".

import snowflake from "snowflake-sdk";

const POOL_LIMIT = 1600;
const MAX_BATCH_SIZE = 400;
const POOL_LOOKBACK_HOURS = 48;

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

function binPack(clusterRows) {
  const byCluster = new Map();
  for (const r of clusterRows) {
    const cid = r.cluster_id ?? 0;
    if (!byCluster.has(cid)) byCluster.set(cid, []);
    byCluster.get(cid).push(r);
  }
  const communities = [...byCluster.values()].sort((a, b) => b.length - a.length);

  const batches = [];
  let current = [];
  for (const community of communities) {
    const slice = community.slice(0, MAX_BATCH_SIZE);
    if (current.length + slice.length > MAX_BATCH_SIZE) {
      if (current.length > 0) batches.push(current);
      current = slice;
    } else {
      current = current.concat(slice);
    }
  }
  if (current.length > 0) batches.push(current);

  return batches.map((rows, i) => ({
    batch_index: i,
    cluster_rows: rows,
    signal_ids_json: JSON.stringify(rows.map((r) => r.signal_id)),
    signal_count: rows.length,
  }));
}

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
    event: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};

    if (ev.is_continue) {
      console.log(`prepare_chain: continue mode for chain=${ev.chain_id} — no-op`);
      $.export("$summary", "continue mode (no-op)");
      return {
        skipped: true,
        mode: "continue",
        chain_id: ev.chain_id,
        agent_session_id: ev.agent_session_id,
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
      const t0 = Date.now();

      const poolRows = await execute(
        conn,
        `SELECT s.SIGNAL_ID
         FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
         WHERE s.SIGNAL_TIMESTAMP > DATEADD(hour, -${POOL_LOOKBACK_HOURS}, CURRENT_TIMESTAMP())
           AND s.AGENT_SESSION_ID LIKE 'sess-%'
           AND COALESCE(s.METADATA:signal_kind::STRING, 'discovery_signal') = 'discovery_signal'
           AND NOT EXISTS (
             SELECT 1
             FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
                  LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
             WHERE f.value::STRING = s.SIGNAL_ID
               AND c.PROMOTED_TO IS NOT NULL
           )
         ORDER BY s.SIGNAL_TIMESTAMP DESC NULLS LAST
         LIMIT ${POOL_LIMIT}`,
        [],
      );
      const signal_ids = (poolRows || []).map((r) => r.SIGNAL_ID).filter(Boolean);
      const pool_size = signal_ids.length;

      if (pool_size === 0) {
        console.log("prepare_chain: empty pool — nothing to revisit");
        $.export("$summary", "empty pool (0 batches)");
        return {
          skipped: false,
          mode: "start",
          chain_id: ev.chain_id,
          agent_session_id: ev.agent_session_id,
          pool_size: 0,
          total_batches: 0,
          prepare_duration_ms: Date.now() - t0,
        };
      }

      const signal_ids_json = JSON.stringify(signal_ids);

      console.log(`prepare_chain: Louvain clustering ${pool_size} signals (resolution=0.8)`);
      const clusterRowsRaw = await execute(
        conn,
        "CALL MCC_RAW.MARKETING_DEV.PROC_CLUSTER_SIGNAL_SUBSET(PARSE_JSON(?)::ARRAY, 0.8::FLOAT)",
        [signal_ids_json],
      );
      const row = Array.isArray(clusterRowsRaw) ? clusterRowsRaw[0] : clusterRowsRaw;
      const raw = row ? Object.values(row)[0] : null;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
      const clusterRows = Array.isArray(parsed) ? parsed : [];
      const community_count = new Set(clusterRows.map((c) => c.cluster_id)).size;

      const batches = binPack(clusterRows);
      const total_batches = batches.length;
      console.log(
        `prepare_chain: ${clusterRows.length} signals in ${community_count} communities → ${total_batches} batches ` +
        `(sizes: ${batches.map((b) => b.signal_count).join(", ")})`,
      );

      if (total_batches === 0) {
        console.log("prepare_chain: clustering yielded 0 batches");
        $.export("$summary", "0 batches after clustering");
        return {
          skipped: false,
          mode: "start",
          chain_id: ev.chain_id,
          agent_session_id: ev.agent_session_id,
          pool_size,
          total_batches: 0,
          prepare_duration_ms: Date.now() - t0,
        };
      }

      // INSERT N PENDING rows. Doing one INSERT per batch keeps this
      // robust against driver multi-bind quirks; N is ≤ ~6 in practice.
      for (const b of batches) {
        await execute(
          conn,
          `INSERT INTO MCC_RAW.MARKETING_DEV.STG_REVISIT_BATCH_QUEUE
           (CHAIN_ID, AGENT_SESSION_ID, BATCH_INDEX, TOTAL_BATCHES,
            CLUSTER_ROWS, SIGNAL_IDS_JSON, SIGNAL_COUNT, STATUS, UPDATED_AT)
           SELECT ?, ?, ?, ?, PARSE_JSON(?), ?, ?, 'PENDING', CURRENT_TIMESTAMP()`,
          [
            ev.chain_id,
            ev.agent_session_id,
            b.batch_index,
            total_batches,
            JSON.stringify(b.cluster_rows),
            b.signal_ids_json,
            b.signal_count,
          ],
        );
      }

      // Claim all pool signals upfront so a concurrent revisit firing
      // (manual + cron racing) can't double-process.
      await execute(
        conn,
        `UPDATE MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
         SET AGENT_SESSION_ID = ?
         WHERE SIGNAL_ID IN (SELECT VALUE::STRING FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))))`,
        [ev.agent_session_id, signal_ids_json],
      );

      const prepare_duration_ms = Date.now() - t0;
      $.export("$summary", `${pool_size} signals → ${total_batches} batches (claimed)`);

      return {
        skipped: false,
        mode: "start",
        chain_id: ev.chain_id,
        agent_session_id: ev.agent_session_id,
        pool_size,
        total_batches,
        community_count,
        prepare_duration_ms,
      };
    } finally {
      await destroy(conn);
    }
  },
});
