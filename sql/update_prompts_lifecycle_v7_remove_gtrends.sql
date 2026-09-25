-- update_prompts_lifecycle_v7_remove_gtrends.sql
--
-- CRMA-1313 (2026-09-25): the gtrends-poller is removed, so the lifecycle
-- subagent no longer prefetches FCT_TREND_GTRENDS_DAILY or renders
-- {{gtrends_block}}. v7 strips every Google Trends reference from both
-- lifecycle prompts:
--   - lifecycle.subagent.system: the "Google Trends is NOT a heat input"
--     paragraph and the GOOGLE TRENDS HISTORY context block
--   - lifecycle.subagent.decision_rubric: the "Google Trends history is
--     likewise advisory only" sentence
--
-- Surgical REPLACE over the live v6 TEMPLATE — nothing else changes.
-- Each INSERT runs only if v6 contains the exact text it removes, so a
-- drifted v6 inserts nothing. The deactivating UPDATE runs only once v7
-- exists, so a failed INSERT never leaves the key with no active row.
-- Atomic per key. Re-runnable.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

-- ════════════════════════════════════════════════════════════════════════
-- lifecycle.subagent.system v7
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'lifecycle.subagent.system',
    7,
    p.MODEL,
    p.TPL,
    p.MODEL_PARAMS,
    TRUE,
    MD5(p.TPL),
    'marty',
    'v7 CRMA-1313: gtrends-poller removed; GT heat-input paragraph and GOOGLE TRENDS HISTORY block dropped'
FROM (
    SELECT *, REPLACE(REPLACE(TEMPLATE,
        '\nGoogle Trends is NOT a heat input — demand-side evidence lives on the opportunity-score axis. The GT block below is advisory context only.\n', ''),
        'GOOGLE TRENDS HISTORY (last 30d — advisory only, not a heat input):\n{{gtrends_block}}\n\n', '') AS TPL
    FROM DIM_LLM_PROMPT
) p
WHERE p.PROMPT_KEY = 'lifecycle.subagent.system'
  AND p.VERSION = 6
  AND CONTAINS(p.TEMPLATE, '\nGoogle Trends is NOT a heat input — demand-side evidence lives on the opportunity-score axis. The GT block below is advisory context only.\n')
  AND CONTAINS(p.TEMPLATE, 'GOOGLE TRENDS HISTORY (last 30d — advisory only, not a heat input):\n{{gtrends_block}}\n\n')
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.subagent.system' AND VERSION = 7
  );

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'lifecycle.subagent.system' AND IS_ACTIVE = TRUE AND VERSION < 7
  AND EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.subagent.system' AND VERSION = 7
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- lifecycle.subagent.decision_rubric v7
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'lifecycle.subagent.decision_rubric',
    7,
    p.MODEL,
    p.TPL,
    p.MODEL_PARAMS,
    TRUE,
    MD5(p.TPL),
    'marty',
    'v7 CRMA-1313: gtrends-poller removed; GT advisory sentence dropped'
FROM (
    SELECT *, REPLACE(TEMPLATE,
        ' Google Trends history is likewise advisory only (~80% of trends have no GT row on a given day — its absence means nothing).', '') AS TPL
    FROM DIM_LLM_PROMPT
) p
WHERE p.PROMPT_KEY = 'lifecycle.subagent.decision_rubric'
  AND p.VERSION = 6
  AND CONTAINS(p.TEMPLATE, ' Google Trends history is likewise advisory only (~80% of trends have no GT row on a given day — its absence means nothing).')
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.subagent.decision_rubric' AND VERSION = 7
  );

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'lifecycle.subagent.decision_rubric' AND IS_ACTIVE = TRUE AND VERSION < 7
  AND EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.subagent.decision_rubric' AND VERSION = 7
  );

COMMIT;
