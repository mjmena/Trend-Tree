-- Table: FCT_SIGNALS — canonical signal record with embedding
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Append-only fact table promoted from STG_EXTERNAL_SIGNALS by
-- TASK_PROMOTE_SIGNALS_TO_FCT (5-min cadence). Single SIGNAL_VECTOR
-- column over (SIGNAL_TITLE + first 512 chars of SIGNAL_TEXT) via
-- Cortex EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', ...).
--
-- STG_EXTERNAL_SIGNALS remains the mutable working space (claim state
-- via AGENT_SESSION_ID); FCT_SIGNALS is the immutable, embedded,
-- presentation-tier reference. SIGNAL_ID is the universal key — same
-- string in STG, FCT, and FCT_TREND_SIGNALS, no aliases.
--
-- amazon_movers excluded by design (too granular — individual SKUs;
-- the aggregated amazon_trends rows are the useful unit).

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS (
    SIGNAL_ID         VARCHAR(255)  NOT NULL PRIMARY KEY,
    SOURCE_NAME       VARCHAR(50)   NOT NULL,
    SIGNAL_TIMESTAMP  TIMESTAMP_NTZ,
    SIGNAL_TITLE      VARCHAR,
    SIGNAL_TEXT       VARCHAR,
    METADATA          VARIANT,
    SIGNAL_VECTOR     VECTOR(FLOAT, 1024),
    EMBEDDED_AT       TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- The QUALIFY ROW_NUMBER picks one row per SIGNAL_ID inside the source
-- (earliest INGESTED_AT wins) — Snowflake's PRIMARY KEY is informational,
-- not enforced, so without this an INSERT statement would re-introduce
-- the ~9% intra-STG SIGNAL_ID dupes. NOT EXISTS handles cross-run dedup.
CREATE OR REPLACE TASK MCC_PRESENTATION.TREND_AGENT.TASK_PROMOTE_SIGNALS_TO_FCT
    WAREHOUSE = MARKETING_WH
    SCHEDULE  = '5 MINUTE'
AS
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS
    (SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP, SIGNAL_TITLE, SIGNAL_TEXT,
     METADATA, SIGNAL_VECTOR)
SELECT
    s.SIGNAL_ID, s.SOURCE_NAME, s.SIGNAL_TIMESTAMP,
    s.SIGNAL_TITLE, s.SIGNAL_TEXT, s.METADATA,
    SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
        'snowflake-arctic-embed-l-v2.0',
        s.SIGNAL_TITLE || ' ' || LEFT(COALESCE(s.SIGNAL_TEXT, ''), 512)
    )
FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
WHERE s.SIGNAL_TITLE IS NOT NULL
  AND s.SOURCE_NAME != 'amazon_movers'
  AND NOT EXISTS (
      SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f
      WHERE f.SIGNAL_ID = s.SIGNAL_ID
  )
QUALIFY ROW_NUMBER() OVER (PARTITION BY s.SIGNAL_ID ORDER BY s.INGESTED_AT ASC) = 1;

ALTER TASK MCC_PRESENTATION.TREND_AGENT.TASK_PROMOTE_SIGNALS_TO_FCT RESUME;
