-- Append-only history of every narrative write to DIM_TREND_ENRICHMENT.
--
-- DIM_TREND_ENRICHMENT itself stays upsert-on-match (one current row per
-- trend, ENRICHMENT_VERSION increments). Without this table the prior
-- narrative is lost on every overwrite. Lifecycle's description_update
-- path appends here BEFORE updating DIM_TREND_ENRICHMENT in place.
--
-- WRITTEN_BY tracks whether the new narrative came from enrichment (full
-- re-enrichment of the trend) or lifecycle (in-place description evolution).
-- NARRATIVE_VERSION is monotonically increasing per trend, independent of
-- DIM_TREND_ENRICHMENT.ENRICHMENT_VERSION (lifecycle can update narrative
-- without bumping the enrichment version).
--
-- Companion to FCT_TREND_ENRICHMENT_HISTORY: that table snapshots metrics +
-- category drift; this one snapshots the narrative copy.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.DIM_TREND_NARRATIVE_HISTORY (
  TREND_ID            VARCHAR  NOT NULL,
  NARRATIVE_VERSION   NUMBER   NOT NULL                COMMENT 'monotonically increasing per TREND_ID; assigned by writer as MAX(version)+1',
  WRITTEN_AT          TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  WRITTEN_BY          VARCHAR(32)                      COMMENT 'enrichment | lifecycle',
  AGENT_SESSION_ID    VARCHAR                          COMMENT 'enr-sess-* or lcy-sess-* depending on writer',

  SUMMARY_SHORT       VARCHAR                          COMMENT 'one-sentence trend summary',
  SUMMARY_LONG        VARCHAR                          COMMENT 'paragraph-length narrative',
  VIBE_SHIFT          VARCHAR                          COMMENT 'cultural angle / mood description',
  SOCIAL_NARRATIVE    VARIANT                          COMMENT 'structured array of narrative beats from enrichment',
  CULTURAL_DRIVERS    VARIANT                          COMMENT 'array of underlying cultural forces',

  CHANGE_REASON       VARCHAR(500)                     COMMENT 'why this narrative was written — e.g., "initial enrichment", "lifecycle: signals shifted to celebrity-driven angle"',

  PRIMARY KEY (TREND_ID, NARRATIVE_VERSION)
);
