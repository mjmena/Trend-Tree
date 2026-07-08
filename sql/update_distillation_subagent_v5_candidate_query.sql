-- Distillation distillation.subagent.system v5 — atomic candidate query (ADR-0004, issue #59)
--
-- Companion to distillation.lead.system v7. Slice-1 (#59) added the query
-- authoring STEP to the lead prompt and the persist mapping to
-- distillation-p_mkCBBqb, but the `query` schema field + prompt step never
-- reached the ACTIVE authoring path (lead p_mkCBBqb + subagent p_jmCjj3J) —
-- they landed on the non-writing distillation-cluster-agent-p_YyC89Ke instead.
-- Result: ~21% QUERY coverage, ET fed compound topic names, 0 rescues.
--
-- This adds the query-authoring step to the subagent so the agent that does
-- the deep per-hypothesis investigation surfaces an atomic `query` on every
-- propose_trend_candidate call. The lead (v7) then persists it. Field-level
-- rule text is canonical in the propose_trend_candidate schema
-- (agents/lib/descriptor.mjs ATOMIC_QUERY_RULE); this prompt adds the process
-- instruction so the subagent knows to author it, plus a guardrail.
--
-- Derives v5 from v4 with surgical REPLACE()s, then deactivates v4.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  PROMPT_KEY,
  5 AS VERSION,
  MODEL,
  REPLACE(
    REPLACE(
      TEMPLATE,
      'topic: the noun-verb description, ≤80 chars',
      'topic: the noun-verb description, ≤80 chars' || CHR(10) ||
      '      query: a single ATOMIC, consumer-vernacular search term — the ingredient, product, or practice a shopper would type into a search box (e.g. `head spa`, not `Japanese head spas / clinical scalp facials`). NOT the compound behavior, NOT a coined marketing label, NOT industry jargon, NOT a fresh -maxxing-style neologism catalogs lag on. This is the join key an external keyword catalog (Exploding Topics) is looked up by at promotion — reach for the plainest established term that still names THIS trend specifically.'
    ),
    'Be opinionated. The lead is counting on you to filter.',
    'Be opinionated. The lead is counting on you to filter.' || CHR(10) || CHR(10) ||
    'Every accepted candidate needs an atomic `query` (see step 4) — the plain consumer search term (e.g. `snail mucin`), not the clever coined name. It is graded on whether external keyword catalogs recognize it, and the lead persists it as the candidate query.'
  ) AS TEMPLATE,
  MODEL_PARAMS,
  TRUE AS IS_ACTIVE,
  SHA2(CONCAT('distillation.subagent.system.v5', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'adr0004_candidate_query_#59' AS CREATED_BY,
  'v5: adds the atomic candidate query authoring step + guardrail (ADR-0004, #59). Companion to lead v7. Rule canonical in propose_trend_candidate schema / agents/lib/descriptor.mjs ATOMIC_QUERY_RULE.' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'distillation.subagent.system'
  AND VERSION = 4
  AND IS_ACTIVE = TRUE;

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'distillation.subagent.system'
  AND VERSION = 4;

-- Verify: only v5 active; both REPLACE()s landed (else markers read MISSING).
SELECT VERSION, IS_ACTIVE,
  CASE WHEN TEMPLATE ILIKE '%query: a single ATOMIC%' THEN 'ok' ELSE 'MISSING step4' END AS STEP4,
  CASE WHEN TEMPLATE ILIKE '%Every accepted candidate needs an atomic `query`%' THEN 'ok' ELSE 'MISSING guardrail' END AS GUARDRAIL
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'distillation.subagent.system'
ORDER BY VERSION;
