-- Procedure: Release distillation claims whose run died before settling.
-- Database: MCC_RAW.MARKETING_DEV
--
-- Frees only 'claim-<epoch ms>-<uuid>' stamps older than 45 min: claim to
-- settle can take ~12.5 min (lambda) + 20 min (suspend), and a suspend timeout
-- cancels the run without settling. 'sess-', 'enr-sess-', 'revisit-' are permanent.
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
          < DATE_PART(epoch_millisecond, CURRENT_TIMESTAMP()) - 45 * 60 * 1000;

    released_count := SQLROWCOUNT;

    RETURN OBJECT_CONSTRUCT(
        'released_count', released_count,
        'released_at', CURRENT_TIMESTAMP()
    );
END;
$$;
