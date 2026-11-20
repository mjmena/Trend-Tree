// Distillation Revisit Lead — commit_batch_result
//
// One TCP-connected Snowflake session does:
//   1. INSERT candidates with resolvable FCT_SIGNALS evidence, deriving
//      both SUPPORTING_SIGNAL_IDS and SOURCE_BREAKDOWN from those signals.
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
  TOPIC, QUERY, SUPPORTING_SIGNAL_IDS, CONFIDENCE, SPECIFICITY_SCORE,
  SOURCE_BREAKDOWN, BUCKET, VERDICT, EVIDENCE_ADDED,
  REASONING, REASONING_TRACE, DEDUP_OF_TREND_ID
)
WITH cand AS (
  SELECT c.value AS j FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) c
),
valid_pairs AS (
  SELECT DISTINCT cand.j:candidate_id::STRING AS candidate_id, f.SIGNAL_ID, f.SOURCE_NAME
  FROM cand, LATERAL FLATTEN(INPUT => cand.j:supporting_signal_ids) sid
  JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f ON f.SIGNAL_ID = sid.value::STRING
),
vs AS (
  SELECT candidate_id,
         ARRAY_AGG(SIGNAL_ID) WITHIN GROUP (ORDER BY SIGNAL_ID) AS supporting_signal_ids
  FROM valid_pairs GROUP BY 1
),
sig_counts AS (
  SELECT candidate_id, SOURCE_NAME, COUNT(*) AS n
  FROM valid_pairs GROUP BY 1, 2
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
  cand.j:query::STRING,
  vs.supporting_signal_ids,
  cand.j:confidence::FLOAT,
  cand.j:specificity_score::FLOAT,
  COALESCE(sb.source_breakdown, OBJECT_CONSTRUCT()),
  cand.j:bucket::STRING,
  cand.j:verdict::STRING,
  cand.j:evidence_added,
  cand.j:reasoning::STRING,
  cand.j:reasoning_trace,
  cand.j:dedup_of_trend_id::STRING
FROM cand
INNER JOIN vs ON vs.candidate_id = cand.j:candidate_id::STRING
LEFT JOIN sb ON sb.candidate_id = cand.j:candidate_id::STRING
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
      let candidatesCommitted = 0;
      // Only INSERT when there are candidates — driver is unhappy with
      // an empty FLATTEN, and skipping the round-trip is faster.
      if (p.candidates_count > 0 && p.candidates_json && p.candidates_json !== "[]") {
        const rows = await execute(conn, INSERT_CANDIDATES_SQL, [p.candidates_json]);
        candidatesCommitted = Number(rows?.[0]?.["number of rows inserted"]);
        if (!Number.isInteger(candidatesCommitted) || candidatesCommitted < 0) {
          throw new Error("Candidate INSERT did not return an affected-row count");
        }
      } else {
        console.log(
          `commit_batch_result: 0 candidates to insert ` +
          `(chain=${p.chain_id} batch=${p.batch_index} status=${status})`,
        );
      }

      const candidatesDropped = Math.max(0, (Number(p.candidates_count) || 0) - candidatesCommitted);
      console.log(
        `commit_batch_result: inserted ${candidatesCommitted}, dropped ${candidatesDropped} ` +
        `candidates without resolvable evidence (chain=${p.chain_id} batch=${p.batch_index})`,
      );

      await execute(conn, UPDATE_QUEUE_SQL, [
        status,
        candidatesCommitted,
        Number(p.cost_usd) || 0,
        Number(p.run_duration_ms) || 0,
        p.error || null,
        p.chain_id,
        p.batch_index,
      ]);

      $.export("$summary", `${status}: ${candidatesCommitted} committed, ${candidatesDropped} dropped`);
      return {
        skipped: false,
        status,
        chain_id: p.chain_id,
        batch_index: p.batch_index,
        candidates_committed: candidatesCommitted,
        candidates_dropped: candidatesDropped,
      };
    } finally {
      await destroy(conn);
    }
  },
});
