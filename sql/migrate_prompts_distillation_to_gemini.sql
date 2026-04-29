-- migrate_prompts_distillation_to_gemini.sql
--
-- Bumps the two distillation prompts from v3 (Claude Sonnet 4.6) to v4
-- (Gemini 3.1 Pro). Template text is copied from v3 verbatim — only MODEL
-- and MODEL_PARAMS change. The MODEL_PARAMS shape changes:
-- `thinking_budget_tokens: <int>` (Anthropic) → `thinking_level: "medium"`
-- (Gemini named-level enum). budget_usd / max_iterations / per_call_max_tokens
-- are preserved.
--
-- After v4 is inserted, v3 is deactivated (IS_ACTIVE = FALSE) so the prompt
-- loader picks up v4 only.
--
-- Idempotent: NOT EXISTS guards on (PROMPT_KEY, VERSION=4). Re-runs no-op.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

-- ════════════════════════════════════════════════════════════════════════
-- 1. distillation.lead.system v4
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'distillation.lead.system',
    4,
    'gemini-3.1-pro-preview',
    TEMPLATE,
    PARSE_JSON('{"max_iterations": 20, "budget_usd": 5, "per_call_max_tokens": 8192, "temperature": 1, "thinking_level": "medium"}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'distillation.lead.system', 'v4'), 256),
    'gemini_migration',
    'v4 — model swap claude-sonnet-4-6 → gemini-3.1-pro-preview. MODEL_PARAMS replaces thinking_budget_tokens=5000 with thinking_level="medium". Template unchanged from v3.'
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'distillation.lead.system'
  AND VERSION = 3
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
     WHERE PROMPT_KEY = 'distillation.lead.system' AND VERSION = 4
  );

-- ════════════════════════════════════════════════════════════════════════
-- 2. distillation.subagent.system v4
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'distillation.subagent.system',
    4,
    'gemini-3.1-pro-preview',
    TEMPLATE,
    PARSE_JSON('{"max_iterations": 12, "budget_usd": 1, "per_call_max_tokens": 6000, "temperature": 1, "thinking_level": "medium"}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'distillation.subagent.system', 'v4'), 256),
    'gemini_migration',
    'v4 — model swap claude-sonnet-4-6 → gemini-3.1-pro-preview. MODEL_PARAMS replaces thinking_budget_tokens=3000 with thinking_level="medium". Template unchanged from v3.'
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'distillation.subagent.system'
  AND VERSION = 3
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
     WHERE PROMPT_KEY = 'distillation.subagent.system' AND VERSION = 4
  );

-- ════════════════════════════════════════════════════════════════════════
-- 3. Deactivate v3 (only if v4 was inserted successfully)
-- ════════════════════════════════════════════════════════════════════════

UPDATE DIM_LLM_PROMPT
   SET IS_ACTIVE = FALSE
 WHERE PROMPT_KEY IN ('distillation.lead.system', 'distillation.subagent.system')
   AND VERSION = 3
   AND IS_ACTIVE = TRUE
   AND EXISTS (
     SELECT 1 FROM DIM_LLM_PROMPT v4
      WHERE v4.PROMPT_KEY = DIM_LLM_PROMPT.PROMPT_KEY
        AND v4.VERSION = 4
   );

-- ════════════════════════════════════════════════════════════════════════
-- 4. Verification — run interactively to confirm the swap landed
-- ════════════════════════════════════════════════════════════════════════

SELECT PROMPT_KEY, VERSION, MODEL, IS_ACTIVE, MODEL_PARAMS
  FROM DIM_LLM_PROMPT
 WHERE PROMPT_KEY IN ('distillation.lead.system', 'distillation.subagent.system')
 ORDER BY PROMPT_KEY, VERSION;
