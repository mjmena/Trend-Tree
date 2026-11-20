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
COPY GRANTS
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
  const articleSources = new Set(['trend_hunter','gdelt','google_trends_rss','gemini_other',
    'agent_chatgpt_discovery','agent_gemini_discovery','agent_grok_discovery']);
  const articleCounts = {new_signals:0, repeat_sightings:0, syndicated_copies:0, unusable_records:0};
  const signalIds = {};
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
        s.value:URL::STRING                                     AS URL,
        TRY_PARSE_JSON(s.value:METADATA::STRING)                AS METADATA,
        s.value:REFRESH_OWNED_METADATA::BOOLEAN                 AS REFRESH_OWNED_METADATA,
        ?::STRING                                               AS AGENT_SESSION_ID
      FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) s
      QUALIFY ROW_NUMBER() OVER (PARTITION BY SIGNAL_ID ORDER BY SIGNAL_TIMESTAMP, s.index) = 1
    ) AS source
    ON target.SIGNAL_ID = source.SIGNAL_ID
    WHEN MATCHED AND source.REFRESH_OWNED_METADATA
         AND source.SOURCE_NAME = 'gemini_other' AND target.SOURCE_NAME = 'gemini_other'
    THEN UPDATE SET SIGNAL_TITLE=source.SIGNAL_TITLE, SIGNAL_TEXT=source.SIGNAL_TEXT,
      SIGNAL_TIMESTAMP=source.SIGNAL_TIMESTAMP, METADATA=source.METADATA
    WHEN MATCHED
         AND target.AGENT_SESSION_ID IS NULL
         AND source.AGENT_SESSION_ID IS NOT NULL
    THEN UPDATE SET
      target.AGENT_SESSION_ID = source.AGENT_SESSION_ID
    WHEN NOT MATCHED THEN INSERT (
      SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP,
      SIGNAL_TITLE, SIGNAL_TEXT, URL, METADATA, AGENT_SESSION_ID
    ) VALUES (
      source.SIGNAL_ID, source.SOURCE_NAME, source.SIGNAL_TIMESTAMP,
      source.SIGNAL_TITLE, source.SIGNAL_TEXT, source.URL, source.METADATA, source.AGENT_SESSION_ID
    )
  `;

  // A scheduled page commits its signal facts, receipts, metrics and cursor in its caller's transaction.
  const transaction = snowflake.execute({sqlText:'SELECT CURRENT_TRANSACTION()'});
  transaction.next();
  const hasOuterTransaction = transaction.getColumnValue(1) !== null;
  for (let i = 0; i < signals.length; i += batchSize) {
    const batch = signals.slice(i, i + batchSize);
    const articles = targetTable === 'STG_EXTERNAL_SIGNALS' && batch.some(row => articleSources.has(row && row.SOURCE_NAME));
    const ownsTransaction = articles && !hasOuterTransaction;
    if (ownsTransaction) snowflake.execute({sqlText:'BEGIN TRANSACTION'});
    try {
      let prepared = batch;
      if (articles) {
        const tracked = [];
        for (let index=0; index<batch.length; index++) {
          const row=batch[index];
          if (row && articleSources.has(row.SOURCE_NAME)) tracked.push(Object.assign({},row,{MERGE_INPUT_INDEX:index,MERGE_SESSION_ID:sessionId}));
        }
        const res = snowflake.execute({sqlText:'CALL MCC_RAW.MARKETING_DEV.RESOLVE_ARTICLE_SIGNALS(?)',
                                       binds:[JSON.stringify(tracked)]});
        res.next();
        const result = res.getColumnValue(1);
        const resolved = new Map(result.signals.map(row => [row.MERGE_INPUT_INDEX,row]));
        prepared = [];
        for (let index=0; index<batch.length; index++) {
          const row=batch[index];
          if (!row || !articleSources.has(row.SOURCE_NAME)) prepared.push(row);
          else if (resolved.has(index)) prepared.push(resolved.get(index));
        }
        for (const key of Object.keys(articleCounts)) articleCounts[key] += result.article_counts[key];
        Object.assign(signalIds, result.signal_ids);
      }
      if (prepared.length) snowflake.execute({sqlText:mergeSql, binds:[sessionId, JSON.stringify(prepared)]});
      if (ownsTransaction) snowflake.execute({sqlText:'COMMIT'});
    } catch (err) {
      if (ownsTransaction) snowflake.execute({sqlText:'ROLLBACK'});
      throw err;
    }
    totalProcessed += batch.length;
    batchCount += 1;
  }

  return {
    batches: batchCount,
    signals: totalProcessed,
    batch_size: batchSize,
    session_id: sessionId,
    target_table: targetTable,
    article_counts: articleCounts,
    signal_ids: signalIds,
  };
$$;
