-- Test variant of STG_EXTERNAL_SIGNALS for verifying the migrated
-- batch ingesters in isolation from the legacy p_wOC6RQO writes.
-- Same schema as production; the migrated workflows write here while
-- legacy continues to fill production. Once each new workflow is
-- confirmed producing rows, switch its TARGET_TABLE_NAME back to
-- 'STG_EXTERNAL_SIGNALS' and deactivate the matching legacy trigger.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS_TEST (
  SIGNAL_ID         VARCHAR(255),
  INGESTED_AT       TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP(),
  SOURCE_NAME       VARCHAR(50),
  SIGNAL_TIMESTAMP  TIMESTAMP_NTZ(9),
  SIGNAL_TITLE      VARCHAR(16777216),
  SIGNAL_TEXT       VARCHAR(16777216),
  METADATA          VARIANT,
  AGENT_SESSION_ID  VARCHAR(64) NULL
) COMMENT = 'Mirror of STG_EXTERNAL_SIGNALS used for testing migrated batch ingesters before cutover';
