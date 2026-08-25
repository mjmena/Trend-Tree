-- audit.system v4 — DIM_LLM_PROMPT drift guardrail (CRMA-469)
--
-- Adds a {{prompt_drift_block}} context block and a `governance` report area
-- so the daily audit surfaces prompt versions that were edited live in
-- Snowflake without a committed sql/update_prompts_*.sql migration — the
-- exact gap that produced the 2026-07-10 drift audit and the
-- signal.attribution.rubric v2/v3 backfill (CRMA-469). The block text +
-- the manifest of committed versions live in q_prompt_drift (workflow.yaml)
-- and run_audit_agent/entry.js; this only injects the placeholder + the new
-- emission field. Derives v4 from v3, deactivates v3.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  PROMPT_KEY, 4 AS VERSION, MODEL,
  REPLACE(
    REPLACE(
      TEMPLATE,
      'data_hygiene        — { status, active_orphan_trends }' || CHR(10) ||
      'workflow_health     — { audited_count, active_count, errored_24h: [{workflow_name, count, top_error}] }',
      'data_hygiene        — { status, active_orphan_trends }' || CHR(10) ||
      'governance          — { status, prompt_drift_count, prompt_drift_keys }' || CHR(10) ||
      'workflow_health     — { audited_count, active_count, errored_24h: [{workflow_name, count, top_error}] }'
    ),
    'ET CORROBORATION ORACLE (ADR-0004 — single-family rescue funnel, last 24h):' || CHR(10) ||
    '{{et_rescue_block}}' || CHR(10) || CHR(10) ||
    '24H COST ROLLUP (per agent, per model):',
    'ET CORROBORATION ORACLE (ADR-0004 — single-family rescue funnel, last 24h):' || CHR(10) ||
    '{{et_rescue_block}}' || CHR(10) || CHR(10) ||
    'DIM_LLM_PROMPT DRIFT (governance tripwire — see rubric):' || CHR(10) ||
    '{{prompt_drift_block}}' || CHR(10) || CHR(10) ||
    '24H COST ROLLUP (per agent, per model):'
  ) AS TEMPLATE,
  MODEL_PARAMS, TRUE AS IS_ACTIVE,
  SHA2(CONCAT('audit.system.v4', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'crma469_prompt_drift_guardrail' AS CREATED_BY,
  'v4: adds {{prompt_drift_block}} + governance emission area — the DIM_LLM_PROMPT drift guardrail (CRMA-469).' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'audit.system' AND VERSION = 3 AND IS_ACTIVE = TRUE;

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE WHERE PROMPT_KEY = 'audit.system' AND VERSION = 3;

-- Verify: only v4 active; both placeholders landed.
SELECT VERSION, IS_ACTIVE,
  CASE WHEN TEMPLATE ILIKE '%{{prompt_drift_block}}%' THEN 'ok' ELSE 'MISSING' END AS DRIFT_BLOCK,
  CASE WHEN TEMPLATE ILIKE '%governance%prompt_drift_count%' THEN 'ok' ELSE 'MISSING' END AS GOVERNANCE_FIELD
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'audit.system' ORDER BY VERSION;
