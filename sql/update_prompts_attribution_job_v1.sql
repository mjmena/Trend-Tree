-- update_prompts_attribution_job_v1.sql
--
-- CRMA-1737 (spec docs/prd/attribution-job.md "The prompt migration"): the
-- Cloud Run attribution job makes ONE structured-JSON request per trend
-- (Gemini batch), with no tools. It gets its own system prompt key,
-- signal.attribution.job.system v1, so the Pipedream loop's
-- signal.attribution.system stays untouched until the cut-over.
-- signal.attribution.rubric stays shared.
--
-- Surgical REPLACE over the live signal.attribution.system v1 TEMPLATE: the
-- three EDITS of docs/wayfinder/assets/crma-1687/run.mjs (oneShotSystem). Each
-- replaced string has its own CONTAINS guard, so a drifted source inserts
-- nothing. MODEL = the job's JOB_MODEL; MODEL_PARAMS copied with
-- per_call_max_tokens = 8192. New key: there is no prior version to
-- deactivate. Re-runnable (NOT EXISTS).
--
-- The same commit adds ('signal.attribution.job.system', 1) to the audit
-- agent's q_prompt_drift manifest (both sql.value and sql.query).

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

BEGIN;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'signal.attribution.job.system',
    1,
    'gemini-3.8-flash',
    p.TPL,
    OBJECT_INSERT(p.MODEL_PARAMS::OBJECT, 'per_call_max_tokens', 8192, TRUE),
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
