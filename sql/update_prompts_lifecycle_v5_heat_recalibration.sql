-- update_prompts_lifecycle_v5_heat_recalibration.sql
--
-- Phase: heat recalibration (2026-05-26).
--
-- Heat was over-inflated under v4 — 28 trends sitting at 80-89 with
-- avg 3.5 publishers, 0 trends in prediction's High Potential or
-- Watchlist tiers. Root cause: structural floors in the heat_base
-- formula (Shannon breadth ceilinged at 2 publishers, gtrends default
-- of 0.65 gave free 13 pts, EWMA α=0.3 made high seeds sticky).
--
-- v5 changes the heat formula description block in both the system
-- prompt and decision rubric to match the recalibrated code:
--   - Heat semantic = validation strength (broadly-evidenced)
--   - Breadth = log_publishers × shannon, anchored at 10 pubs
--   - Gtrends defaults to 0 when no poller row
--   - EWMA α=0.5 (faster convergence)
--
-- The code changes live alongside (lifecycle-subagent computeHeatBase,
-- PROC_LIFECYCLE_APPLY smoothing, PROC_PROMOTION_APPLY seed). This
-- file just keeps the agent's prompt synchronized with the formula it
-- now sees in heat_base inputs.
--
-- Atomic per key. Re-runnable: WHERE NOT EXISTS guard on v5.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

-- ════════════════════════════════════════════════════════════════════════
-- lifecycle.subagent.system v5
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'lifecycle.subagent.system' AND IS_ACTIVE = TRUE;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'lifecycle.subagent.system',
    5,
    MODEL,
    REPLACE(
        TEMPLATE,
        $$The pre-fetched `heat_base` is the deterministic baseline:
  heat_base = 20*recency + 25*velocity + 25*breadth(shannon) + 20*gtrends + 10*confidence

Your `heat_modifier_pct` ∈ [-20, 20] adjusts it:
  TREND_HEAT_INDEX = clamp(heat_base * (1 + heat_modifier_pct/100), 0, 100)$$,
        $$The pre-fetched `heat_base` is the deterministic baseline (validation strength):
  heat_base = 20*recency + 25*velocity + 25*breadth(log_pubs × shannon) + 20*gtrends + 10*confidence

Breadth is anchored so 10+ publishers (even distribution) = full 25 pts:
  1 pub → 0 | 2 → 4 | 3 → 9 | 5 → 15 | 8 → 21 | 10+ → 25
Gtrends defaults to 0 (not 0.65) when no poller row exists — earn evidence, don't assume it.

Your `heat_modifier_pct` ∈ [-20, 20] adjusts it:
  new_heat = clamp(heat_base * (1 + heat_modifier_pct/100), 0, 100)
  TREND_HEAT_INDEX = round(0.5 * prior_smoothed + 0.5 * new_heat, 1)  (EWMA α=0.5)$$
    ),
    MODEL_PARAMS,
    TRUE,
    MD5(REPLACE(
        TEMPLATE,
        $$The pre-fetched `heat_base` is the deterministic baseline:
  heat_base = 20*recency + 25*velocity + 25*breadth(shannon) + 20*gtrends + 10*confidence

Your `heat_modifier_pct` ∈ [-20, 20] adjusts it:
  TREND_HEAT_INDEX = clamp(heat_base * (1 + heat_modifier_pct/100), 0, 100)$$,
        $$The pre-fetched `heat_base` is the deterministic baseline (validation strength):
  heat_base = 20*recency + 25*velocity + 25*breadth(log_pubs × shannon) + 20*gtrends + 10*confidence

Breadth is anchored so 10+ publishers (even distribution) = full 25 pts:
  1 pub → 0 | 2 → 4 | 3 → 9 | 5 → 15 | 8 → 21 | 10+ → 25
Gtrends defaults to 0 (not 0.65) when no poller row exists — earn evidence, don't assume it.

Your `heat_modifier_pct` ∈ [-20, 20] adjusts it:
  new_heat = clamp(heat_base * (1 + heat_modifier_pct/100), 0, 100)
  TREND_HEAT_INDEX = round(0.5 * prior_smoothed + 0.5 * new_heat, 1)  (EWMA α=0.5)$$
    )),
    'marty',
    'v5 heat recalibration: validation strength semantic; log_pubs × shannon breadth anchored at 10 pubs; gtrends default 0; EWMA α=0.5'
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'lifecycle.subagent.system'
  AND VERSION = 4
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.subagent.system' AND VERSION = 5
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- lifecycle.subagent.decision_rubric v5
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'lifecycle.subagent.decision_rubric' AND IS_ACTIVE = TRUE;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'lifecycle.subagent.decision_rubric',
    5,
    MODEL,
    REPLACE(
        TEMPLATE,
        $$The pre-fetched `heat_base` is the deterministic baseline:
  heat_base = 20*recency + 25*velocity + 25*breadth(shannon) + 20*gtrends + 10*confidence

Your `heat_modifier_pct` ∈ [-20, 20] adjusts it:
  TREND_HEAT_INDEX = clamp(heat_base * (1 + heat_modifier_pct/100), 0, 100)$$,
        $$The pre-fetched `heat_base` is the deterministic baseline (validation strength):
  heat_base = 20*recency + 25*velocity + 25*breadth(log_pubs × shannon) + 20*gtrends + 10*confidence

Breadth is anchored so 10+ publishers (even distribution) = full 25 pts:
  1 pub → 0 | 2 → 4 | 3 → 9 | 5 → 15 | 8 → 21 | 10+ → 25
Gtrends defaults to 0 (not 0.65) when no poller row exists — earn evidence, don't assume it.

Your `heat_modifier_pct` ∈ [-20, 20] adjusts it:
  new_heat = clamp(heat_base * (1 + heat_modifier_pct/100), 0, 100)
  TREND_HEAT_INDEX = round(0.5 * prior_smoothed + 0.5 * new_heat, 1)  (EWMA α=0.5)$$
    ),
    MODEL_PARAMS,
    TRUE,
    MD5(REPLACE(
        TEMPLATE,
        $$The pre-fetched `heat_base` is the deterministic baseline:
  heat_base = 20*recency + 25*velocity + 25*breadth(shannon) + 20*gtrends + 10*confidence

Your `heat_modifier_pct` ∈ [-20, 20] adjusts it:
  TREND_HEAT_INDEX = clamp(heat_base * (1 + heat_modifier_pct/100), 0, 100)$$,
        $$The pre-fetched `heat_base` is the deterministic baseline (validation strength):
  heat_base = 20*recency + 25*velocity + 25*breadth(log_pubs × shannon) + 20*gtrends + 10*confidence

Breadth is anchored so 10+ publishers (even distribution) = full 25 pts:
  1 pub → 0 | 2 → 4 | 3 → 9 | 5 → 15 | 8 → 21 | 10+ → 25
Gtrends defaults to 0 (not 0.65) when no poller row exists — earn evidence, don't assume it.

Your `heat_modifier_pct` ∈ [-20, 20] adjusts it:
  new_heat = clamp(heat_base * (1 + heat_modifier_pct/100), 0, 100)
  TREND_HEAT_INDEX = round(0.5 * prior_smoothed + 0.5 * new_heat, 1)  (EWMA α=0.5)$$
    )),
    'marty',
    'v5 heat recalibration: validation strength semantic; log_pubs × shannon breadth anchored at 10 pubs; gtrends default 0; EWMA α=0.5'
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'lifecycle.subagent.decision_rubric'
  AND VERSION = 4
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'lifecycle.subagent.decision_rubric' AND VERSION = 5
  );

COMMIT;
