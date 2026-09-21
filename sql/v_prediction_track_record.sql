-- The prediction pillar's track record, derived (CRMA-771).
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- One row per PREDICTION_ID in FCT_PREDICTION_VERDICT_LEDGER, carrying the
-- grade the strategy doc's §7.6 table assigns it. A VIEW, not a dynamic
-- table, deliberately: the strategy's rule is that the grade is "always
-- derived", never stored, and a dynamic table would store it. Nothing here
-- writes, filters the pipeline, or feeds any scoring path -- it is a read
-- over an append-only ledger.
--
-- The grading table (docs/prediction-pillar-strategy.md §7.6, PRD
-- docs/prd/prediction-pillar-v1.md), reproduced verbatim:
--
--   | Latest status            | Resolving timestamp vs horizon | Grade      |
--   | RESOLVED_TRUE            | inside window                  | Correct    |
--   | RESOLVED_TRUE            | outside window                 | Early–Late |
--   | RESOLVED_FALSE           | --                             | Incorrect  |
--   | EXPIRED (no later truth) | --                             | Incorrect  |
--   | WITHDRAWN                | --                             | excluded   |
--
-- Three facts decide it, and all three come off the ledger: the LATEST
-- PREDICTION_STATUS for the id, the resolving verdict's EVALUATED_AT, and
-- the frozen claim's HORIZON_AT + HORIZON_BAND.
--
-- **A pure function of ledger state.** There is no clock in this view. Every
-- column is derived from the rows themselves, so re-deriving at any later
-- instant over unchanged rows returns exactly what it returned before, and a
-- grade only ever moves because a new row was appended. Reading SYSDATE()
-- here would have made "is this grade final yet" a property of when you asked
-- rather than of what the ledger says -- and would have answered it before
-- the sweep had written the row that settles it (see FINAL_ROW_WRITTEN).
--
-- **Grade values are the ledger's register, not the methodology's.**
-- TRACK_RECORD_GRADE reads CORRECT / EARLY_LATE / INCORRECT, matching
-- PREDICTION_STATUS's SCREAMING_SNAKE vocabulary -- the column it is derived
-- from and the column it will be filtered alongside. The methodology's
-- rendering is Correct / Early–Late / Incorrect (note the en dash), and a
-- surface that displays a grade renders it; putting the en dash in the stored
-- value would make `WHERE TRACK_RECORD_GRADE = 'Early–Late'` silently return
-- nothing for anyone who typed a hyphen.
--
-- **"Early" is not separately reachable, and that is the table as written.**
-- The window has an upper bound (HORIZON_AT) and no lower one -- the bands in
-- domain/claim.py are upper bounds only -- so "inside window" means "at or
-- before the horizon" and a claim that came true far sooner than its band
-- suggested reads CORRECT, not EARLY_LATE. That is faithful to §7.6, whose
-- only distinction is inside/outside, and it is the conservative reading: the
-- alternative would need a lower bound the schema does not have, and grading
-- a call wrong for arriving early is a judgement nobody has made. Stated here
-- because the grade's NAME promises a distinction the data cannot yet draw.
--
-- **Latest is a window over PREDICTION_ID.** The ledger is append-only and one
-- prediction has many rows, so every fact below is ranked within its own
-- PREDICTION_ID partition and joined back on that id. Subject text is carried
-- for readability and is never a key: two live predictions may share a
-- SUBJECT_DESCRIPTOR, and grading one by the other's rows would permanently
-- mis-record both. The tie-break on PREDICTION_EVAL_ID mirrors
-- matching/predictions.py's OPEN_PREDICTIONS_QUERY, so "latest" means the same
-- row here as it does to the service that writes them.
--
-- **The grace window is one horizon length past HORIZON_AT**, the same
-- definition prediction_service/sweep/lifecycle.py's grace_ends_at() applies
-- in Python, over the same per-band day counts as domain/claim.py's
-- _HORIZON_BAND_DAYS. Two homes for one rule is a divergence risk, so
-- tests/test_track_record.py executes this view per band and asserts its
-- GRACE_ENDS_AT equal to what grace_ends_at() returns, and its freeze
-- boundary equal to what is_past_grace() decides -- a change to either side
-- that is not made to both fails the suite.
--
-- Derived from the band rather than from the mint row's EVALUATED_AT for
-- lifecycle.py's reason: HORIZON_AT and HORIZON_BAND are frozen claim
-- columns written from aware UTC datetimes, while EVALUATED_AT on rows
-- written before CRMA-764 carries Snowflake's session-local
-- CURRENT_TIMESTAMP(), about four hours off UTC. A grace window derived from
-- the band cannot be moved by that skew.
--
-- RESOLVED_AT is where that skew is unavoidable: "the resolving verdict's
-- timestamp" has no source but EVALUATED_AT, and
-- sql/backfill_prediction_verdict_evaluated_at_utc.sql is proposed, not
-- applied. Worth naming, not worth mitigating: the comparison is against a
-- horizon months away, so four hours only decides a truth landing within
-- hours of the horizon, and every row the sweep writes has carried UTC since
-- CRMA-764.
--
-- **A grade appears only when it is final**, and the ledger says when that is.
-- An EXPIRED prediction still inside its grace window is PENDING: the sweep is
-- re-checking it and a truth arriving in that window flips it to EARLY_LATE
-- (strategy §7.6, PRD user story 12). It stays PENDING even once the window
-- has elapsed, until the sweep has written the final row lifecycle.py owes it
-- -- see is_reevaluable(), which selects an EXPIRED prediction one more time
-- after the close precisely so a truth visible at the boundary can still
-- resolve it. Grading on elapsed time alone would publish INCORRECT during
-- that gap for a call the very next evaluation can still flip.
--
-- An unknown HORIZON_BAND yields a NULL grace window and therefore stays
-- PENDING forever rather than freezing on a window nobody defined -- the safe
-- direction for a row this service did not write.
--
-- **WITHDRAWN is excluded, and exclusion is visible.** It gets a row with
-- TRACK_RECORD_STATE = 'EXCLUDED' and a NULL grade rather than disappearing:
-- excluding a human-rejected call from the accuracy measure is grading, not
-- gating, and a reader has to be able to see how many were excluded. The
-- pillar's one mechanical gate is CRMA-765's mint-time data-quality floor;
-- this view adds none.
--
-- Aggregate accuracy, by horizon band, in one query (PRD user story 11):
--
--   SELECT HORIZON_BAND,
--          COUNT(*)                                                  AS GRADED,
--          SUM(CASE WHEN TRACK_RECORD_GRADE = 'CORRECT'    THEN 1 ELSE 0 END) AS CORRECT,
--          SUM(CASE WHEN TRACK_RECORD_GRADE = 'EARLY_LATE' THEN 1 ELSE 0 END) AS EARLY_LATE,
--          SUM(CASE WHEN TRACK_RECORD_GRADE = 'INCORRECT'  THEN 1 ELSE 0 END) AS INCORRECT
--   FROM MCC_PRESENTATION.TREND_AGENT.V_PREDICTION_TRACK_RECORD
--   WHERE TRACK_RECORD_STATE = 'GRADED'
--   GROUP BY HORIZON_BAND;
CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_PREDICTION_TRACK_RECORD AS

-- Every evaluation of every prediction, each ranked within its own
-- PREDICTION_ID. The CTEs below read this: LATEST takes rank 1, the other two
-- span the whole partition.
WITH EVALUATIONS AS (
    SELECT
        PREDICTION_ID,
        PREDICTION_EVAL_ID,
        EVALUATED_AT,
        PREDICTION_STATUS,
        SUBJECT_DESCRIPTOR,
        DIRECTIONAL_CLAIM,
        HORIZON_BAND,
        HORIZON_AT,
        MATCHED_TREND_ID,
        ROW_NUMBER() OVER (
            PARTITION BY PREDICTION_ID
            ORDER BY EVALUATED_AT DESC, PREDICTION_EVAL_ID DESC
        ) AS EVAL_RANK
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER
),

-- When the prediction was minted: the third of the strategy's three facts,
-- carried for the reader. No grade depends on it.
MINT AS (
    SELECT
        PREDICTION_ID,
        MIN(EVALUATED_AT) AS FIRST_EVALUATED_AT
    FROM EVALUATIONS
    GROUP BY PREDICTION_ID
),

-- When each prediction FIRST said what it now says. Joined on the latest
-- status below, so the resolving timestamp is the moment the call was
-- settled -- not the timestamp of some later row restating it. A claim that
-- came true before its horizon reads CORRECT even if a redundant
-- RESOLVED_TRUE row were appended after the horizon had passed.
FIRST_SETTLED AS (
    SELECT
        PREDICTION_ID,
        PREDICTION_STATUS,
        MIN(EVALUATED_AT) AS RESOLVED_AT
    FROM EVALUATIONS
    WHERE PREDICTION_STATUS IN ('RESOLVED_TRUE', 'RESOLVED_FALSE')
    GROUP BY PREDICTION_ID, PREDICTION_STATUS
),

LATEST AS (
    SELECT
        PREDICTION_ID,
        PREDICTION_EVAL_ID AS LATEST_EVAL_ID,
        EVALUATED_AT       AS LATEST_EVALUATED_AT,
        PREDICTION_STATUS  AS LATEST_STATUS,
        SUBJECT_DESCRIPTOR,
        DIRECTIONAL_CLAIM,
        HORIZON_BAND,
        HORIZON_AT,
        MATCHED_TREND_ID,
        -- One horizon length past HORIZON_AT. Keep these four day counts in
        -- step with domain/claim.py's _HORIZON_BAND_DAYS.
        CASE HORIZON_BAND
            WHEN 'near_term_1_3mo'       THEN HORIZON_AT + INTERVAL '90 days'
            WHEN 'emerging_3_6mo'        THEN HORIZON_AT + INTERVAL '180 days'
            WHEN 'cultural_shift_6_12mo' THEN HORIZON_AT + INTERVAL '365 days'
            WHEN 'longer_range_12_24mo'  THEN HORIZON_AT + INTERVAL '730 days'
        END AS GRACE_ENDS_AT
    FROM EVALUATIONS
    WHERE EVAL_RANK = 1
),

GRADING_INPUTS AS (
    SELECT
        l.PREDICTION_ID,
        l.SUBJECT_DESCRIPTOR,
        l.DIRECTIONAL_CLAIM,
        l.HORIZON_BAND,
        l.HORIZON_AT,
        l.GRACE_ENDS_AT,
        l.MATCHED_TREND_ID,
        l.LATEST_EVAL_ID,
        l.LATEST_EVALUATED_AT,
        l.LATEST_STATUS,
        m.FIRST_EVALUATED_AT,
        s.RESOLVED_AT,
        -- The last row lifecycle.py owes this prediction has been written.
        -- next_status() emits its final EXPIRED row from the `now >=
        -- closes_at` branch and no other, so an EXPIRED row evaluated at or
        -- after the close IS that row -- and nothing is appended after it, so
        -- the grade derived from it cannot move. Same instant either way:
        -- domain/ledger.py writes EVALUATED_AT from the very moment
        -- sweep/run.py handed to next_status().
        CASE
            WHEN l.GRACE_ENDS_AT IS NOT NULL AND l.LATEST_EVALUATED_AT >= l.GRACE_ENDS_AT
                THEN TRUE
            ELSE FALSE
        END AS FINAL_ROW_WRITTEN
    FROM LATEST l
    JOIN MINT m
      ON m.PREDICTION_ID = l.PREDICTION_ID
    LEFT JOIN FIRST_SETTLED s
      ON s.PREDICTION_ID = l.PREDICTION_ID
     AND s.PREDICTION_STATUS = l.LATEST_STATUS
),

-- The grading table, and the only place it is written down. Every arm is one
-- row of the strategy's §7.6 table; a status with no arm has no grade yet.
GRADED AS (
    SELECT
        GRADING_INPUTS.*,
        CASE
            WHEN LATEST_STATUS = 'RESOLVED_TRUE' AND RESOLVED_AT <= HORIZON_AT THEN 'CORRECT'
            WHEN LATEST_STATUS = 'RESOLVED_TRUE' THEN 'EARLY_LATE'
            WHEN LATEST_STATUS = 'RESOLVED_FALSE' THEN 'INCORRECT'
            WHEN LATEST_STATUS = 'EXPIRED' AND FINAL_ROW_WRITTEN THEN 'INCORRECT'
        END AS TRACK_RECORD_GRADE
    FROM GRADING_INPUTS
)

SELECT
    PREDICTION_ID,
    SUBJECT_DESCRIPTOR,
    DIRECTIONAL_CLAIM,
    HORIZON_BAND,
    HORIZON_AT,
    GRACE_ENDS_AT,
    MATCHED_TREND_ID,
    FIRST_EVALUATED_AT,
    LATEST_EVAL_ID,
    LATEST_EVALUATED_AT,
    LATEST_STATUS,
    RESOLVED_AT,
    FINAL_ROW_WRITTEN,

    -- Read off the grade rather than re-deciding it, so the two columns
    -- cannot disagree -- no row can read GRADED with no grade, or PENDING
    -- while carrying one.
    --   GRADED   -- the grade is final and counts in the track record.
    --   EXCLUDED -- a human withdrew the call; deliberately not graded.
    --   PENDING  -- still open, or expired and still being re-checked.
    CASE
        WHEN TRACK_RECORD_GRADE IS NOT NULL THEN 'GRADED'
        WHEN LATEST_STATUS = 'WITHDRAWN' THEN 'EXCLUDED'
        ELSE 'PENDING'
    END AS TRACK_RECORD_STATE,
    TRACK_RECORD_GRADE
FROM GRADED;
