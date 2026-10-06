-- audit.report_rubric v3 — error-rate rule for the fan-out subagents (CRMA-1031)
--
-- The WORKFLOW HEALTH rules live in audit.report_rubric, which audit.system
-- takes in as {{report_rubric}}. v2 graded a workflow RED at ">= 10 errors in
-- 24h" while fetch_pipedream_errors asked for 10 errors at most, so RED meant
-- "the first page is full". It also ignored run volume: 10 errors is 1.7% of
-- lifecycle-subagent's ~588 daily runs, and a total outage for a workflow
-- that runs 4 times a day.
--
-- v3 keeps the count rule for every workflow except lifecycle-subagent and
-- lifecycle-attribution-subagent, which grade on the error rate (RED at 5% of
-- the day's runs). The severity is now computed in
-- audit-agent-p_xMC9nm3/run_audit_agent/workflow_health.mjs and shown per
-- workflow in the PIPEDREAM WORKFLOW HEALTH block; v3 tells the agent to use
-- it as given. The thresholds below must stay equal to that file's constants.
--
-- Order: apply this AFTER the commit that carries it is live on `production`.
-- That commit bumps audit.report_rubric to 3 in q_prompt_drift's manifest.
-- Applied first, the next audit reads LIVE_AHEAD_OF_REPO and grades
-- governance RED. Run with `snow sql --enable-templating NONE`.
--
-- Rollback: SET IS_ACTIVE = (VERSION = 2) for this key's versions 2 and 3.
--
-- Derives v3 from v2, deactivates v2. Both statements are guarded: if the v2
-- rules text is not found, nothing is inserted and v2 stays active.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
WITH edit AS (
  SELECT
$$For each workflow with errors in the last 24h:
- INFO  : 1–2 errors (likely transient)
- WARN  : 3–9 errors, OR errors concentrated in last hour (≥ 2 in last hour)
- RED   : ≥ 10 errors in 24h, OR a workflow that's expected to fire by cron has 0 emits AND ≥ 1 error
- Workflow `active=false` for an expected-active workflow → RED.$$ AS OLD_RULES,
$$Each workflow with errors in the last 24h carries a precomputed `severity` in the PIPEDREAM WORKFLOW HEALTH block. Deterministic code derives it from the two rules below. Use it as given. Do not re-derive it from the count.

Count rule — every workflow except the two fan-out subagents:
- INFO  : 1–2 errors (likely transient)
- WARN  : 3–9 errors
- RED   : ≥ 10 errors in 24h

Error-rate rule — `lifecycle-subagent` and `lifecycle-attribution-subagent` only. These run hundreds of times a day, so a count alone says little:
- WARN  : errors exist, below 5% of the workflow's runs in the same 24h
- RED   : errors ≥ 5% of the workflow's runs in the same 24h
- If the run volume is unavailable, the count rule applies. `severity_note` says so, and the alert evidence must say so too.

`errors_24h_count` is the true 24h count, up to 100. `errors_24h_truncated: true` means the true count is at least that number — write it as "≥ N".

If a block entry has errors but no `severity` field, apply the two rules above yourself.

You may raise a workflow above its precomputed severity, never lower it, in these cases:
- WARN  : errors concentrated in last hour (≥ 2 in last hour)
- RED   : a workflow that's expected to fire by cron has 0 emits AND ≥ 1 error
- Workflow `active=false` for an expected-active workflow → RED.$$ AS NEW_RULES
)
SELECT
  p.PROMPT_KEY, 3 AS VERSION, p.MODEL,
  REPLACE(p.TEMPLATE, e.OLD_RULES, e.NEW_RULES) AS TEMPLATE,
  p.MODEL_PARAMS, TRUE AS IS_ACTIVE,
  SHA2(CONCAT('audit.report_rubric.v3', CURRENT_TIMESTAMP()::STRING)) AS CONTENT_HASH,
  'crma1031_fan_out_error_rate' AS CREATED_BY,
  'v3: WORKFLOW HEALTH uses the precomputed per-workflow severity. Adds the error-rate rule (RED at 5% of runs) for lifecycle-subagent and lifecycle-attribution-subagent (CRMA-1031).' AS NOTES
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT p
CROSS JOIN edit e
WHERE p.PROMPT_KEY = 'audit.report_rubric' AND p.VERSION = 2 AND p.IS_ACTIVE = TRUE
  AND CONTAINS(p.TEMPLATE, e.OLD_RULES)
  AND NOT EXISTS (
    SELECT 1 FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT x
    WHERE x.PROMPT_KEY = 'audit.report_rubric' AND x.VERSION = 3
  );

UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'audit.report_rubric' AND VERSION = 2
  AND EXISTS (
    SELECT 1 FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT x
    WHERE x.PROMPT_KEY = 'audit.report_rubric' AND x.VERSION = 3 AND x.IS_ACTIVE = TRUE
  );

-- Verify: only v3 active; the new rules landed and the old RED line is gone.
SELECT VERSION, IS_ACTIVE,
  CASE WHEN TEMPLATE ILIKE '%Error-rate rule%lifecycle-subagent%' THEN 'ok' ELSE 'MISSING' END AS RATE_RULE,
  CASE WHEN TEMPLATE ILIKE '%10 errors in 24h, OR a workflow%' THEN 'STILL PRESENT' ELSE 'gone' END AS OLD_RED_LINE
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'audit.report_rubric' ORDER BY VERSION;
