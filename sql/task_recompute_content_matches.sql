-- MARKETING_TASK_RECOMPUTE_CONTENT_MATCHES (CRMA-452) — the deterministic,
-- no-LLM scheduled runner for the trend → published-content vector match.
-- Mirrors MARKETING_TASK_RECOMPUTE_CONNECTIONS (CRMA-462, task_recompute_
-- connections.sql): the recompute is pure SQL, so a native Snowflake task
-- runs it in-warehouse with no Pipedream workflow / lambda / UI-created
-- shell needed. (The prediction-agent-p_QPCkLP1 workflow layers a Pipedream
-- HTTP trigger + dry_run guard on top of a similar single-INSERT...SELECT
-- shape, but CRMA-462 — the closer no-LLM cosine-similarity analog — landed
-- as a plain task with no HTTP surface, and this ticket follows that actual
-- precedent rather than the Pipedream one: no new workflow to deploy/debug,
-- pure SQL substrate only.)
--
-- Each fire recomputes the FULL trend x recent-content matrix and appends
-- one generation (fresh CHAIN_ID + COMPUTED_AT) to
-- FCT_TREND_CONTENT_MATCHES_LEDGER. DT_TREND_DASHBOARD.NEAREST_CONTENT
-- flips to the newest generation on its next refresh. Every run reads the
-- current CUE_CONTENT_VECTORS window + current live-trend set, so newly
-- promoted trends and freshly published content are both picked up
-- automatically — no event wiring needed for v1.
--
-- Path A (no content re-embedding): CUE_CONTENT_VECTORS.KEY_WORDS_VECTOR is
-- read exactly as the data team wrote it. Only the TREND side is embedded
-- here, fresh, every run — SNOWFLAKE.CORTEX.EMBED_TEXT_768 is cheap enough
-- that re-embedding ~250 short trend docs per run costs nothing worth
-- storing a standalone vector column for; only the match RESULTS are
-- persisted (issue: keeps this table's own 1024-dim TREND_VECTOR concept
-- from ever being confused with this 768-dim one).
--
-- Embed-doc recipe (calibrated 2026-08-18, see spot-check below): TREND_NAME
-- + '. ' + SUMMARY_SHORT (falling back to SUMMARY_LONG). Deliberately NOT
-- the fuller TREND_TOPIC + SUMMARY_LONG shape FN_TREND_EMBED_DOC uses for
-- the internal 1024-dim space — that recipe is tuned for arctic-embed-l-v2,
-- not this keyword-level 768 space. Side-by-side on the same trend
-- ("Dollar-Store Default") and the same 180d content pool: NAME +
-- SUMMARY_SHORT scored top cosine 0.677 with on-topic hits ("Dollar Store's
-- protein snacks...", "Dollar Tree coffee and protein picks..."); TOPIC +
-- SUMMARY_LONG on the same trend scored top cosine only 0.542 with generic,
-- off-topic hits ("Gen Z Retail Habits...") — the longer prose dilutes the
-- signal a fixed-size vector can carry. Shorter and more keyword-dense
-- wins against this particular content space.
--
-- Content pool: CUE_CONTENT_VECTORS rows published within WINDOW_DAYS,
-- restricted to HEADLINE IS NOT NULL (populated on only ~13-18% of rows in
-- any window — verified 2026-08-18; a vector can exist with no headline,
-- and a "nearest article" nobody can read is worse than no match) AND
-- KEY_WORDS_VECTOR IS NOT NULL.
--
-- Calibration (2026-08-18, live spot-check across a 40-trend sample plus
-- two named trends — see CRMA-452 PR description for the full readout):
--   * MATCH_THRESHOLD = 0.60 — separates "Dollar-Store Default" (broad
--     retail/economy trend, top cosine 0.677, plausible on-topic matches
--     down to ~0.64) from "C15:0 Longevity Supplements" (niche wellness
--     supplement, top cosine 0.582 — generic longevity/anti-aging
--     adjacency, nothing specific to C15:0/pentadecanoic acid/Fatty15) —
--     the under-covered trend clears zero rows at this threshold, which is
--     exactly the desired "weak/no matches" behavior.
--   * WINDOW_DAYS = 180 — matches the rolling-window recipe already
--     sketched in docs/dashboard/migrating-data-sources.md.
--   * TOP_N = 5 — mirrors DT_TREND_DASHBOARD.RELATED_TRENDS' existing top-5
--     convention.
-- Re-tune by editing the `params` CTE below and re-running CREATE OR
-- REPLACE TASK; MATCH_THRESHOLD/WINDOW_DAYS are recorded per row so past
-- generations stay auditable against whatever cutoff produced them.
--
-- Manual run / backfill: `EXECUTE TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_RECOMPUTE_CONTENT_MATCHES;`
--
-- OWNERSHIP: transferred to MARKETING_ENGINEER while suspended, then
-- resumed as the new owner — same reasoning and same warehouse
-- (MARKETING_WH) as MARKETING_TASK_RECOMPUTE_CONNECTIONS; see that file's
-- header for the full ownership-grant explanation (EXECUTE TASK + WAREHOUSE
-- USAGE must both be granted to the owner role, which lands on
-- MCC_PRESENTATION_TREND_AGENT_SFULL by default regardless of USE ROLE).
--
-- Scale note: ~250 live trends x a 180d/headlined CUE_CONTENT_VECTORS
-- window (~65-140K rows depending on time of year) is a few million to
-- ~35M VECTOR_COSINE_SIMILARITY calls per run — a live 40-trend sample of
-- this exact query against the 180d/headlined pool ran in ~45s on the
-- default warehouse. Not a today problem at ~250 trends; if the live-trend
-- count or WINDOW_DAYS grows a lot, move WAREHOUSE to CORTEX_M the way
-- PROC_MATCH_GSC_DEMAND had to for its much larger (144M-row) pool.

CREATE OR REPLACE TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_RECOMPUTE_CONTENT_MATCHES
  WAREHOUSE = MARKETING_WH
  SCHEDULE  = 'USING CRON 0 17 * * * UTC'   -- daily 17:00 UTC (clear of audit 13:00 / prediction 14:00 / connections 16:00)
  COMMENT   = 'CRMA-452 -- daily per-trend nearest-published-content recompute -> FCT_TREND_CONTENT_MATCHES_LEDGER'
AS
INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_CONTENT_MATCHES_LEDGER (
  CHAIN_ID, TREND_ID, CONTENT_ID, HEADLINE, PUBLISHED_DATE, SCORE, MATCH_RANK,
  MATCH_THRESHOLD, WINDOW_DAYS
)
WITH params AS (
  SELECT 0.60::FLOAT AS match_threshold,
         180         AS window_days,
         5           AS top_n
),
latest_lifecycle AS (
  SELECT TREND_ID, NEW_STATUS AS LIFECYCLE_STATUS
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
  ) WHERE rn = 1
),
latest_enrichment AS (
  SELECT TREND_ID,
         PAYLOAD:summary_short::STRING AS SUMMARY_SHORT,
         PAYLOAD:summary_long::STRING  AS SUMMARY_LONG
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  ) WHERE rn = 1
),
live_trends AS (
  -- "Live" = everything except RETIRED (a trend with no lifecycle row yet
  -- is treated as live/NEW) -- same scope convention as the prediction
  -- agent's `raw` CTE.
  SELECT
    t.TREND_ID,
    COALESCE(t.TREND_NAME, t.TREND_NAME_B2C, t.TREND_NAME_B2B, t.TREND_TOPIC) AS TREND_NAME,
    COALESCE(e.SUMMARY_SHORT, e.SUMMARY_LONG)                                 AS SUMMARY
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
  LEFT JOIN latest_lifecycle  lc ON lc.TREND_ID = t.TREND_ID
  LEFT JOIN latest_enrichment e  ON e.TREND_ID  = t.TREND_ID
  WHERE NVL(lc.LIFECYCLE_STATUS, 'NEW') <> 'RETIRED'
    AND COALESCE(t.TREND_NAME, t.TREND_NAME_B2C, t.TREND_NAME_B2B, t.TREND_TOPIC) IS NOT NULL
),
trend_vectors AS (
  -- Companion 768-dim vector per live trend, computed fresh every run
  -- (never persisted standalone -- see header).
  SELECT
    TREND_ID,
    SNOWFLAKE.CORTEX.EMBED_TEXT_768(
      'snowflake-arctic-embed-m-v1.5',
      TREND_NAME || '. ' || COALESCE(SUMMARY, '')
    ) AS TREND_CONTENT_VECTOR
  FROM live_trends
),
content_pool AS (
  SELECT c.CONTENTID, c.HEADLINE, c.PUBLISHED_DATE, c.KEY_WORDS_VECTOR
  FROM MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS c, params p
  WHERE c.PUBLISHED_DATE >= DATEADD(day, -p.window_days, CURRENT_DATE)
    AND c.HEADLINE IS NOT NULL
    AND c.KEY_WORDS_VECTOR IS NOT NULL
),
scored AS (
  SELECT
    tv.TREND_ID,
    cp.CONTENTID,
    cp.HEADLINE,
    cp.PUBLISHED_DATE,
    ROUND(VECTOR_COSINE_SIMILARITY(tv.TREND_CONTENT_VECTOR, cp.KEY_WORDS_VECTOR)::FLOAT, 4) AS SCORE
  FROM trend_vectors tv
  JOIN content_pool cp
),
ranked AS (
  SELECT
    s.TREND_ID, s.CONTENTID, s.HEADLINE, s.PUBLISHED_DATE, s.SCORE,
    ROW_NUMBER() OVER (PARTITION BY s.TREND_ID ORDER BY s.SCORE DESC, s.CONTENTID) AS MATCH_RANK
  FROM scored s, params p
  WHERE s.SCORE >= p.match_threshold
  QUALIFY MATCH_RANK <= p.top_n
)
SELECT
  'content-match-task-' || TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYYMMDDHH24MISSFF3') AS CHAIN_ID,
  r.TREND_ID,
  r.CONTENTID          AS CONTENT_ID,
  r.HEADLINE,
  r.PUBLISHED_DATE,
  r.SCORE,
  r.MATCH_RANK,
  p.match_threshold     AS MATCH_THRESHOLD,
  p.window_days         AS WINDOW_DAYS
FROM ranked r, params p;

-- Transfer ownership to MARKETING_ENGINEER while the task is still
-- suspended (CREATE leaves it suspended). COPY CURRENT GRANTS preserves
-- any existing grants.
USE ROLE MCC_PRESENTATION_TREND_AGENT_SFULL;
GRANT OWNERSHIP ON TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_RECOMPUTE_CONTENT_MATCHES
  TO ROLE MARKETING_ENGINEER COPY CURRENT GRANTS;

-- Resume as the new owner to activate the daily schedule.
USE SECONDARY ROLES NONE;
USE ROLE MARKETING_ENGINEER;
ALTER TASK MCC_PRESENTATION.TREND_AGENT.MARKETING_TASK_RECOMPUTE_CONTENT_MATCHES RESUME;
