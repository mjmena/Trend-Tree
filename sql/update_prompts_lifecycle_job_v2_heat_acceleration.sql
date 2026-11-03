-- update_prompts_lifecycle_job_v2_heat_acceleration.sql
--
-- CRMA-1685 (2026-11-02): heat velocity becomes acceleration over the trend's
-- own weekly baseline, and breadth saturates at 10 publishers instead of 6.
-- v2 updates the two formula lines in lifecycle.job.system's HEAT block so the
-- prompt describes the formula computeHeatBase() runs. Heat stays computed in
-- code; the agent never reads these lines as instructions.
--
-- Surgical REPLACE over the live v1 TEMPLATE — nothing else changes. The
-- INSERT runs only if v1 contains both exact lines it replaces, so a drifted
-- v1 inserts nothing. The deactivating UPDATE runs only once v2 exists, so a
-- failed INSERT never leaves the key with no active row. Re-runnable.
--
-- The same commit bumps ('lifecycle.job.system', 2) in the audit agent's
-- q_prompt_drift manifest (both sql.value and sql.query). Run this when the
-- CRMA-1685 job revision is promoted, not before.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

BEGIN;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'lifecycle.job.system',
    2,
    p.MODEL,
    p.TPL,
    p.MODEL_PARAMS,
    TRUE,
    MD5(p.TPL),
    'marty',
    'v2 CRMA-1685: heat velocity = acceleration over the 8-35d weekly baseline; breadth anchored at 10 publishers'
FROM (
    SELECT *, REPLACE(REPLACE(TEMPLATE,
        '  velocity = min(1, linked_signals_last_7d / 3)',
        '  velocity = clamp((linked_signals_last_7d - baseline) / max(3, baseline), 0, 1)\n             baseline = linked signals 8-35d ago / 4 (weekly); a steady flow scores ~0'),
        '             (6 evenly-distributed domains = full 40 pts) × shannon entropy',
        '             (10 evenly-distributed domains = full 40 pts) × shannon entropy') AS TPL
    FROM DIM_LLM_PROMPT
) p
WHERE p.PROMPT_KEY = 'lifecycle.job.system'
  AND p.VERSION = 1
  AND CONTAINS(p.TEMPLATE, '  velocity = min(1, linked_signals_last_7d / 3)')
  AND CONTAINS(p.TEMPLATE, '             (6 evenly-distributed domains = full 40 pts) × shannon entropy')
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.job.system' AND VERSION = 2
  );

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'lifecycle.job.system' AND IS_ACTIVE = TRUE AND VERSION < 2
  AND EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.job.system' AND VERSION = 2
  );

COMMIT;
