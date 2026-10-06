-- Skip signals whose embed input is not valid UTF-8
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- INCIDENT 2026-08-27 → 2026-09-07. One Bluesky post ingested at
-- 02:27:20 carried a lone UTF-16 high surrogate (bytes ED A0 BC — half
-- of an emoji pair whose partner was missing). Snowflake stores such a
-- string without complaint; SNOWFLAKE.CORTEX.EMBED_TEXT_1024 rejects it:
--
--   512512 (P0000): Request failed for external function EMBED.
--   Error: invalid input: text is not valid UTF-8 encoded text
--
-- The task embeds the whole unpromoted backlog in ONE statement, so that
-- single row failed the entire INSERT. The task retried every 5 minutes,
-- failed identically each time, and Snowflake suspended it at 03:13 with
-- SUSPENDED_DUE_TO_ERRORS. FCT_SIGNALS then took no new rows for 11 days
-- while STG_EXTERNAL_SIGNALS kept filling — 11,424 rows backlogged, of
-- which exactly one was poisoned.
--
-- THE GUARD. In valid UTF-8, byte ED may only begin a 3-byte sequence
-- when the next byte is 80–9F (U+D000–U+D7FF). A second byte of A0–BF is
-- a surrogate code point, which UTF-8 forbids. So the hex pattern below,
-- anchored to an even offset so it can only match on a byte boundary,
-- matches invalid encodings and nothing else.
--
-- Skipping beats halting: one unembeddable post should cost one signal,
-- not the whole pipeline. This mirrors the scrape-gateway's rule in
-- services/lib/scrape_normalize.mjs — "one bad record never fails the
-- whole job: a partial pull beats no pull."
--
-- NAME DRIFT. The live object is MARKETING_TASK_PROMOTE_SIGNALS_TO_FCT;
-- sql/fct_signals.sql declares it unprefixed as
-- TASK_PROMOTE_SIGNALS_TO_FCT. The same split exists for the trend-signals
-- task. This migration targets the name that actually runs.
--
-- OWNERSHIP TRAP — read before re-running. CREATE OR REPLACE TASK here does
-- NOT preserve the task's owner. Running it in a session whose CURRENT_ROLE
-- is MARKETING_ENGINEER still produced a task owned by
-- MCC_PRESENTATION_TREND_AGENT_SFULL, which holds no USAGE on MARKETING_WH.
-- Every run then fails with:
--
--   Cannot execute task , USAGE privilege on the task's warehouse must be
--   granted to owner role
--
-- which is a DIFFERENT failure from the one this file fixes and looks
-- identical from FCT_SIGNALS (no new rows). The GRANT OWNERSHIP below
-- restores it. Verify with SHOW TASKS and check the `owner` column reads
-- MARKETING_ENGINEER before trusting a RESUME.

CREATE OR REPLACE TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_PROMOTE_SIGNALS_TO_FCT
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
  AND NOT HEX_ENCODE(s.SIGNAL_TITLE || ' ' || LEFT(COALESCE(s.SIGNAL_TEXT, ''), 512))
          RLIKE '([0-9A-F][0-9A-F])*ED[AB][0-9A-F].*'
  AND NOT EXISTS (
      SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f
      WHERE f.SIGNAL_ID = s.SIGNAL_ID
  )
QUALIFY ROW_NUMBER() OVER (PARTITION BY s.SIGNAL_ID ORDER BY s.INGESTED_AT ASC) = 1;

-- Restore the owner CREATE OR REPLACE dropped. Must run while suspended.
GRANT OWNERSHIP ON TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_PROMOTE_SIGNALS_TO_FCT
  TO ROLE MARKETING_ENGINEER COPY CURRENT GRANTS;

ALTER TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_PROMOTE_SIGNALS_TO_FCT RESUME;
