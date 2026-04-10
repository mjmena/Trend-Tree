-- Task: Run trend clustering pipeline (Louvain + PageRank)
-- Database: MCC_RAW.MARKETING_DEV
-- Schedule: runs hourly, after TASK_CLASSIFY_GOOGLE_TRENDS
--
-- Calls PROC_CLUSTER_TRENDS which uses Snowpark Python + NetworkX to:
-- 1. Extract cross-source vector similarity edges (>= 0.65 threshold)
-- 2. Louvain community detection (resolution=1.0)
-- 3. PageRank leader selection per community
-- 4. Historical trend matching (>= 0.55 similarity)
-- 5. Upsert signals, metrics, daily snapshots, and velocity/heat scores

CREATE OR REPLACE TASK MCC_RAW.MARKETING_DEV.TASK_CLUSTER_TRENDS
    WAREHOUSE = MARKETING_WH
    SCHEDULE = '60 MINUTE'
AS
    CALL MCC_RAW.MARKETING_DEV.PROC_CLUSTER_TRENDS();

-- After creating, resume the task:
-- ALTER TASK MCC_RAW.MARKETING_DEV.TASK_CLUSTER_TRENDS RESUME;
