-- Task: Aggregate Amazon products into category-level trend signals
-- Runs every 6 hours (aligned with Amazon ingest schedule), before clustering.
-- Database: MCC_RAW.MARKETING_DEV

CREATE OR REPLACE TASK MCC_RAW.MARKETING_DEV.MARKETING_TASK_AGGREGATE_AMAZON
    WAREHOUSE = MARKETING_WH
    SCHEDULE = '360 MINUTE'
AS
    CALL MCC_RAW.MARKETING_DEV.PROC_AGGREGATE_AMAZON();

-- Replacement can lose the owner with warehouse USAGE; keep the task suspended.
GRANT OWNERSHIP ON TASK MCC_RAW.MARKETING_DEV.MARKETING_TASK_AGGREGATE_AMAZON
    TO ROLE MARKETING_ENGINEER COPY CURRENT GRANTS;
