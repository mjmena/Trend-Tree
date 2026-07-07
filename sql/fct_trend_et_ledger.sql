-- Append-only ledger for a trend's Exploding Topics intelligence (ADR-0004,
-- issue #61). One row per ET observation for a trend. Seeded at promotion from
-- an ET-rescued candidate's ET_CORROBORATION snapshot; a future refresher can
-- append newer observations (the volume/growth/classifications are refreshable
-- external-demand data). The latest row per TREND_ID is the current ET view a
-- later DT_TREND_DASHBOARD slice will surface.
--
-- ET-specific by decision (ADR-0004): a sibling ledger if a second external
-- oracle ever arrives (rejected the provider-neutral EXTERNAL_DEMAND ledger as
-- YAGNI). Mirrors the agent-owned-ledger pattern of FCT_TREND_ENRICHMENT_LEDGER
-- / FCT_TREND_PREDICTION_LEDGER — each agent/source owns one ledger.
--
-- Isolation: NEVER read by HEAT_INDEX / LIFECYCLE_STATUS / SOURCE_BREAKDOWN. ET
-- is not a [Source]. Frontend surfacing is a deferred later slice; this ledger
-- only accrues history from day one.

CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ET_LEDGER (
  ET_OBS_ID          VARCHAR       DEFAULT UUID_STRING() PRIMARY KEY,
  TREND_ID           VARCHAR       NOT NULL,
  OBSERVED_AT        TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  WRITTEN_BY         VARCHAR       DEFAULT 'promotion'   COMMENT 'promotion (seed at ET rescue) | future: et_refresher',

  MATCHED            BOOLEAN                             COMMENT 'ET recognized the concept at observation time',
  KEYWORD            VARCHAR                             COMMENT 'the ET keyword the agent judged as the same concept',
  ABSOLUTE_VOLUME    NUMBER                             COMMENT 'ET absolute_volume (searches last month) for KEYWORD',
  GROWTH             VARIANT                            COMMENT 'ET per-timeframe % growth (non-gating)',
  CLASSIFICATIONS    VARIANT                            COMMENT 'ET per-timeframe class regular|exploding|peaked (non-gating)',
  RAW                VARIANT                            COMMENT 'full ET snapshot as captured on the candidate (ET_CORROBORATION)',

  CANDIDATE_ID       VARCHAR                            COMMENT 'lineage: the STG_TREND_CANDIDATES row this trend was promoted from',
  QUERIED            VARCHAR                            COMMENT 'the candidate query string ET was looked up by'
);
