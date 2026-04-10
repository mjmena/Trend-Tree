-- Reset 11 trends enriched 2026-03-30 with zero source coverage
-- (pipeline ran before Claude hashtag generator + n-gram fallback were deployed).
-- Run AFTER deploying the updated Pipedream steps, then manually trigger
-- the enrichment workflow to re-process these trends.
--
-- What this does:
-- 1. Resets queue STATUS to PENDING with fresh QUEUED_AT (defeats dedup cache)
-- 2. Clears BAD DIM entries so LLMs will re-assess with real source evidence
-- 3. Purges zero/null headline metric FCT rows for these trends (enrich_trend.mjs
--    will re-run from scratch with correct source data)

BEGIN;

-- Reset queue to PENDING with new QUEUED_AT (ensures dedup key changes)
UPDATE MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE
SET
    STATUS         = 'PENDING',
    QUEUED_AT      = CURRENT_TIMESTAMP(),
    STARTED_AT     = NULL,
    COMPLETED_AT   = NULL,
    ERROR_MESSAGE  = NULL,
    ENRICHMENT_TYPE = 'FULL',
    ENRICHMENT_TIER = NULL
WHERE TREND_ID IN (
    '8e897ef5-b68d-4771-8a10-f944b4500b46',
    'effb2e21-e2ee-4114-bada-bc4da2550a34',
    'adfcaf05-1050-44f8-a8f5-689b314a63d6',
    'b7ce48c6-1afd-49ff-9d70-3f71752b78bb',
    '2ac70946-08b0-4799-97ea-43c60fd097a3',
    '1521b528-5ec1-4699-8c5e-9fd47ab719db',
    '6b3a1eba-b22e-40b3-bc1c-def6895c646d',
    '8f8bab62-4303-4a4b-93fe-7b99006f94dc',
    '0b54d60d-818a-4e89-8eba-91337f02b487',
    '741b9cd8-6c3a-4c87-b895-b131bea498eb',
    '0e27343e-a113-4b7e-9668-8e98b43fdf38'
);

-- Remove bad DIM records so Claude synthesizer re-assesses with source evidence
DELETE FROM MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
WHERE TREND_ID IN (
    '8e897ef5-b68d-4771-8a10-f944b4500b46',
    'effb2e21-e2ee-4114-bada-bc4da2550a34',
    'adfcaf05-1050-44f8-a8f5-689b314a63d6',
    'b7ce48c6-1afd-49ff-9d70-3f71752b78bb',
    '2ac70946-08b0-4799-97ea-43c60fd097a3',
    '1521b528-5ec1-4699-8c5e-9fd47ab719db',
    '6b3a1eba-b22e-40b3-bc1c-def6895c646d',
    '8f8bab62-4303-4a4b-93fe-7b99006f94dc',
    '0b54d60d-818a-4e89-8eba-91337f02b487',
    '741b9cd8-6c3a-4c87-b895-b131bea498eb',
    '0e27343e-a113-4b7e-9668-8e98b43fdf38'
)
AND ENRICHED_AT > '2026-03-30 20:00:00';

-- Purge zero/null headline metric FCT rows for these trends
-- enrich_trend.mjs will re-populate from scratch with correct source data
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
WHERE TREND_ID IN (
    '8e897ef5-b68d-4771-8a10-f944b4500b46',
    'effb2e21-e2ee-4114-bada-bc4da2550a34',
    'adfcaf05-1050-44f8-a8f5-689b314a63d6',
    'b7ce48c6-1afd-49ff-9d70-3f71752b78bb',
    '2ac70946-08b0-4799-97ea-43c60fd097a3',
    '1521b528-5ec1-4699-8c5e-9fd47ab719db',
    '6b3a1eba-b22e-40b3-bc1c-def6895c646d',
    '8f8bab62-4303-4a4b-93fe-7b99006f94dc',
    '0b54d60d-818a-4e89-8eba-91337f02b487',
    '741b9cd8-6c3a-4c87-b895-b131bea498eb',
    '0e27343e-a113-4b7e-9668-8e98b43fdf38'
)
AND (HEADLINE_METRIC IS NULL OR HEADLINE_METRIC = 0);

COMMIT;

-- Verify:
SELECT STATUS, COUNT(*) FROM MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE
WHERE TREND_ID IN (
    '8e897ef5-b68d-4771-8a10-f944b4500b46',
    'effb2e21-e2ee-4114-bada-bc4da2550a34',
    'adfcaf05-1050-44f8-a8f5-689b314a63d6',
    'b7ce48c6-1afd-49ff-9d70-3f71752b78bb',
    '2ac70946-08b0-4799-97ea-43c60fd097a3',
    '1521b528-5ec1-4699-8c5e-9fd47ab719db',
    '6b3a1eba-b22e-40b3-bc1c-def6895c646d',
    '8f8bab62-4303-4a4b-93fe-7b99006f94dc',
    '0b54d60d-818a-4e89-8eba-91337f02b487',
    '741b9cd8-6c3a-4c87-b895-b131bea498eb',
    '0e27343e-a113-4b7e-9668-8e98b43fdf38'
)
GROUP BY 1;
