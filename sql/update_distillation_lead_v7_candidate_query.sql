-- Distillation distillation.lead.system v7 — atomic candidate query (ADR-0004, issue #59)
--
-- The distillation lead now authors a short atomic, consumer-vernacular
-- `query` alongside each candidate `topic` on every propose_trend_candidate
-- call — the [candidate query], persisted to STG_TREND_CANDIDATES.QUERY. It is
-- the candidate-lineage precursor to descriptor.query (ADR-0003) and the join
-- key an external corroboration oracle (Exploding Topics) is looked up by at
-- promotion. Field-level rule text is canonical in the propose_trend_candidate
-- schema (agents/lib/descriptor.mjs ATOMIC_QUERY_RULE); this prompt adds the
-- process instruction so the lead knows to author it, plus a guardrail.
--
-- Derives v7 from v6 with surgical REPLACE()s, then deactivates v6.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  PROMPT_KEY,
  7 AS VERSION,
  MODEL,
  REPLACE(
    REPLACE(
      TEMPLATE,
      'subagents recommend, you persist.',
      'subagents recommend, you persist.' || CHR(10) || CHR(10) ||
      'When you register a candidate, ALSO author its `query`: a single ATOMIC, consumer-vernacular search term — the ingredient, product, or practice a shopper would type into a search box (e.g. `head spa`, not `Japanese head spas / clinical scalp facials`). NOT the compound behavior, NOT a coined marketing label, NOT industry jargon. This is the join key an external keyword catalog (Exploding Topics, Google Trends) is looked up by, so reach for the plainest established term that still names THIS trend specifically. Author a `query` for every accepted candidate.'
    ),
    '- Be opinionated about specificity. Reject more than you accept.',
    '- Be opinionated about specificity. Reject more than you accept.' || CHR(10) ||
    '- Every candidate needs an atomic `query` — the plain consumer search term (e.g. `snail mucin`), not the clever coined name. It is graded on whether external keyword catalogs recognize it.'
  ) AS TEMPLATE,
  MODEL_PARAMS,
  TRUE AS IS_ACTIVE,
  SHA2(CONCAT('distillation.lead.system.v7', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'adr0004_candidate_query_#59' AS CREATED_BY,
  'v7: adds the atomic candidate query authoring step + guardrail (ADR-0004, #59). Rule canonical in propose_trend_candidate schema / agents/lib/descriptor.mjs ATOMIC_QUERY_RULE.' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'distillation.lead.system'
  AND VERSION = 6
  AND IS_ACTIVE = TRUE;

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'distillation.lead.system'
  AND VERSION = 6;

-- Verify: only v7 active; both REPLACE()s landed (else markers read MISSING).
SELECT VERSION, IS_ACTIVE,
  CASE WHEN TEMPLATE ILIKE '%ALSO author its `query`%' THEN 'ok' ELSE 'MISSING step4' END AS STEP4,
  CASE WHEN TEMPLATE ILIKE '%Every candidate needs an atomic `query`%' THEN 'ok' ELSE 'MISSING guardrail' END AS GUARDRAIL
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'distillation.lead.system'
ORDER BY VERSION;
