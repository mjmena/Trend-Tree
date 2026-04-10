-- Fact: Autonomous audit agent decision log
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Every pass of the audit agent (agents/audit-p_pWCwPyL) writes one row per
-- candidate it considered, including what the rule layer surfaced, what the
-- LLM proposed, what actually ran after the allow-list guardrail, and the
-- result of that action. Serves two purposes:
--   1. Audit trail — "why did the agent split this trend?"
--   2. Idempotency — q_split_candidates / q_category_drift exclude TREND_IDs
--      present here in the last 24h to prevent loops.
--
-- Chain semantics: one "chain" = one cron-fired run and any self-retriggered
-- iterations that follow it. CHAIN_ID groups them, ITERATION orders them.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_AUDIT_LOG (
    AUDIT_ID        VARCHAR DEFAULT UUID_STRING(),
    CHAIN_ID        VARCHAR NOT NULL,
    ITERATION       NUMBER  NOT NULL,
    AUDITED_AT      TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),

    TREND_ID        VARCHAR,                 -- NULL for HEALTH_SNAPSHOT rows
    AUDIT_TYPE      VARCHAR NOT NULL,        -- SPLIT_CANDIDATE | CATEGORY_DRIFT | STALLED_QUEUE | HEALTH_SNAPSHOT

    FINDING         VARIANT,                 -- rule-level evidence (sizes, deltas, reasons)
    ACTION_PROPOSED VARCHAR,                 -- what the LLM proposed
    ACTION_TAKEN    VARCHAR,                 -- SPLIT | REQUEUE_FULL | REQUEUE_REFRESH | UNSTALL_QUEUE | FLAG_ONLY | NONE
    ACTION_RESULT   VARIANT,                 -- e.g. PROC_SPLIT_TREND return JSON, or { error: ... }

    LLM_REASONING   VARCHAR,
    LLM_CONFIDENCE  FLOAT,
    LLM_COST_USD    FLOAT,

    PRIMARY KEY (AUDIT_ID)
);
