-- migrate_drop_dt_external_trend_embeddings.sql
--
-- Drops the legacy embeddings dynamic table now that FCT_SIGNALS in
-- MCC_PRESENTATION.TREND_AGENT is the canonical embedded signal surface.
--
-- Sequence:
--   1. PROC_CLUSTER_SIGNAL_SUBSET already repointed to FCT_SIGNALS
--      (sql/proc_cluster_signal_subset.sql, applied separately).
--   2. PROC_CLUSTER_TRENDS — DROPPED. The Louvain pipeline has been
--      suspended (TASK_CLUSTER_TRENDS) and kept as "on-demand tool"
--      per memory `[Louvain kept as on-demand tool]`. Repointing 668
--      lines of Snowpark code (with weighted-TITLE+DESCRIPTION math
--      that doesn't cleanly collapse) for a quarantined artifact has
--      no live consumer. Git history preserves it for revival.
--   3. DROP TASK_CLUSTER_TRENDS — same rationale as the proc.
--   4. DROP DT_EXTERNAL_TREND_EMBEDDINGS — schema-as-code DDL also
--      deleted from sql/ in this commit.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

DROP TASK IF EXISTS MCC_RAW.MARKETING_DEV.TASK_CLUSTER_TRENDS;
DROP PROCEDURE IF EXISTS MCC_RAW.MARKETING_DEV.PROC_CLUSTER_TRENDS();

DROP DYNAMIC TABLE IF EXISTS MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS;

-- Verification
SELECT 'DT dropped' AS step,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = 'MARKETING_DEV'
           AND TABLE_NAME = 'DT_EXTERNAL_TREND_EMBEDDINGS') AS still_present;
