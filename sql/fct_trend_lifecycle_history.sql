-- Append-only audit trail for every lifecycle-agent evaluation.
-- One row per (trend, eval) regardless of outcome (status change or no-op).
--
-- Two-cycle retire confirm: the lifecycle commit step reads the prior row
-- for the same TREND_ID. If both this eval AND the prior eval set
-- RETIREMENT_PROPOSAL (non-null VARIANT), commit applies the RETIRED
-- transition. Single-cycle retirement proposals get logged here but do NOT
-- flip LIFECYCLE_STATUS — that's the safety guard.
--
-- DECISION_PAYLOAD is the full agent emission (the propose_lifecycle_decision
-- terminal-tool argument). REASONING is the short ≤500-char rationale.
-- TOOL_CALLS_JSON is the per-call audit even though lifecycle's tools are
-- all in-process (no live HTTP) — useful for spotting prompt drift.
--
-- Mirrors the shape and conventions of FCT_PROMOTION_AUDIT.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_HISTORY (
  LIFECYCLE_EVAL_ID        VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
  TREND_ID                 VARCHAR NOT NULL,
  EVALUATED_AT             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  AGENT_SESSION_ID         VARCHAR                                  COMMENT 'lcy-sess-{6-char random}, set by the subagent',
  CHAIN_ID                 VARCHAR                                  COMMENT 'lcy-chain-{6-char random}, set by the sweeper for one cron tick',

  PRIOR_STATUS             VARCHAR(32)                              COMMENT 'LIFECYCLE_STATUS at start of eval',
  NEW_STATUS               VARCHAR(32)                              COMMENT 'LIFECYCLE_STATUS this eval committed (= prior if no change)',

  PRIOR_HEAT               FLOAT                                    COMMENT 'TREND_HEAT_INDEX before this eval',
  NEW_HEAT                 FLOAT                                    COMMENT 'TREND_HEAT_INDEX after this eval (= clamp(HEAT_BASE * (1+HEAT_MODIFIER_PCT/100), 0, 100))',
  HEAT_BASE                FLOAT                                    COMMENT 'pure-SQL baseline before LLM modifier (see plan: recency+velocity+breadth+external+confidence weights)',
  HEAT_MODIFIER_PCT        FLOAT                                    COMMENT 'agent-emitted modifier in [-20, 20]; clamped at commit',

  DECISION_PAYLOAD         VARIANT                                  COMMENT 'full propose_lifecycle_decision tool argument as emitted',
  REASONING                VARCHAR(4000)                            COMMENT 'short rationale (≤500 chars expected; column allows headroom)',
  REQUESTED_RE_ENRICHMENT  BOOLEAN  DEFAULT FALSE                   COMMENT 'TRUE if commit step POSTed to enrichment-p_xMC995w',
  RETIREMENT_PROPOSAL      VARIANT                                  COMMENT 'NULL except when agent proposed RETIRE this cycle; two-cycle confirm reads prior row to decide whether to commit',

  TOOL_CALLS_JSON          VARIANT                                  COMMENT 'ARRAY of {tool, args, result_summary} — in-process query tools the agent invoked',
  LLM_INPUT_TOKENS         NUMBER,
  LLM_OUTPUT_TOKENS        NUMBER,
  LLM_COST_ESTIMATE        FLOAT,
  MODEL_USED               VARCHAR DEFAULT 'claude-sonnet-4-6',
  STOP_REASON              VARCHAR                                  COMMENT 'end_turn | tool_use | max_tokens | budget_exhausted'
);
