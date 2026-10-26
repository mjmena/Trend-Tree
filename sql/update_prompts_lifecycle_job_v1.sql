-- update_prompts_lifecycle_job_v1.sql
--
-- CRMA-1678 (decision CRMA-1649, spec docs/prd/lifecycle-job.md "The prompt
-- migration"): the Cloud Run lifecycle job makes ONE structured-JSON request
-- per trend (Gemini batch), with no tools. It gets its own system prompt key,
-- lifecycle.job.system v1, so the Pipedream loop's lifecycle.subagent.system
-- stays untouched. lifecycle.subagent.decision_rubric stays shared.
--
-- Surgical REPLACE over the live lifecycle.subagent.system v7 TEMPLATE — the
-- seven replacements from docs/wayfinder/assets/crma-1647/oneshot.mjs (EDITS +
-- RETIRE_NOTE). Each replaced string has its own CONTAINS guard, so a drifted
-- source inserts nothing. MODEL = gemini-3.8-flash; MODEL_PARAMS copied with
-- per_call_max_tokens = 8192. New key: there is no prior version to
-- deactivate. Re-runnable (NOT EXISTS).
--
-- The same commit adds ('lifecycle.job.system', 1) to the audit agent's
-- q_prompt_drift manifest (both sql.value and sql.query).

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

BEGIN;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'lifecycle.job.system',
    1,
    'gemini-3.8-flash',
    p.TPL,
    OBJECT_INSERT(p.MODEL_PARAMS::OBJECT, 'per_call_max_tokens', 8192, TRUE),
    TRUE,
    MD5(p.TPL),
    'marty',
    'v1 CRMA-1678: one-shot JSON variant of lifecycle.subagent.system v7 for the Cloud Run lifecycle job; tool wording removed, first-RETIRED-proposal note added'
FROM (
    SELECT *, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TEMPLATE,
        'emitting one structured decision via `propose_lifecycle_decision`',
        'returning one structured JSON decision'),
        ' The in-process query tools just slice and filter that prefetched data.', ''),
        '═══ AVAILABLE TOOLS ═══\n\nIn-process query tools (cheap; just slice the prefetched context):\n- `query_trend_neighbors(min_similarity, limit)` — filter the neighbor pool\n- `query_signal_velocity(per_source)` — count linked signals by time window\n- `query_lifecycle_history(limit)` — page through prior decisions for THIS trend\n\nTerminal tool (call exactly once to commit your decision):\n- `propose_lifecycle_decision(...)` — emits the full decision payload\n\n', ''),
        'Output via `propose_lifecycle_decision`:',
        'Output one JSON object:'),
        'Use query tools if you want to slice it differently. ', ''),
        'Then call `propose_lifecycle_decision` exactly once with your final answer.',
        'Then return your final answer as one JSON object.'),
        'Otherwise this is the first proposal and the trend stays DORMANT/DECLINING for now.',
        'Otherwise this is the first proposal. Still return `status: RETIRED`: the commit step records it as the first proposal and keeps the trend DORMANT/DECLINING for now. Returning DORMANT records no proposal.') AS TPL
    FROM DIM_LLM_PROMPT
) p
WHERE p.PROMPT_KEY = 'lifecycle.subagent.system'
  AND p.VERSION = 7
  AND CONTAINS(p.TEMPLATE, 'emitting one structured decision via `propose_lifecycle_decision`')
  AND CONTAINS(p.TEMPLATE, ' The in-process query tools just slice and filter that prefetched data.')
  AND CONTAINS(p.TEMPLATE, '═══ AVAILABLE TOOLS ═══\n\nIn-process query tools (cheap; just slice the prefetched context):\n- `query_trend_neighbors(min_similarity, limit)` — filter the neighbor pool\n- `query_signal_velocity(per_source)` — count linked signals by time window\n- `query_lifecycle_history(limit)` — page through prior decisions for THIS trend\n\nTerminal tool (call exactly once to commit your decision):\n- `propose_lifecycle_decision(...)` — emits the full decision payload\n\n')
  AND CONTAINS(p.TEMPLATE, 'Output via `propose_lifecycle_decision`:')
  AND CONTAINS(p.TEMPLATE, 'Use query tools if you want to slice it differently. ')
  AND CONTAINS(p.TEMPLATE, 'Then call `propose_lifecycle_decision` exactly once with your final answer.')
  AND CONTAINS(p.TEMPLATE, 'Otherwise this is the first proposal and the trend stays DORMANT/DECLINING for now.')
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.job.system' AND VERSION = 1
  );

COMMIT;
