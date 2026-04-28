-- migrate_prompts_promotion_to_gemini.sql
--
-- Bumps the two promotion subagent prompts from v1 (Claude Sonnet 4.6) to
-- v2 (Gemini 3.1 Pro). Template text is copied from v1 verbatim — only
-- MODEL and MODEL_PARAMS change. The MODEL_PARAMS shape changes:
-- `thinking_budget_tokens: 2000` (Anthropic) → `thinking_level: "medium"`
-- (Gemini named-level enum).
--
-- After v2 is inserted, v1 is deactivated (IS_ACTIVE = FALSE) so the
-- prompt loader picks up v2 only.
--
-- Idempotent: NOT EXISTS guards on (PROMPT_KEY, VERSION=2). Re-runs no-op.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

-- ════════════════════════════════════════════════════════════════════════
-- 1. promotion.subagent.system v2
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'promotion.subagent.system',
    2,
    'gemini-3.1-pro-preview',
    TEMPLATE,
    PARSE_JSON('{"max_iterations": 6, "budget_usd": 0.15, "per_call_max_tokens": 3072, "thinking_level": "medium"}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'promotion.subagent.system', 'v2'), 256),
    'gemini_migration',
    'v2 — model swap claude-sonnet-4-6 → gemini-3.1-pro-preview. MODEL_PARAMS replaces thinking_budget_tokens=2000 with thinking_level="medium". Template unchanged from v1.'
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'promotion.subagent.system'
  AND VERSION = 1
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
     WHERE PROMPT_KEY = 'promotion.subagent.system' AND VERSION = 2
  );

-- ════════════════════════════════════════════════════════════════════════
-- 2. promotion.subagent.decision_rubric v2
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'promotion.subagent.decision_rubric',
    2,
    'gemini-3.1-pro-preview',
    TEMPLATE,
    MODEL_PARAMS,
    TRUE,
    SHA2(CONCAT_WS(':', 'promotion.subagent.decision_rubric', 'v2'), 256),
    'gemini_migration',
    'v2 — model swap to gemini-3.1-pro-preview. Template + MODEL_PARAMS unchanged from v1; substituted into promotion.subagent.system as {{decision_rubric}}.'
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'promotion.subagent.decision_rubric'
  AND VERSION = 1
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
     WHERE PROMPT_KEY = 'promotion.subagent.decision_rubric' AND VERSION = 2
  );

-- ════════════════════════════════════════════════════════════════════════
-- 3. Deactivate v1 (only if v2 was inserted successfully)
-- ════════════════════════════════════════════════════════════════════════

UPDATE DIM_LLM_PROMPT
   SET IS_ACTIVE = FALSE
 WHERE PROMPT_KEY IN ('promotion.subagent.system', 'promotion.subagent.decision_rubric')
   AND VERSION = 1
   AND IS_ACTIVE = TRUE
   AND EXISTS (
     SELECT 1 FROM DIM_LLM_PROMPT v2
      WHERE v2.PROMPT_KEY = DIM_LLM_PROMPT.PROMPT_KEY
        AND v2.VERSION = 2
   );

-- ════════════════════════════════════════════════════════════════════════
-- 4. Verification — run interactively to confirm the swap landed
-- ════════════════════════════════════════════════════════════════════════

SELECT PROMPT_KEY, VERSION, MODEL, IS_ACTIVE, MODEL_PARAMS
  FROM DIM_LLM_PROMPT
 WHERE PROMPT_KEY LIKE 'promotion.subagent.%'
 ORDER BY PROMPT_KEY, VERSION;
