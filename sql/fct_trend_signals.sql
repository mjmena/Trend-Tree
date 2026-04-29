-- Table: FCT_TREND_SIGNALS — trend ↔ signal link table
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Append-only link table replacing the (retired 2026-04-28) STG_TREND_SIGNALS.
-- Brought back to keep all trend↔signal queries in MCC_PRESENTATION now
-- that FCT_SIGNALS lives there too. No more cross-DB reaches.
--
-- Two distinct concepts on each link:
--   LINK_KIND  — operational origin: 'supporting' (from
--                STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS at
--                distillation/promotion time) or 'evidence' (from the
--                enrichment agent's PAYLOAD:evidence — populated in a
--                future PR after enrichment writes its citations to STG).
--   LINK_TYPE  — semantic role for the trend, matching the enrichment
--                agent's existing enum at run_enrichment_agent/entry.js:228:
--                'news' | 'social' | 'commerce' | 'reference' |
--                'search_volume' | 'video' | 'other'. NULL allowed
--                where the source doesn't determine a clear type.
--
-- For 'supporting' links the LINK_TYPE is derived deterministically from
-- FCT_SIGNALS.SOURCE_NAME at TASK time. For 'evidence' links (future)
-- the agent's per-trend classification survives end-to-end.
--
-- No FK enforcement to FCT_SIGNALS.SIGNAL_ID — eventual consistency is
-- by design. The 5-minute lag on TASK_PROMOTE_SIGNALS_TO_FCT means a
-- brand-new evidence link can point at a SIGNAL_ID that doesn't yet
-- have an FCT_SIGNALS row. That's fine — link-level use cases (dashboard
-- top_signals, audit, counts) don't need the embedding.

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS (
    TREND_ID   VARCHAR(255) NOT NULL,
    SIGNAL_ID  VARCHAR(255) NOT NULL,
    LINK_KIND  VARCHAR(20)  NOT NULL,            -- 'supporting' | 'evidence'
    LINK_TYPE  VARCHAR(20),                       -- 'news' | 'social' | 'commerce' | 'reference' | 'search_volume' | 'video' | 'other' | NULL
    LINKED_AT  TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (TREND_ID, SIGNAL_ID, LINK_KIND)
);

-- TASK: promote 'supporting' links from STG_TREND_CANDIDATES.
-- Flattens the SUPPORTING_SIGNAL_IDS array off promoted + dedup
-- candidates, joins to FCT_SIGNALS for SOURCE_NAME, derives LINK_TYPE
-- from a deterministic source→type mapping.
--
-- 'evidence' link kind populated in a future PR (depends on enrichment
-- writing its citations to STG with signal_kind='enrichment_citation').
CREATE OR REPLACE TASK MCC_PRESENTATION.TREND_AGENT.TASK_PROMOTE_TREND_SIGNALS
    WAREHOUSE = MARKETING_WH
    SCHEDULE  = '5 MINUTE'
AS
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
    (TREND_ID, SIGNAL_ID, LINK_KIND, LINK_TYPE)
WITH promoted AS (
    SELECT c.PROMOTED_TO       AS TREND_ID, c.SUPPORTING_SIGNAL_IDS
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
    WHERE c.PROMOTED_TO IS NOT NULL
    UNION ALL
    SELECT c.DEDUP_OF_TREND_ID  AS TREND_ID, c.SUPPORTING_SIGNAL_IDS
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
    WHERE c.DEDUP_OF_TREND_ID IS NOT NULL
),
flattened AS (
    SELECT p.TREND_ID, f.value::STRING AS SIGNAL_ID
    FROM promoted p, LATERAL FLATTEN(INPUT => p.SUPPORTING_SIGNAL_IDS) f
    -- Drop overlong array entries (e.g. Gemini grounding-redirect URLs the
    -- agent emitted that can't possibly match a real STG SIGNAL_ID — STG
    -- is VARCHAR(255), so anything wider is by definition unmatched).
    WHERE LENGTH(f.value::STRING) <= 255
)
SELECT
    fl.TREND_ID,
    fl.SIGNAL_ID,
    'supporting' AS LINK_KIND,
    CASE
      WHEN s.SOURCE_NAME IN ('gdelt', 'google_trends_explore', 'google_trends_rss') THEN 'news'
      WHEN s.SOURCE_NAME IN ('bluesky', 'tiktok', 'reddit')                          THEN 'social'
      WHEN s.SOURCE_NAME IN ('amazon_trends', 'amazon_movers')                       THEN 'commerce'
      WHEN s.SOURCE_NAME LIKE 'agent_%_discovery'                                    THEN 'other'
      WHEN s.SOURCE_NAME = 'grok_live'                                               THEN 'other'
      ELSE 'other'
    END AS LINK_TYPE
FROM flattened fl
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s
       ON s.SIGNAL_ID = fl.SIGNAL_ID
WHERE NOT EXISTS (
    SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS x
    WHERE x.TREND_ID  = fl.TREND_ID
      AND x.SIGNAL_ID = fl.SIGNAL_ID
      AND x.LINK_KIND = 'supporting'
)
QUALIFY ROW_NUMBER() OVER (PARTITION BY fl.TREND_ID, fl.SIGNAL_ID ORDER BY fl.SIGNAL_ID) = 1;

ALTER TASK MCC_PRESENTATION.TREND_AGENT.TASK_PROMOTE_TREND_SIGNALS RESUME;
