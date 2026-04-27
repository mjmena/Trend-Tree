-- 2026-04-27 migration cleanup — drop unused procs/tasks
--
-- VIEWS KEPT per user direction (still in use upstream until further notice).
-- Run AFTER end-to-end verification that the new pipeline works.

-- Procs that are functionally retired (split/dedup are now agent-side
-- decisions at proposal time; audit_apply_actions retired with the audit
-- workflow):
DROP PROCEDURE IF EXISTS MCC_RAW.MARKETING_DEV.PROC_SPLIT_TREND(VARCHAR, VARIANT);
DROP PROCEDURE IF EXISTS MCC_RAW.MARKETING_DEV.PROC_DEDUP_TRENDS();
DROP PROCEDURE IF EXISTS MCC_RAW.MARKETING_DEV.PROC_AUDIT_APPLY_ACTIONS(VARIANT);

-- Task that populated STG_ENRICHMENT_QUEUE — queue table was dropped then
-- recreated empty for upstream compat; the task itself is no longer used
-- (already SUSPENDED).
DROP TASK IF EXISTS MCC_RAW.MARKETING_DEV.TASK_QUEUE_ENRICHMENT;
