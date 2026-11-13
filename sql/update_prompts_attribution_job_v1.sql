-- signal.attribution.job.system v1: the tool-free, one-JSON-answer variant of the
-- live signal.attribution.system v1, by guarded REPLACEs (a drifted source inserts
-- nothing). per_call_max_tokens = 8192; thinking_level = medium, the level the
-- Pipedream loop defaulted to and the cost estimate assumed. Re-runnable.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

BEGIN;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'signal.attribution.job.system',
    1,
    'gemini-3.8-flash',
    p.TPL,
    OBJECT_INSERT(OBJECT_INSERT(p.MODEL_PARAMS::OBJECT, 'per_call_max_tokens', 8192, TRUE), 'thinking_level', 'medium', TRUE),
    TRUE,
    MD5(p.TPL),
    'marty',
    'v1 CRMA-1737: one-shot JSON variant of signal.attribution.system v1 for the Cloud Run attribution job; tool wording removed'
FROM (
    SELECT *, REPLACE(REPLACE(REPLACE(TEMPLATE,
        '═══ AVAILABLE TOOLS ═══\n\n- `filter_candidates(min_similarity, source_filter)` — slice the candidate pool by similarity or source name. Use if you want to inspect a tighter cut before deciding.\n- `commit_attributions(attributions)` — write confirmed signal-trend links. Call exactly once. Pass an array of { signal_id, link_type } objects. link_type must be one of: news | social | commerce | other.\n\n', ''),
        'Call `commit_attributions` exactly once with the confirmed list. Pass an empty array if nothing qualifies',
        'Return one JSON object whose `attributions` array holds the confirmed { signal_id, link_type } pairs. link_type must be one of: news | social | commerce | other. Return an empty array if nothing qualifies'),
        ' — and commit those links so', ' — so') AS TPL
    FROM DIM_LLM_PROMPT
) p
WHERE p.PROMPT_KEY = 'signal.attribution.system'
  AND p.VERSION = 1
  AND CONTAINS(p.TEMPLATE, '═══ AVAILABLE TOOLS ═══\n\n- `filter_candidates(min_similarity, source_filter)` — slice the candidate pool by similarity or source name. Use if you want to inspect a tighter cut before deciding.\n- `commit_attributions(attributions)` — write confirmed signal-trend links. Call exactly once. Pass an array of { signal_id, link_type } objects. link_type must be one of: news | social | commerce | other.\n\n')
  AND CONTAINS(p.TEMPLATE, 'Call `commit_attributions` exactly once with the confirmed list. Pass an empty array if nothing qualifies')
  AND CONTAINS(p.TEMPLATE, ' — and commit those links so')
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'signal.attribution.job.system' AND VERSION = 1
  );

COMMIT;
