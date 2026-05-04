-- Append-only ledger of every audit-agent run.
-- Owned by audit-agent — written once per scheduled (or HTTP-triggered) sweep.
--
-- One row = one full pipeline health audit. REPORT VARIANT carries the
-- agent's structured emission (overall_status, ingestion/distillation/
-- promotion/enrichment/lifecycle/dashboard sub-blocks, cost rollup); ALERTS
-- VARIANT is the flattened list of `{severity, area, summary, evidence}`
-- objects the Slack post is rendered from.
--
-- "Current state" for ops dashboards = latest row by EVALUATED_AT.
-- Trends over time (alert frequency, cost burn) come from grouping over
-- this table.
--
-- Different grain than the legacy MCC_PRESENTATION.TREND_AGENT.FCT_TREND_AUDIT_LOG
-- (per-trend, orphaned from the deleted audit-p_pWCwPyL agent). Not revived
-- by this work; consider dropping in a follow-up cleanup PR.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_AUDIT_LEDGER (
  AUDIT_ID            VARCHAR(64)          DEFAULT UUID_STRING() PRIMARY KEY,
  EVALUATED_AT        TIMESTAMP_NTZ        DEFAULT CURRENT_TIMESTAMP(),
  CHAIN_ID            VARCHAR(64)                                COMMENT 'matches the chain_id stamped by audit-agent normalize_event',
  TRIGGER_KIND        VARCHAR(16)                                COMMENT 'cron | http',
  OVERALL_STATUS      VARCHAR(8)                                 COMMENT 'GREEN | YELLOW | RED',
  WORKFLOWS_AUDITED   NUMBER                                     COMMENT 'how many Pipedream workflows were inspected this run',
  ALERT_COUNT         NUMBER                                     COMMENT 'count of alerts in REPORT.alerts',
  REPORT              VARIANT                                    COMMENT 'full agent emission: ingestion, distillation, promotion, enrichment, lifecycle, dashboard sub-blocks, alerts[], slack_summary_md',
  ALERTS              VARIANT                                    COMMENT 'flattened {severity, area, summary, evidence} list extracted from REPORT for cheap filtering',
  COST_24H_USD        FLOAT                                      COMMENT 'rolling 24h spend reported by the agent (UNION across the three agent ledgers)',
  AGENT_COST_USD      FLOAT                                      COMMENT 'this audit run cost (Gemini tokens)',
  INPUT_TOKENS        NUMBER,
  OUTPUT_TOKENS       NUMBER,
  MODEL_USED          VARCHAR(128)
);
