-- Procedure: Release in-flight distillation claims whose run died
-- (CRMA-1448).
-- Database: MCC_RAW.MARKETING_DEV
--
-- distillation's acquire_signal_ids claims its pool with a stamp
-- 'claim-<epoch ms>-<uuid>' BEFORE the 6-10 min cluster-agent suspend.
-- settle_claims, at the end of the run, either turns the claim into the
-- run's 'sess-' session id (candidates committed, including a run that
-- proposed 0 -- its signals were seen and stay consumed) or releases it
-- (cluster agent timed out or errored). A claim that is still a 'claim-'
-- stamp 30 min after it was made belongs to a run that died before
-- settling (the suspend timeout is 20 min), so it is released here.
--
-- Only touches 'claim-%' stamps. A younger claim belongs to a run still
-- in flight and is never released, so overlapping runs cannot free each
-- other's claims. 'sess-' (settled distillation), 'enr-sess-' (enrichment)
-- and 'revisit-' stamps are permanent and out of scope.
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
    UPDATE MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
    SET AGENT_SESSION_ID = NULL
    WHERE AGENT_SESSION_ID LIKE 'claim-%'
      AND COALESCE(TRY_TO_NUMBER(SPLIT_PART(AGENT_SESSION_ID, '-', 2)), 0)
          < DATE_PART(epoch_millisecond, CURRENT_TIMESTAMP()) - 30 * 60 * 1000;

    released_count := SQLROWCOUNT;

    RETURN OBJECT_CONSTRUCT(
        'released_count', released_count,
        'released_at', CURRENT_TIMESTAMP()
    );
END;
$$;
