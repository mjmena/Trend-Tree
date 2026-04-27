-- Procedure: Release distillation-side AGENT_SESSION_ID stamps that didn't
-- end up in any candidate's SUPPORTING_SIGNAL_IDS.
-- Database: MCC_RAW.MARKETING_DEV
--
-- Why this exists: when a distillation lead lambda hits its 12.5-min timeout
-- mid-loop, signals can be stamped (claimed by a session) without ever
-- landing in a candidate's SUPPORTING_SIGNAL_IDS. Those signals stay locked
-- forever otherwise, draining the unclaimed-pool the next run draws from.
--
-- Rule: a session is "settled" if at least one of its candidates exists in
-- STG_TREND_CANDIDATES. For settled sessions, only signals referenced in
-- THAT session's candidates' SUPPORTING_SIGNAL_IDS are kept stamped; the
-- rest are released. In-flight sessions (no candidates yet) are left alone
-- to avoid racing them.
--
-- Only touches distillation stamps (AGENT_SESSION_ID LIKE 'sess-%').
-- Enrichment stamps (`enr-sess-%`) are out of scope -- enrichment locks
-- signals it cited and that's a legitimate claim.
--
-- Usage (called as the first step of distillation-p_mkCBBqb so each run
-- starts with a clean unclaimed pool):
--   CALL MCC_RAW.MARKETING_DEV.PROC_RELEASE_STALE_SIGNAL_CLAIMS();

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_RELEASE_STALE_SIGNAL_CLAIMS()
RETURNS VARIANT
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
    released_count INTEGER DEFAULT 0;
BEGIN
    UPDATE MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
    SET AGENT_SESSION_ID = NULL
    WHERE s.AGENT_SESSION_ID LIKE 'sess-%'
      AND s.AGENT_SESSION_ID IN (
          -- Settled sessions: at least one candidate written
          SELECT DISTINCT c.AGENT_SESSION_ID
          FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
          WHERE c.AGENT_SESSION_ID LIKE 'sess-%'
      )
      AND NOT EXISTS (
          -- Signal not in any of THIS session's candidates' supporting arrays
          SELECT 1
          FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
               LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
          WHERE c.AGENT_SESSION_ID = s.AGENT_SESSION_ID
            AND f.value::STRING = s.SIGNAL_ID
      );

    released_count := SQLROWCOUNT;

    RETURN OBJECT_CONSTRUCT(
        'released_count', released_count,
        'released_at', CURRENT_TIMESTAMP()
    );
END;
$$;
