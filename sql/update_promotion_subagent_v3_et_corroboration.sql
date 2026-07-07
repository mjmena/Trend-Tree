-- Promotion subagent prompts v3 — ET corroboration oracle (ADR-0004, issue #60)
--
-- The promotion subagent gains the verify_exploding_topics tool and now
-- receives single-source-family "ET-rescue" candidates the old gate would have
-- auto-rejected. Two prompt updates:
--   promotion.subagent.system         v2 -> v3: inject {{et_rescue_block}} +
--       (block text is built in handle_request; renders empty for non-rescue)
--   promotion.subagent.decision_rubric v2 -> v3: replace the now-stale
--       "Quality gate" section with the new classifier + an ET-RESCUE branch
--       carrying the additive-only constraint.
--
-- Field/tool rules are canonical in the verify_exploding_topics schema +
-- agents/lib/exploding_topics.mjs; these prompts add the process + guardrail.

-- ── promotion.subagent.system v3 ────────────────────────────────────────────
INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  PROMPT_KEY, 3 AS VERSION, MODEL,
  REPLACE(
    TEMPLATE,
    'NEIGHBOR POOL ({{neighbor_count}} surfaced):' || CHR(10) || '{{neighbor_blocks}}' || CHR(10) || CHR(10) || 'DECISION RUBRIC:',
    'NEIGHBOR POOL ({{neighbor_count}} surfaced):' || CHR(10) || '{{neighbor_blocks}}' || CHR(10) || CHR(10) ||
    '{{et_rescue_block}}' || CHR(10) || CHR(10) || 'DECISION RUBRIC:'
  ) AS TEMPLATE,
  MODEL_PARAMS, TRUE AS IS_ACTIVE,
  SHA2(CONCAT('promotion.subagent.system.v3', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'adr0004_et_corroboration_#60' AS CREATED_BY,
  'v3: inject {{et_rescue_block}} so single-family ET-rescue candidates get the ET verify instruction (ADR-0004).' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'promotion.subagent.system' AND VERSION = 2 AND IS_ACTIVE = TRUE;

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE WHERE PROMPT_KEY = 'promotion.subagent.system' AND VERSION = 2;

-- ── promotion.subagent.decision_rubric v3 ───────────────────────────────────
INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  PROMPT_KEY, 3 AS VERSION, MODEL,
  REPLACE(
    TEMPLATE,
    '═══ Quality gate (mechanical pre-check, not for LLM) ═══' || CHR(10) || CHR(10) ||
    'REJECT (decision_category: LOW_QUALITY) is auto-applied BEFORE you see the' || CHR(10) ||
    'candidate when any of these fail:' || CHR(10) ||
    '  - cluster_size < 3' || CHR(10) ||
    '  - source_families < 2 (counts distinct platforms, not raw source names — amazon_movers + amazon_trends together count as ONE family `amazon`)' || CHR(10) ||
    '  - confidence < 0.3' || CHR(10) ||
    '  - specificity_score < 0.3' || CHR(10) || CHR(10) ||
    'If you receive a candidate, it has already passed this gate.',
    '═══ Classifier (mechanical pre-check, not for LLM) ═══' || CHR(10) || CHR(10) ||
    'Before you see a candidate the lead classifier routes it (ADR-0004):' || CHR(10) ||
    '  - >=2 independent source families -> routed to you normally.' || CHR(10) ||
    '  - exactly ONE source family but confidence >= 0.5 AND specificity >= 0.5 -> routed to you as an ET-RESCUE candidate (see below).' || CHR(10) ||
    '  - one source family and below those thresholds -> auto-REJECT (LOW_QUALITY); you never see it.' || CHR(10) ||
    '(source_families counts distinct platforms, not raw names — amazon_movers + amazon_trends together count as ONE family `amazon`.)' || CHR(10) || CHR(10) ||
    '═══ ET-RESCUE candidates (single source family) ═══' || CHR(10) || CHR(10) ||
    'An ET-rescue candidate has only ONE independent signal source family, so it fails the two-source doctrine on signals alone. Your prompt flags it. You MUST call verify_exploding_topics with the candidate_query before deciding:' || CHR(10) ||
    '  - Exploding Topics is an INDEPENDENT external search-demand catalog. If it recognizes the SAME concept (your judgment — the match is fuzzy) AND the keyword has meaningful absolute_volume, ET counts as the missing SECOND source family -> PROMOTE_NEW (decision_category: CONFIRM_NEW), et_was_second_source=true, et_matched_keyword set.' || CHR(10) ||
    '  - If ET misses, returns a different concept, or the volume is trivial, the candidate stays single-family -> REJECT (rejection_reason NO_SECOND_SOURCE).' || CHR(10) ||
    '  - ADDITIVE-ONLY: ET can only SUPPLY a missing family. A miss, a peaked classification, or negative growth NEVER removes a candidate that already has two real source families, and classifications/growth are never disqualifying — the gate asks whether this is a real movement independent parties recognize, not whether it is surging right now.'
  ) AS TEMPLATE,
  MODEL_PARAMS, TRUE AS IS_ACTIVE,
  SHA2(CONCAT('promotion.subagent.decision_rubric.v3', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'adr0004_et_corroboration_#60' AS CREATED_BY,
  'v3: replace stale Quality-gate section with the ADR-0004 classifier + ET-RESCUE branch (additive-only constraint).' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'promotion.subagent.decision_rubric' AND VERSION = 2 AND IS_ACTIVE = TRUE;

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE WHERE PROMPT_KEY = 'promotion.subagent.decision_rubric' AND VERSION = 2;

-- Verify: v3 active for both; markers landed.
SELECT PROMPT_KEY, VERSION, IS_ACTIVE,
  CASE WHEN TEMPLATE ILIKE '%{{et_rescue_block}}%' OR TEMPLATE ILIKE '%ET-RESCUE%' THEN 'ok' ELSE 'MISSING' END AS ET_MARKER
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY IN ('promotion.subagent.system','promotion.subagent.decision_rubric')
ORDER BY PROMPT_KEY, VERSION;
