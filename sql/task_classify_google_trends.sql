-- Task: Classify new Google Trends for relevance
-- Runs hourly, only processes TREND_IDs not yet in STG_GOOGLE_TREND_RELEVANCE
-- Database: MCC_RAW.MARKETING_DEV

CREATE OR REPLACE TASK MCC_RAW.MARKETING_DEV.TASK_CLASSIFY_GOOGLE_TRENDS
    WAREHOUSE = MARKETING_WH
    SCHEDULE = '60 MINUTE'
AS
INSERT INTO MCC_RAW.MARKETING_DEV.STG_GOOGLE_TREND_RELEVANCE (TREND_ID, TREND_TITLE, IS_RELEVANT, LLM_RESPONSE)
SELECT
    t.TREND_ID,
    t.TREND_TITLE,
    TRIM(response) ILIKE '%YES%' AS IS_RELEVANT,
    TRIM(response) AS LLM_RESPONSE
FROM (
    SELECT
        TREND_ID,
        TREND_TITLE,
        SNOWFLAKE.CORTEX.COMPLETE('mistral-7b',
            'Classify this Google Trend title. Is it a niche consumer lifestyle trend (wellness, food/diet, beauty, home, fitness, cultural shift, personal care) that a brand could create sponsored content around? Not relevant: sports scores/players, weather, celebrities/entertainment, politics, crime, legal ads, daily puzzles, breaking news events. Answer only YES or NO.\n\nTrend: ' || TREND_TITLE
        ) AS response
    FROM MCC_RAW.MARKETING_DEV.STG_GOOGLE_TRENDS t
    WHERE t.TREND_ID NOT IN (
        SELECT TREND_ID FROM MCC_RAW.MARKETING_DEV.STG_GOOGLE_TREND_RELEVANCE
    )
) t;

-- After creating, resume the task:
-- ALTER TASK MCC_RAW.MARKETING_DEV.TASK_CLASSIFY_GOOGLE_TRENDS RESUME;
