-- Append-only verdict ledger for the prediction pillar (CRMA-762; schema
-- decisions from CRMA-486, docs/prediction-pillar-strategy.md §6).
--
-- Falsifiability is a schema constraint, not just app-level validation: the
-- four claim columns (SUBJECT_DESCRIPTOR, DIRECTIONAL_CLAIM, HORIZON_AT,
-- OBSERVABLE_CHECK) are NOT NULL, so a claim can never be stored incomplete.
-- The claim is frozen at PREDICTION_ID's first mint -- re-evaluations of the
-- same prediction append a new row (grain: PREDICTION_ID x evaluation,
-- PREDICTION_EVAL_ID is the row's own primary key) echoing the same four
-- claim values; nothing here enforces that echo mechanically (Snowflake has
-- no cross-row CHECK), so it is the writing service's contract -- see
-- services/prediction/prediction_service/domain/claim.py.
--
-- Idempotency: PREDICTION_EVAL_ID keeps its DEFAULT UUID_STRING() for
-- ad-hoc/manual inserts, but the service ALWAYS supplies it and writes with
-- MERGE ... WHEN NOT MATCHED (domain/ledger.py), never a bare INSERT. That
-- matters because Snowflake's PRIMARY KEY is informational and enforces
-- nothing: a retried DML whose first attempt had already committed (the
-- shared client retries transport-shaped failures) would otherwise append a
-- second row under a fresh server-side UUID, with no constraint to catch it.
-- A caller-minted id turns that retry into a matched no-op.
-- No schema change is needed for this -- the column already exists and the
-- default is unchanged.
--
-- Mirrors the one-ledger-per-agent convention (FCT_TREND_LIFECYCLE_LEDGER,
-- FCT_TREND_CONNECTIONS_LEDGER, and the now-frozen FCT_TREND_PREDICTION_LEDGER
-- v1/v2 this table supersedes -- that table takes no new writes as of this
-- change, per the strategy doc's "old ledger freezes" decision).
--
-- Isolation invariant: prediction outputs are NEVER read by HEAT_INDEX,
-- LIFECYCLE_STATUS, or any other trend-scoring path. This table is written
-- and read only by the prediction service and, later, the dashboard
-- projection's additive columns.
CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER (
  PREDICTION_EVAL_ID   VARCHAR(64)   DEFAULT UUID_STRING() PRIMARY KEY  COMMENT 'this row''s identity; supplied by the writing service so a retried write MERGEs into a no-op instead of duplicating (the PK is informational in Snowflake and enforces nothing)',
  PREDICTION_ID        VARCHAR(64)   NOT NULL                COMMENT 'minted at first emission; stable across every re-evaluation of the same prediction',
  EVALUATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CHAIN_ID             VARCHAR(64)                           COMMENT 'pred-verdict-chain-{8-char random}, one value per run/generation pass',

  -- Claim (frozen at mint) -- the falsifiable 4-part structure (strategy §2).
  SUBJECT_DESCRIPTOR   VARCHAR(256)  NOT NULL                COMMENT 'atomic descriptor-vocabulary subject (ADR-0003) -- e.g. "rucking vests"',
  DIRECTIONAL_CLAIM    VARCHAR(1024) NOT NULL                COMMENT 'what changes in the world -- e.g. "mainstream retail adoption expands beyond specialty fitness"',
  HORIZON_AT           TIMESTAMP_NTZ NOT NULL                COMMENT 'real timestamp derived from HORIZON_BAND at mint (band upper bound); resolution timing keys off this',
  OBSERVABLE_CHECK     VARCHAR(1024) NOT NULL                COMMENT 'what we look at to grade the claim -- e.g. "major-retailer listings + sustained search-interest growth"',
  HORIZON_BAND         VARCHAR(32)   NOT NULL                COMMENT 'controlled vocabulary (strategy §7.5): near_term_1_3mo | emerging_3_6mo | cultural_shift_6_12mo | longer_range_12_24mo',

  -- Verdict (two axes, never conflated -- strategy §6).
  CONFIDENCE           NUMBER(5,1)   NOT NULL                COMMENT 'calibrated confidence, 0.0-100.0; projects to the dashboard PREDICTION_SCORE for the latest active matched verdict',
  PREDICTION_STATUS    VARCHAR(32)   NOT NULL                COMMENT 'ACTIVE | RESOLVED_TRUE | RESOLVED_FALSE | EXPIRED | WITHDRAWN',

  MATCHED_TREND_ID     VARCHAR(64)                           COMMENT 'FCT_TRENDS.TREND_ID this verdict corroborates; NULL = white-space prediction (ledger-only in v1, strategy §2)',

  -- Evidence + narrative.
  EVIDENCE             VARIANT                               COMMENT 'contracted keys, all required to be present even when null: source_signals (FCT_SIGNALS ids), saturation (ET + GDELT), trend_context (heat/accel/growth/age, NULL for white-space), coverage (internal-coverage detections)',
  REASONING            VARCHAR(4000)                         COMMENT 'the agent''s verdict rationale at this evaluation',
  WHAT_CHANGED         VARCHAR(4000)                         COMMENT 'what moved since the prior verdict on this PREDICTION_ID; NULL on first mint',

  -- Strategist-facing narrative (CRMA-782). Deliberately NOT part of the
  -- claim: the four claim columns are machine-facing (ADR-0003's register,
  -- plus OBSERVABLE_CHECK's named-source-and-threshold rule) so that two
  -- people grade a claim identically. That leaves nowhere for "why does this
  -- matter" to live, and putting it in DIRECTIONAL_CLAIM would break
  -- gradability. Both are NULLABLE: NOT NULL stays attached to the claim
  -- alone, where the falsifiability guarantee belongs, and every row written
  -- before this change reads back valid.
  --
  -- Neither column may ever feed CONFIDENCE, PREDICTION_STATUS,
  -- MATCHED_TREND_ID, or the dashboard's PREDICTION_SCORE / _FLAG /
  -- _ELIGIBLE. Same rule EVIDENCE.trend_context carries: addressed context,
  -- never a filter.
  ANGLE                VARCHAR(512)                          COMMENT 'one sentence, reader-facing register, on why this change matters culturally; NULL when the model did not narrate it',
  AUDIENCE_QUESTION    VARCHAR(256)                          COMMENT 'the question this call invites us to put to readers; NULL when the model did not narrate it',

  COMPUTATION_VERSION  VARCHAR(16)   DEFAULT 'v1'            COMMENT 'bump when the verdict/evidence contract changes; auditable lineage'
);
