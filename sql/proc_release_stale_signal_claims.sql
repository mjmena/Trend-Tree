-- Procedure: Release AGENT_SESSION_ID stamps from sessions that never
-- wrote any candidate (true timeout orphans).
-- Database: MCC_RAW.MARKETING_DEV
--
-- Under the current distillation design, the claim_window_signals step
-- runs at the END of the workflow — AFTER candidates are persisted. So a
-- successful run produces both stamps and candidates together; a timed-out
-- run produces neither. This proc handles only the narrow edge case where
-- partial work landed stamps but the run died before any candidate was
-- written (or pre-existing legacy orphan rows from older code).
--
-- Rule: release stamps where the session has ZERO candidates in
-- STG_TREND_CANDIDATES. Defense-in-depth, called as the first step of
-- distillation so each run starts with a clean unclaimed pool.
--
-- Only touches distillation stamps (AGENT_SESSION_ID LIKE 'sess-%').
-- Enrichment stamps ('enr-sess-%') and revisit stamps ('revisit-%') are
-- out of scope -- those are legitimate, persistent claims.
--
-- Usage:
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
      AND NOT EXISTS (
          SELECT 1
          FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
          WHERE c.AGENT_SESSION_ID = s.AGENT_SESSION_ID
      );

    released_count := SQLROWCOUNT;

    RETURN OBJECT_CONSTRUCT(
        'released_count', released_count,
        'released_at', CURRENT_TIMESTAMP()
    );
END;
$$;
