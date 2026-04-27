-- One-off dedup backfill, 2026-04-27.
-- Cleans up the 5 duplicate trends that were promoted in the 13:30 EDT batch
-- before intra-batch dedup was wired into the promotion workflow.
--
-- Three clusters identified at >=0.70 cosine similarity between TREND_VECTOR.
-- Leaders picked using the same rule the runtime now uses:
--   max TOTAL_CLUSTER_SIZE → max CONFIDENCE → earliest PROMOTED_AT.
--
-- Cluster 1 — Mineral SPF (sims 0.74–0.97):
--   leader   7843fe43-cb26-4edc-9119-fb5858ddefe5  "Invisible tinted mineral sunscreen…" (cluster=11, conf=0.86)
--   follower 29f8795a-4fb0-4ea1-be4e-fa820063c5f4  "Tinted and invisible mineral sunscreen…" (cluster=6, conf=0.80)
--   follower 4e0865c6-47f7-4bfe-ae10-7cf4a5b5b989  "Mineral sunscreen daily face adoption — zinc oxide SPF…" (cluster=4, conf=0.75)
--
-- Cluster 2 — Mushroom format shift (sims 0.82–0.87):
--   leader   b752390b-7d56-4e21-b5b3-d6da87ac606f  "Functional mushroom gummies & buccal pouches replacing daily powder supplements" (cluster=3, conf=0.74)
--   follower 1b8e3338-d649-4dda-bf4d-a36d7137d513  "Mushroom supplement format shift — powders swapped…" (cluster=3, conf=0.74)
--   follower 2c57b2c2-d168-45da-9155-f55c317735d8  "Functional mushroom format shift — gummies & buccal pouches…" (cluster=3, conf=0.72)
--
-- Cluster 3 — At-home microneedling (sim 0.71):
--   leader   6399816e-b98d-4334-857f-54d1084f6963  "At-home microneedling dissolving patches…" (cluster=4, conf=0.76)
--   follower b6f709de-0913-496c-8321-6c2fd87d5694  "At-home microneedling and hydrocolloid patches…" (cluster=3, conf=0.65)

BEGIN;

-- Step 1: repoint follower candidates' PROMOTED_TO + DEDUP_OF_TREND_ID to the leader.
-- This must happen BEFORE the leader recompute so the cluster aggregate sees them.
UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
SET PROMOTED_TO       = '7843fe43-cb26-4edc-9119-fb5858ddefe5',
    DEDUP_OF_TREND_ID = '7843fe43-cb26-4edc-9119-fb5858ddefe5'
WHERE PROMOTED_TO IN ('29f8795a-4fb0-4ea1-be4e-fa820063c5f4','4e0865c6-47f7-4bfe-ae10-7cf4a5b5b989')
   OR DEDUP_OF_TREND_ID IN ('29f8795a-4fb0-4ea1-be4e-fa820063c5f4','4e0865c6-47f7-4bfe-ae10-7cf4a5b5b989');

UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
SET PROMOTED_TO       = 'b752390b-7d56-4e21-b5b3-d6da87ac606f',
    DEDUP_OF_TREND_ID = 'b752390b-7d56-4e21-b5b3-d6da87ac606f'
WHERE PROMOTED_TO IN ('1b8e3338-d649-4dda-bf4d-a36d7137d513','2c57b2c2-d168-45da-9155-f55c317735d8')
   OR DEDUP_OF_TREND_ID IN ('1b8e3338-d649-4dda-bf4d-a36d7137d513','2c57b2c2-d168-45da-9155-f55c317735d8');

UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
SET PROMOTED_TO       = '6399816e-b98d-4334-857f-54d1084f6963',
    DEDUP_OF_TREND_ID = '6399816e-b98d-4334-857f-54d1084f6963'
WHERE PROMOTED_TO = 'b6f709de-0913-496c-8321-6c2fd87d5694'
   OR DEDUP_OF_TREND_ID = 'b6f709de-0913-496c-8321-6c2fd87d5694';

-- Step 2: delete dependent rows for the 5 followers.
-- Order: enrichment-history → enrichment → source-metrics → trend.
-- Daily snapshots and macrotrend map are empty for these (verified pre-flight).
DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_HISTORY
WHERE TREND_ID IN (
    '29f8795a-4fb0-4ea1-be4e-fa820063c5f4',
    '4e0865c6-47f7-4bfe-ae10-7cf4a5b5b989',
    '1b8e3338-d649-4dda-bf4d-a36d7137d513',
    '2c57b2c2-d168-45da-9155-f55c317735d8',
    'b6f709de-0913-496c-8321-6c2fd87d5694'
);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
WHERE TREND_ID IN (
    '29f8795a-4fb0-4ea1-be4e-fa820063c5f4',
    '4e0865c6-47f7-4bfe-ae10-7cf4a5b5b989',
    '1b8e3338-d649-4dda-bf4d-a36d7137d513',
    '2c57b2c2-d168-45da-9155-f55c317735d8',
    'b6f709de-0913-496c-8321-6c2fd87d5694'
);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
WHERE TREND_ID IN (
    '29f8795a-4fb0-4ea1-be4e-fa820063c5f4',
    '4e0865c6-47f7-4bfe-ae10-7cf4a5b5b989',
    '1b8e3338-d649-4dda-bf4d-a36d7137d513',
    '2c57b2c2-d168-45da-9155-f55c317735d8',
    'b6f709de-0913-496c-8321-6c2fd87d5694'
);

DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE TREND_ID IN (
    '29f8795a-4fb0-4ea1-be4e-fa820063c5f4',
    '4e0865c6-47f7-4bfe-ae10-7cf4a5b5b989',
    '1b8e3338-d649-4dda-bf4d-a36d7137d513',
    '2c57b2c2-d168-45da-9155-f55c317735d8',
    'b6f709de-0913-496c-8321-6c2fd87d5694'
);

-- Step 3: recompute each leader's cluster aggregates.
-- TREND_VECTOR intentionally NOT recomputed here — the original PROMOTE_NEW
-- embedding already represents the leader well enough, and an in-UPDATE
-- Cortex EMBED hangs at warehouse-scale on multi-row LATERAL FLATTEN
-- subqueries (observed >15 min on 3 rows during the 2026-04-27 backfill).
-- The vector will refresh naturally next time MERGE_INTO_EXISTING fires
-- on these trends. TREND_HEAT_INDEX also left alone (lifecycle agent owns it).
UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
SET
    TOTAL_CLUSTER_SIZE = (
        SELECT COUNT(DISTINCT f.value::STRING)
        FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
             LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
        WHERE c.CANDIDATE_ID = t.CANDIDATE_ID
           OR c.DEDUP_OF_TREND_ID = t.TREND_ID
    ),
    DISTINCT_SOURCE_COUNT = (
        SELECT COUNT(DISTINCT f.value::STRING)
        FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
             LATERAL FLATTEN(INPUT => OBJECT_KEYS(c.SOURCE_BREAKDOWN)) f
        WHERE c.CANDIDATE_ID = t.CANDIDATE_ID
           OR c.DEDUP_OF_TREND_ID = t.TREND_ID
    ),
    LAST_UPDATE_AT = CURRENT_TIMESTAMP()
WHERE t.TREND_ID IN (
    '7843fe43-cb26-4edc-9119-fb5858ddefe5',
    'b752390b-7d56-4e21-b5b3-d6da87ac606f',
    '6399816e-b98d-4334-857f-54d1084f6963'
);

COMMIT;

-- Sanity check: verify the leaders' cluster fields grew.
SELECT TREND_ID, LEFT(TREND_TOPIC, 60) AS TOPIC,
       TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT, LAST_UPDATE_AT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
WHERE TREND_ID IN (
    '7843fe43-cb26-4edc-9119-fb5858ddefe5',
    'b752390b-7d56-4e21-b5b3-d6da87ac606f',
    '6399816e-b98d-4334-857f-54d1084f6963'
);

SELECT COUNT(*) AS REMAINING_FCT_TRENDS FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS;
