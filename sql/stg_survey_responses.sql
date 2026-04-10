-- Staging: Survey response data
-- Database: MCC_RAW.MARKETING_DEV

create or replace table MCC_RAW.MARKETING_DEV.STG_SURVEY_RESPONSES (
    INGESTION_ID NUMBER(38,0) autoincrement start 1 increment 1 noorder,
    RAW_DATA VARIANT,
    POLL_ID VARCHAR(16777216) AS (CAST(GET_PATH(STG_SURVEY_RESPONSES.RAW_DATA, 'poll_id') AS VARCHAR)),
    SUBMITTED_AT TIMESTAMP_NTZ(9) AS (CAST(GET_PATH(STG_SURVEY_RESPONSES.RAW_DATA, 'submitted_at') AS TIMESTAMP_NTZ(9))),
    INSERTED_AT TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP()
) COMMENT = 'The table contains records of survey responses. Each record represents a single response and includes details about the submission time and associated poll.';
