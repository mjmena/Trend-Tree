-- Procedure: Vector-similarity neighbor lookup against FCT_TRENDS.
-- Database: MCC_RAW.MARKETING_DEV (calls); reads MCC_PRESENTATION.TREND_AGENT
--
-- Generally-callable tool. Given a probe (trend_id, candidate_id, raw text,
-- or precomputed vector), returns up to MAX_N FCT_TRENDS rows with cosine
-- similarity >= THRESHOLD against the probe's 1024-dim vector. Used by the
-- promotion workflow's neighbor pool step and any future agent that needs
-- to narrow the field to "trends similar to X" without scanning every row.
--
-- Probe shapes (one of):
--   {"trend_id":     "<uuid>"}     -- looks up FCT_TRENDS.TREND_VECTOR; excludes itself from results
--   {"candidate_id": "<uuid>"}     -- embeds (topic | reasoning | top 3 signal titles)
--   {"text":         "<string>"}   -- embeds raw text via Cortex
--   {"vector":       [1024 floats]} -- caller already embedded
--
-- Returns: VARIANT array of objects:
--   trend_id, trend_topic, similarity, last_update_at, total_cluster_size,
--   distinct_source_count, detected_at, age_days, trend_heat_index,
--   velocity_direction, summary_short, category
--
-- Usage:
--   CALL MCC_RAW.MARKETING_DEV.PROC_TREND_NEIGHBORS(
--     PARSE_JSON('{"trend_id": "abc..."}'), 0.50, 8
--   );

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_TREND_NEIGHBORS(
    PROBE      VARIANT,
    THRESHOLD  FLOAT  DEFAULT 0.50,
    MAX_N      NUMBER DEFAULT 8
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import json
import datetime


def sql_str(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''").replace("\\", "\\\\") + "'"


def sql_vector_literal(vec):
    if vec is None:
        return 'NULL'
    if isinstance(vec, str):
        vec = json.loads(vec)
    floats = [str(float(x)) for x in vec]
    return "[" + ",".join(floats) + "]::VECTOR(FLOAT, 1024)"


def to_json_safe(v):
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    return v


def resolve_probe(probe):
    """Return (vector_sql_expression, exclude_trend_id_or_None).

    The expression evaluates inside Snowflake to a VECTOR(FLOAT, 1024). The
    optional exclude_trend_id is filtered out of the neighbor results when
    the probe was a trend_id (so a trend isn't its own neighbor).
    """
    if not isinstance(probe, dict):
        raise ValueError('PROBE must be a JSON object')

    if probe.get('vector') is not None:
        return (sql_vector_literal(probe['vector']), None)

    if probe.get('trend_id'):
        tid = probe['trend_id']
        return (
            f"(SELECT TREND_VECTOR FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS "
            f"WHERE TREND_ID = {sql_str(tid)})",
            tid,
        )

    if probe.get('text'):
        return (
            f"SNOWFLAKE.CORTEX.EMBED_TEXT_1024("
            f"'snowflake-arctic-embed-l-v2.0', {sql_str(probe['text'])})",
            None,
        )

    if probe.get('candidate_id'):
        cid = probe['candidate_id']
        # Mirrors the embedding text the promotion workflow constructs inline:
        # topic | reasoning(800 chars) | top 3 signal titles by INGESTED_AT desc.
        return (
            f"""(
              WITH top_titles AS (
                SELECT s.SIGNAL_TITLE
                FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
                     LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
                JOIN MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
                  ON s.SIGNAL_ID = f.value::STRING
                WHERE c.CANDIDATE_ID = {sql_str(cid)}
                  AND s.SIGNAL_TITLE IS NOT NULL
                QUALIFY ROW_NUMBER() OVER (ORDER BY s.INGESTED_AT DESC) <= 3
              ),
              embed_text AS (
                SELECT
                  COALESCE(c.TOPIC, '') || ' | ' ||
                  COALESCE(LEFT(c.REASONING, 800), '') || ' | ' ||
                  COALESCE((SELECT LISTAGG(SIGNAL_TITLE, ', ') FROM top_titles), '') AS T
                FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
                WHERE c.CANDIDATE_ID = {sql_str(cid)}
              )
              SELECT SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
                'snowflake-arctic-embed-l-v2.0', T
              ) FROM embed_text
            )""",
            None,
        )

    raise ValueError(
        'PROBE must include one of: trend_id, candidate_id, text, vector'
    )


def run(session, PROBE, THRESHOLD, MAX_N):
    if PROBE is None:
        return {'error': 'PROBE is required'}
    if isinstance(PROBE, str):
        PROBE = json.loads(PROBE)

    threshold = float(THRESHOLD if THRESHOLD is not None else 0.50)
    max_n     = int(MAX_N if MAX_N is not None else 8)

    try:
        vec_expr, exclude_tid = resolve_probe(PROBE)
    except ValueError as e:
        return {'error': str(e)}

    exclude_clause = (
        f"AND t.TREND_ID != {sql_str(exclude_tid)}" if exclude_tid else ""
    )

    rs = session.sql(f"""
        WITH probe AS (SELECT {vec_expr} AS V)
        SELECT
            t.TREND_ID,
            t.TREND_TOPIC,
            ROUND(VECTOR_COSINE_SIMILARITY(probe.V, t.TREND_VECTOR), 4) AS SIMILARITY,
            t.LAST_UPDATE_AT,
            t.TOTAL_CLUSTER_SIZE,
            t.DISTINCT_SOURCE_COUNT,
            t.DETECTED_AT,
            DATEDIFF(day, t.DETECTED_AT, CURRENT_TIMESTAMP()) AS AGE_DAYS,
            t.TREND_HEAT_INDEX,
            t.VELOCITY_DIRECTION,
            e.SUMMARY_SHORT,
            e.CATEGORY
        FROM probe, MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
        LEFT JOIN MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT e
          ON t.TREND_ID = e.TREND_ID
        WHERE t.TREND_VECTOR IS NOT NULL
          AND VECTOR_COSINE_SIMILARITY(probe.V, t.TREND_VECTOR) >= {threshold}
          {exclude_clause}
        ORDER BY SIMILARITY DESC
        LIMIT {max_n}
    """).collect()

    return [
        {k.lower(): to_json_safe(v) for k, v in r.asDict().items()}
        for r in rs
    ]
$$;
