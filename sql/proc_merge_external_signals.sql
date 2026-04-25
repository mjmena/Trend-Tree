-- Batched MERGE into STG_EXTERNAL_SIGNALS.
--
-- Replaces the inline MERGE block that was duplicated across every
-- ingestion / tool-wrapper workflow.yaml. Now each upsert step is just:
--
--   CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(:1, :2, 500)
--
-- where :1 = signals_json (JSON array string), :2 = agent_session_id
-- (NULL or '' for batch ingesters), :3 = batch size.
--
-- Behavior:
--  * Chunks the signal array into BATCH_SIZE-row groups, each its own
--    MERGE (matches the 500-row chunking pattern in the legacy
--    Python-based upsert step).
--  * INSERT on no-match (matches legacy — does NOT overwrite content
--    on existing SIGNAL_IDs, so engagement metrics in METADATA stay
--    pinned to their first-seen values).
--  * For agent-fetched signals (session_id non-empty): if the row
--    already existed with NULL AGENT_SESSION_ID, we UPDATE it to the
--    fetching session so the audit trail captures who fetched what.
--    Doesn't overwrite an existing non-NULL session_id.
--  * Returns {batches, signals, batch_size, session_id} so the caller
--    can verify counts.

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(
  SIGNALS_JSON VARCHAR,
  AGENT_SESSION_ID VARCHAR DEFAULT NULL,
  BATCH_SIZE FLOAT DEFAULT 500
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

  // Coerce empty string → null so the WHEN MATCHED clause skips the
  // session-tag update on batch-ingester calls.
  const sessionId = (AGENT_SESSION_ID && AGENT_SESSION_ID.length > 0)
    ? AGENT_SESSION_ID
    : null;
  const batchSize = Math.max(1, Math.floor(BATCH_SIZE || 500));
  let totalProcessed = 0;
  let batchCount = 0;

  const mergeSql = `
    MERGE INTO MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS AS target
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
  };
$$;
