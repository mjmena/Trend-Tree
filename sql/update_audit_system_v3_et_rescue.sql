-- audit.system v3 — ET corroboration-oracle rescue funnel (ADR-0004)
--
-- Adds an {{et_rescue_block}} context block so the daily audit surfaces the
-- health of the new single-family ET-rescue path (candidate QUERY authoring
-- coverage + the rescue funnel: consulted -> rescued/rejected + ledger accrual).
-- It is the one net-new metric ADR-0004 introduced that nothing else watched.
-- The block text + interpretation notes are built in run_audit_agent/entry.js;
-- this only injects the placeholder. Derives v3 from v2, deactivates v2.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  PROMPT_KEY, 3 AS VERSION, MODEL,
  REPLACE(
    TEMPLATE,
    '{{orphan_trends_block}}',
    '{{orphan_trends_block}}' || CHR(10) || CHR(10) ||
    'ET CORROBORATION ORACLE (ADR-0004 — single-family rescue funnel, last 24h):' || CHR(10) ||
    '{{et_rescue_block}}'
  ) AS TEMPLATE,
  MODEL_PARAMS, TRUE AS IS_ACTIVE,
  SHA2(CONCAT('audit.system.v3', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'adr0004_et_rescue_funnel' AS CREATED_BY,
  'v3: adds {{et_rescue_block}} — the ET-rescue funnel health metric (ADR-0004).' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'audit.system' AND VERSION = 2 AND IS_ACTIVE = TRUE;

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE WHERE PROMPT_KEY = 'audit.system' AND VERSION = 2;

-- Verify: only v3 active; placeholder landed.
SELECT VERSION, IS_ACTIVE,
  CASE WHEN TEMPLATE ILIKE '%{{et_rescue_block}}%' THEN 'ok' ELSE 'MISSING' END AS ET_BLOCK
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'audit.system' ORDER BY VERSION;
