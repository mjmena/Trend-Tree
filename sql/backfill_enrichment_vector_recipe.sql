-- One-time backfill: re-embed the current TREND_VECTOR for every trend onto
-- the shared FN_TREND_EMBED_DOC recipe (arctic-embed-l-v2.0 / 1024-dim).
--
-- Context (issue #26): from the 2026-04-28 ledger refactor until the
-- PROC_ENRICHMENT_APPLY fix, every initial/refinement enrichment row wrote a
-- NULL TREND_VECTOR (the write workflow passes NULL::ARRAY and the agent emits
-- no embedding). The pre-refactor rows + promotion_seed rows that DO have
-- vectors were embedded TREND_TOPIC-only (verified: cosine 1.0 vs re-embedding
-- the topic alone). So the live pool was coherent but topic-only.
--
-- This backfill upgrades the *current* (latest-per-trend) vector to the richer
-- doc — TREND_TOPIC | summary_long | cultural drivers | social narrative —
-- using the exact UDF that PROC_ENRICHMENT_APPLY now calls inline, so the whole
-- DT_TREND_DASHBOARD.RELATED_TRENDS pool shares one recipe.
--
-- Only the latest ledger row per trend is touched (that's what the dashboard
-- reads via latest-non-null). Older rows keep their era's vector / NULL — the
-- ledger is a vector time series, so historical rows stay honest.
--
-- Idempotent: re-running recomputes the same vector from the same payload.

UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER l
SET TREND_VECTOR = SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
        'snowflake-arctic-embed-l-v2.0',
        MCC_RAW.MARKETING_DEV.FN_TREND_EMBED_DOC(t.TREND_TOPIC, l.PAYLOAD)
    )
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t,
     (
        SELECT ENRICHMENT_ID
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
        QUALIFY ROW_NUMBER() OVER (
            PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC, ENRICHMENT_ID DESC
        ) = 1
     ) latest
WHERE l.ENRICHMENT_ID = latest.ENRICHMENT_ID
  AND t.TREND_ID = l.TREND_ID
  -- guard against embedding an empty doc (no topic and no enrichment payload)
  AND LENGTH(MCC_RAW.MARKETING_DEV.FN_TREND_EMBED_DOC(t.TREND_TOPIC, l.PAYLOAD)) > 0;
