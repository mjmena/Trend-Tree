-- Staging: Google Trend relevance classification
-- Database: MCC_RAW.MARKETING_DEV
-- Populated by TASK_CLASSIFY_GOOGLE_TRENDS (incremental, Cortex LLM)

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_GOOGLE_TREND_RELEVANCE (
    TREND_ID NUMBER PRIMARY KEY,
    TREND_TITLE VARCHAR,
    IS_RELEVANT BOOLEAN,
    LLM_RESPONSE VARCHAR,
    CLASSIFIED_AT TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP()
) COMMENT = 'LLM classification of Google Trend titles for relevance to niche, monetizable consumer trends. Each TREND_ID is classified exactly once.';
