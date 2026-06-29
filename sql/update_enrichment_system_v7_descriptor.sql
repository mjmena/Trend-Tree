-- Phase 3 enrichment.agent.system v7 — trend descriptor (ADR-0003, issue #52)
--
-- The enrichment agent now authors a machine-facing trend descriptor
-- { statement, query } plus a self-predicted specificity_score on every
-- run. The authoritative field-level rules live in the propose_enrichment
-- tool schema (sourced from agents/lib/descriptor.mjs); this prompt adds
-- the process step + a guardrail so the agent knows to author it and in
-- which register (machine-facing, de-buzzworded — the opposite of the
-- action-oriented summaries).
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
      REPLACE(
        TEMPLATE,
        '9. CALL propose_enrichment with the complete record, including the typed `evidence` pool and all 10 name candidates with scores. Call this exactly ONCE.',
        '9. AUTHOR the trend descriptor — descriptor.statement (a faithful, de-buzzworded 2-4 sentence machine-register prose core; this becomes the trend''s embedding seed) and descriptor.query (a single atomic, consumer-vernacular search term a shopper would type — not the compound behavior, a coined label, or industry jargon), per the descriptor field rules in the propose_enrichment schema. Also self-predict specificity_score (0.0-1.0).' || CHR(10) ||
        '10. CALL propose_enrichment with the complete record, including the typed `evidence` pool, all 10 name candidates with scores, and the descriptor. Call this exactly ONCE.'
      ),
      '10. END your turn with a brief text block summarizing what you decided and why.',
      '11. END your turn with a brief text block summarizing what you decided and why.'
    ),
    '- summary_short and summary_long are ACTION-oriented: lead with what consumers are DOING or BUYING, not with what''s "trending" or "growing".',
    '- summary_short and summary_long are ACTION-oriented: lead with what consumers are DOING or BUYING, not with what''s "trending" or "growing".' || CHR(10) ||
    '- The descriptor is the OPPOSITE register: machine-facing, de-buzzworded, no marketing flavor or call-to-action. descriptor.statement is faithful prose (the embedding seed); descriptor.query is one atomic consumer-vernacular search term (the join key to external keyword APIs). Author both on every run.'
  ) AS TEMPLATE,
  MODEL_PARAMS,
  TRUE AS IS_ACTIVE,
  SHA2(CONCAT('enrichment.agent.system.v7', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'adr0003_trend_descriptor_#52' AS CREATED_BY,
  'v7: adds the trend descriptor { statement, query } + specificity_score authoring step and a machine-register guardrail (ADR-0003). Field rules canonical in propose_enrichment schema / agents/lib/descriptor.mjs.' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'enrichment.agent.system'
  AND VERSION = 6
  AND IS_ACTIVE = TRUE;

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'enrichment.agent.system'
  AND VERSION = 6;

-- Verify: only v7 active; v7 carries the descriptor language; the three
-- REPLACE()s all landed (else the markers below read MISSING).
SELECT VERSION, IS_ACTIVE,
  CASE WHEN TEMPLATE ILIKE '%9. AUTHOR the trend descriptor%' THEN 'ok' ELSE 'MISSING step9' END AS STEP9,
  CASE WHEN TEMPLATE ILIKE '%11. END your turn%' THEN 'ok' ELSE 'MISSING step11' END AS STEP11,
  CASE WHEN TEMPLATE ILIKE '%The descriptor is the OPPOSITE register%' THEN 'ok' ELSE 'MISSING guardrail' END AS GUARDRAIL
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'enrichment.agent.system'
ORDER BY VERSION;
