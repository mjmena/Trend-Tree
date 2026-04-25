-- Add prompt-version tracking to the LLM call audit log.
--
-- Joins each call back to the DIM_LLM_PROMPT row that produced it. Enables
-- retrospective A/B: "compare avg VALUE_SCORE for trends produced by
-- enrichment.claude.synthesize v2 vs v3 over the past 14d".
--
-- Backwards compatible: columns are nullable so legacy rows (and any LLM
-- caller that doesn't pass the new fields) continue to work.

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_LLM_PROMPT_LOGS
    ADD COLUMN IF NOT EXISTS PROMPT_KEY VARCHAR;

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_LLM_PROMPT_LOGS
    ADD COLUMN IF NOT EXISTS PROMPT_VERSION INTEGER;

COMMENT ON COLUMN MCC_RAW.MARKETING_DEV.STG_LLM_PROMPT_LOGS.PROMPT_KEY IS
'FK to DIM_LLM_PROMPT.PROMPT_KEY. NULL for legacy rows or callers not using the registry.';

COMMENT ON COLUMN MCC_RAW.MARKETING_DEV.STG_LLM_PROMPT_LOGS.PROMPT_VERSION IS
'FK to DIM_LLM_PROMPT.VERSION. Pinned at call time so prompt edits do not retroactively change historical attribution.';
