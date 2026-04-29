-- update_distillation_lead_v5_clusters.sql
--
-- Bumps distillation.lead.system from v4 (Gemini 3.1 Pro) to v5. Adds a
-- new "CLUSTER HINTS" section to the system prompt explaining the
-- per-signal cluster_id annotation and the cluster summary block now
-- prepended to the user message.
--
-- Template additions only — MODEL and MODEL_PARAMS unchanged from v4.
-- v4 is deactivated atomically once v5 inserts.
--
-- Idempotent: NOT EXISTS guard on (PROMPT_KEY, VERSION=5).

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

INSERT INTO DIM_LLM_PROMPT
    (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'distillation.lead.system',
    5,
    MODEL,
    REPLACE(
      TEMPLATE,
      '═══════════════════════════════════════════════════════════════════════
SPECIFICITY RUBRIC',
      '═══════════════════════════════════════════════════════════════════════
CLUSTER HINTS — pre-fetched signal-similarity groups
═══════════════════════════════════════════════════════════════════════
The user message begins with a "Pre-clustered into N groups" block that
summarizes k-means clusters over the signal embeddings (Snowflake
Cortex arctic-embed-l-v2.0, single SIGNAL_VECTOR over title + body).
Each signal returned by query_signals_window also carries a ``cluster_id``
field.

Treat clusters as a HINT, not a partition:
- Use the summary block to triage which clusters look like coherent
  noun-verb behaviors worth dispatching a subagent on.
- Cross-cluster patterns are STILL valuable — embedding similarity
  doesn''t capture every meaningful semantic connection. Don''t skip
  signals just because they sit in a different cluster.
- You can zoom into one cluster with
  ``query_signals_window(cluster_id=N)`` to see all its members.
- Singleton clusters (size 1) are usually noise but occasionally
  surface a sharp specific behavior — quick scan before discarding.

═══════════════════════════════════════════════════════════════════════
SPECIFICITY RUBRIC'
    )                                AS TEMPLATE,
    MODEL_PARAMS,
    TRUE,
    SHA2(CONCAT_WS(':', 'distillation.lead.system', 'v5'), 256),
    'cluster_hints_migration',
    'v5 — adds CLUSTER HINTS section explaining the new k-means cluster_id annotation + summary block in the user message. Template-only change; MODEL and MODEL_PARAMS unchanged from v4.'
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'distillation.lead.system'
  AND VERSION = 4
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT
     WHERE PROMPT_KEY = 'distillation.lead.system' AND VERSION = 5
  );

-- Deactivate v4 only if v5 landed.
UPDATE DIM_LLM_PROMPT
   SET IS_ACTIVE = FALSE
 WHERE PROMPT_KEY = 'distillation.lead.system'
   AND VERSION = 4
   AND IS_ACTIVE = TRUE
   AND EXISTS (
     SELECT 1 FROM DIM_LLM_PROMPT v5
      WHERE v5.PROMPT_KEY = 'distillation.lead.system' AND v5.VERSION = 5
   );

-- Verification
SELECT PROMPT_KEY, VERSION, MODEL, IS_ACTIVE,
       CONTAINS(TEMPLATE, 'CLUSTER HINTS') AS HAS_CLUSTER_SECTION,
       LENGTH(TEMPLATE) AS TEMPLATE_LEN
  FROM DIM_LLM_PROMPT
 WHERE PROMPT_KEY = 'distillation.lead.system'
 ORDER BY VERSION DESC;
