-- Batched MERGE into a configurable target table (defaults to
-- STG_EXTERNAL_SIGNALS). Lets us route the just-migrated batch
-- ingesters to STG_EXTERNAL_SIGNALS_TEST while leaving the agent
-- tool wrappers writing to production until we're confident.
--
-- Usage from a workflow.yaml step:
--
--   CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(
--     $${{steps.fetch_source.$return_value.signals_json}}$$,  -- json array
--     '',                                                     -- agent_session_id
--     500,                                                    -- batch size
--     'STG_EXTERNAL_SIGNALS_TEST'                             -- target table
--   )
--
-- Behavior:
--  * Chunks signals into BATCH_SIZE-row groups, each its own MERGE.
--  * INSERT on no-match (matches legacy — preserves first-seen METADATA).
--  * Tags AGENT_SESSION_ID on existing rows that don't have one yet,
--    never overwrites a non-NULL session_id.
--  * Validates TARGET_TABLE_NAME against [A-Z0-9_]+ to prevent injection.
--  * Returns { batches, signals, batch_size, session_id, target_table }.

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(
  SIGNALS_JSON VARCHAR,
  AGENT_SESSION_ID VARCHAR DEFAULT NULL,
  BATCH_SIZE FLOAT DEFAULT 500,
  TARGET_TABLE_NAME VARCHAR DEFAULT 'STG_EXTERNAL_SIGNALS'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS CALLER
AS
$$
  if (!SIGNALS_JSON || SIGNALS_JSON === '[]' || SIGNALS_JSON === '') {
    return { batches: 0, signals: 0, message: 'empty input' };
  }

  let signals;
  try {
    signals = JSON.parse(SIGNALS_JSON);
  } catch (e) {
    return { error: 'invalid JSON: ' + e.message, signals: 0, batches: 0 };
  }
  if (!Array.isArray(signals)) {
    return { error: 'expected array, got ' + typeof signals, signals: 0, batches: 0 };
  }

  const targetTable = (TARGET_TABLE_NAME || 'STG_EXTERNAL_SIGNALS').toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(targetTable)) {
    return { error: 'invalid target table name: ' + targetTable, signals: 0, batches: 0 };
  }

  const sessionId = (AGENT_SESSION_ID && AGENT_SESSION_ID.length > 0)
    ? AGENT_SESSION_ID
    : null;
  const batchSize = Math.max(1, Math.floor(BATCH_SIZE || 500));
  let totalProcessed = 0;
  let batchCount = 0;

  const mergeSql = `
    MERGE INTO MCC_RAW.MARKETING_DEV.${targetTable} AS target
    USING (
      SELECT
        s.value:SIGNAL_ID::STRING                               AS SIGNAL_ID,
        s.value:SOURCE_NAME::STRING                             AS SOURCE_NAME,
        TRY_TO_TIMESTAMP_NTZ(s.value:SIGNAL_TIMESTAMP::STRING)  AS SIGNAL_TIMESTAMP,
        s.value:SIGNAL_TITLE::STRING                            AS SIGNAL_TITLE,
        s.value:SIGNAL_TEXT::STRING                             AS SIGNAL_TEXT,
        TRY_PARSE_JSON(s.value:METADATA::STRING)                AS METADATA,
        ?::STRING                                               AS AGENT_SESSION_ID
      FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) s
    ) AS source
    ON target.SIGNAL_ID = source.SIGNAL_ID
    WHEN MATCHED
         AND target.AGENT_SESSION_ID IS NULL
         AND source.AGENT_SESSION_ID IS NOT NULL
    THEN UPDATE SET
      target.AGENT_SESSION_ID = source.AGENT_SESSION_ID
    WHEN NOT MATCHED THEN INSERT (
      SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP,
      SIGNAL_TITLE, SIGNAL_TEXT, METADATA, AGENT_SESSION_ID
    ) VALUES (
      source.SIGNAL_ID, source.SOURCE_NAME, source.SIGNAL_TIMESTAMP,
      source.SIGNAL_TITLE, source.SIGNAL_TEXT, source.METADATA, source.AGENT_SESSION_ID
    )
  `;

  for (let i = 0; i < signals.length; i += batchSize) {
    const batch = signals.slice(i, i + batchSize);
    const stmt = snowflake.createStatement({
      sqlText: mergeSql,
      binds: [sessionId, JSON.stringify(batch)],
    });
    stmt.execute();
    totalProcessed += batch.length;
    batchCount += 1;
  }

  return {
    batches: batchCount,
    signals: totalProcessed,
    batch_size: batchSize,
    session_id: sessionId,
    target_table: targetTable,
  };
$$;
