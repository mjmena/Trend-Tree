// Distillation Revisit Lead — commit_batch_result
//
// One TCP-connected Snowflake session does:
//   1. INSERT this batch's candidates into STG_TREND_CANDIDATES (same
//      CTE shape the legacy commit_candidates SQL action used: derives
//      SOURCE_BREAKDOWN by joining supporting_signal_ids back to
//      STG_EXTERNAL_SIGNALS).
//   2. UPDATE the queue row with terminal status (DONE on happy path,
//      FAILED on cluster_agent_timeout / error / malformed callback) plus
//      candidate count, cost, duration, and error string.
//
// No-op when the upstream parsed result was skipped (no batch dispatched
// this run — chain was already done).

import snowflake from "snowflake-sdk";

const INSERT_CANDIDATES_SQL = `
INSERT INTO MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES (
  CANDIDATE_ID, AGENT_SESSION_ID, CHAIN_ID, ITERATION,
  TOPIC, SUPPORTING_SIGNAL_IDS, CONFIDENCE, SPECIFICITY_SCORE,
  SOURCE_BREAKDOWN, BUCKET, VERDICT, EVIDENCE_ADDED,
  REASONING, REASONING_TRACE, DEDUP_OF_TREND_ID
)
WITH cand AS (
  SELECT c.value AS j FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) c
),
sig_counts AS (
  SELECT cand.j:candidate_id::STRING AS candidate_id, s.SOURCE_NAME, COUNT(*) AS n
  FROM cand, LATERAL FLATTEN(INPUT => cand.j:supporting_signal_ids) sid
  JOIN MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s ON s.SIGNAL_ID = sid.value::STRING
  GROUP BY 1, 2
),
sb AS (
  SELECT candidate_id, OBJECT_AGG(SOURCE_NAME, n::VARIANT) AS source_breakdown
  FROM sig_counts GROUP BY 1
)
SELECT
  cand.j:candidate_id::STRING,
  cand.j:agent_session_id::STRING,
  cand.j:chain_id::STRING,
  cand.j:iteration::NUMBER,
  cand.j:topic::STRING,
  cand.j:supporting_signal_ids,
  cand.j:confidence::FLOAT,
  cand.j:specificity_score::FLOAT,
  COALESCE(sb.source_breakdown, OBJECT_CONSTRUCT()),
  cand.j:bucket::STRING,
  cand.j:verdict::STRING,
  cand.j:evidence_added,
  cand.j:reasoning::STRING,
  cand.j:reasoning_trace,
  cand.j:dedup_of_trend_id::STRING
FROM cand LEFT JOIN sb ON sb.candidate_id = cand.j:candidate_id::STRING
`;

const UPDATE_QUEUE_SQL = `
UPDATE MCC_RAW.MARKETING_DEV.STG_REVISIT_BATCH_QUEUE
SET STATUS = ?, CANDIDATES_COUNT = ?, COST_USD = ?, RUN_DURATION_MS = ?,
    ERROR = ?, UPDATED_AT = CURRENT_TIMESTAMP()
WHERE CHAIN_ID = ? AND BATCH_INDEX = ?
`;

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
    parsed: { type: "any" },
  },
  async run({ $ }) {
    const p = this.parsed || {};

    if (p.skipped === true) {
      console.log("commit_batch_result: parsed.skipped — no commit/update");
      $.export("$summary", "skipped (no batch this run)");
      return { skipped: true };
    }

    const status = p.error ? "FAILED" : "DONE";
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
      // Only INSERT when there are candidates — driver is unhappy with
      // an empty FLATTEN, and skipping the round-trip is faster.
      if (p.candidates_count > 0 && p.candidates_json && p.candidates_json !== "[]") {
        await execute(conn, INSERT_CANDIDATES_SQL, [p.candidates_json]);
        console.log(
          `commit_batch_result: inserted ${p.candidates_count} candidates ` +
          `(chain=${p.chain_id} batch=${p.batch_index})`,
        );
      } else {
        console.log(
          `commit_batch_result: 0 candidates to insert ` +
          `(chain=${p.chain_id} batch=${p.batch_index} status=${status})`,
        );
      }

      await execute(conn, UPDATE_QUEUE_SQL, [
        status,
        Number(p.candidates_count) || 0,
        Number(p.cost_usd) || 0,
        Number(p.run_duration_ms) || 0,
        p.error || null,
        p.chain_id,
        p.batch_index,
      ]);

      $.export("$summary", `${status}: ${p.candidates_count || 0} candidates`);
      return {
        skipped: false,
        status,
        chain_id: p.chain_id,
        batch_index: p.batch_index,
        candidates_committed: p.candidates_count || 0,
      };
    } finally {
      await destroy(conn);
    }
  },
});
