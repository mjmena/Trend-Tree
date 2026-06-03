-- Procedure: Atomic apply for enrichment-agent output.
-- Database: MCC_RAW.MARKETING_DEV
--
-- Called by the enrichment write workflow (write-p_o7CWa2K) once the agent
-- run completes. Appends one row to FCT_TREND_ENRICHMENT_LEDGER. The row's
-- TREND_VECTOR is computed server-side via Cortex (EMBED_TEXT_1024 over
-- FN_TREND_EMBED_DOC) when no VECTOR arg is supplied — which is the normal
-- path, since the write workflow passes NULL. A passed-in VECTOR still wins
-- for back-compat. The same UDF is used by the one-time vector backfill, so
-- every trend vector shares one recipe (arctic-embed-l-v2.0/1024). On the
-- first enrichment run for a trend (KIND='initial'), also UPDATEs frozen
-- identity columns on FCT_TRENDS via two separately-guarded writes:
--
--   1. TREND_NAME — guarded by `TREND_NAME IS NULL`. Lets the 2026-05-27
--      active-trend re-enrichment sweep backfill TREND_NAME for legacy
--      trends that already have B2B/B2C populated. Once set, frozen.
--   2. Legacy identity (TREND_NAME_B2B / B2C / CATEGORY / SUBCATEGORY) —
--      guarded by `TREND_NAME_B2B IS NULL`. Preserves the pre-2026-05-27
--      freeze semantics; the singular-name agent stops emitting these
--      going forward, so the guard remains in place for back-compat only.
--
-- KIND values:
--   initial    — first full enrichment-agent run for this trend (sets identity)
--   refinement — lifecycle-triggered light re-enrichment (narrative only)
--   promotion_seed — written by promotion at trend creation (topic vector only)
--
-- Returns a VARIANT summary { applied, kind, trend_id, trend_name_set,
-- legacy_identity_set }.

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_ENRICHMENT_APPLY(
    TREND_ID         VARCHAR,
    PAYLOAD          VARIANT,
    VECTOR           ARRAY,
    SESSION_ID       VARCHAR,
    CHAIN_ID         VARCHAR,
    KIND             VARCHAR,
    MODEL_USED       VARCHAR,
    INPUT_TOKENS     NUMBER,
    OUTPUT_TOKENS    NUMBER,
    COST_USD         FLOAT
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

ALLOWED_KINDS = {'initial', 'refinement', 'promotion_seed'}


def sql_str(s):
    if s is None or s == '':
        return 'NULL'
    return "'" + str(s).replace("'", "''").replace("\\", "\\\\") + "'"


def sql_json(obj):
    if obj is None:
        return 'NULL'
    if isinstance(obj, str):
        # Already serialized
        return "PARSE_JSON('" + obj.replace("'", "''").replace("\\", "\\\\") + "')"
    return "PARSE_JSON('" + json.dumps(obj).replace("'", "''").replace("\\", "\\\\") + "')"


def vector_sql(vec, topic, payload_dict):
    """Resolve the TREND_VECTOR SQL expression.

    Precedence:
      1. An explicitly-passed vector arg (back-compat) -> VECTOR literal.
      2. Otherwise compute the embedding server-side via Cortex from the
         canonical trend doc (FN_TREND_EMBED_DOC) so the vector no longer
         depends on a value supplied by the write workflow. Recipe lives in
         the UDF; same call is used by the one-time backfill, so go-forward
         and historical vectors share one recipe (arctic-embed-l-v2.0/1024).
    """
    if vec is not None:
        if isinstance(vec, str):
            try:
                vec = json.loads(vec)
            except (ValueError, TypeError):
                vec = None
        if vec:
            floats = [str(float(x)) for x in vec]
            return "[" + ",".join(floats) + "]::VECTOR(FLOAT, 1024)"
    if not topic and not payload_dict:
        return 'NULL'
    return ("SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', "
            f"MCC_RAW.MARKETING_DEV.FN_TREND_EMBED_DOC({sql_str(topic)}, {sql_json(payload_dict)}))")


def sql_num(n):
    if n is None:
        return 'NULL'
    try:
        return str(float(n) if isinstance(n, float) else int(n))
    except (TypeError, ValueError):
        return 'NULL'


def run(session, TREND_ID, PAYLOAD, VECTOR, SESSION_ID, CHAIN_ID, KIND,
        MODEL_USED, INPUT_TOKENS, OUTPUT_TOKENS, COST_USD):
    if not TREND_ID:
        return {'applied': False, 'error': 'TREND_ID required'}

    kind = (KIND or 'initial').lower()
    if kind not in ALLOWED_KINDS:
        return {'applied': False, 'error': f'unknown kind: {kind}'}

    payload_dict = PAYLOAD if isinstance(PAYLOAD, dict) else (json.loads(PAYLOAD) if isinstance(PAYLOAD, str) else {})

    # Frozen trend topic — anchors the embedding doc when VECTOR isn't passed.
    topic = None
    try:
        rs = session.sql(
            f"SELECT TREND_TOPIC FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS "
            f"WHERE TREND_ID = {sql_str(TREND_ID)}"
        ).collect()
        if rs:
            topic = rs[0][0]
    except Exception:
        topic = None

    # 1. Append ledger row (always)
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER (
            TREND_ID, WRITTEN_AT, WRITTEN_BY, ENRICHMENT_KIND,
            AGENT_SESSION_ID, CHAIN_ID,
            PAYLOAD, TREND_VECTOR,
            MODEL_USED, LLM_INPUT_TOKENS, LLM_OUTPUT_TOKENS, LLM_COST_ESTIMATE
        )
        SELECT
            {sql_str(TREND_ID)},
            CURRENT_TIMESTAMP(),
            CASE {sql_str(kind)}
                WHEN 'promotion_seed' THEN 'promotion'
                WHEN 'refinement'     THEN 'lifecycle_request'
                ELSE                       'enrichment'
            END,
            {sql_str(kind)},
            {sql_str(SESSION_ID)},
            {sql_str(CHAIN_ID)},
            {sql_json(payload_dict)},
            {vector_sql(VECTOR, topic, payload_dict)},
            {sql_str(MODEL_USED)},
            {sql_num(INPUT_TOKENS)},
            {sql_num(OUTPUT_TOKENS)},
            {sql_num(COST_USD)}
    """).collect()

    # 2. First-run identity writes to FCT_TRENDS (kind='initial' only).
    # Split into two guarded UPDATEs so TREND_NAME can be backfilled for
    # legacy trends that already have B2B/B2C populated, without disturbing
    # the legacy identity freeze.
    trend_name_set = False
    legacy_identity_set = False
    if kind == 'initial':
        trend_name = payload_dict.get('trend_name')
        b2b = payload_dict.get('trend_name_b2b')
        b2c = payload_dict.get('trend_name_b2c')
        category = payload_dict.get('category')
        subcategory = payload_dict.get('subcategory')

        # 2a. Singular TREND_NAME — guarded by TREND_NAME IS NULL.
        if trend_name:
            rs = session.sql(f"""
                UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                SET TREND_NAME     = {sql_str(trend_name)},
                    LAST_UPDATE_AT = CURRENT_TIMESTAMP()
                WHERE TREND_ID = {sql_str(TREND_ID)}
                  AND TREND_NAME IS NULL
            """).collect()
            trend_name_set = bool(rs and len(rs) > 0 and int(rs[0][0]) > 0)

        # 2b. Legacy B2B/B2C/CATEGORY/SUBCATEGORY — guarded by
        # TREND_NAME_B2B IS NULL. New singular-name agent stops emitting
        # B2B/B2C, so this block usually no-ops going forward; preserved
        # for back-compat with any in-flight callers + the legacy proc
        # signature.
        if b2b or b2c:
            rs = session.sql(f"""
                UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                SET TREND_NAME_B2B = {sql_str(b2b)},
                    TREND_NAME_B2C = {sql_str(b2c)},
                    CATEGORY       = {sql_str(category)},
                    SUBCATEGORY    = {sql_str(subcategory)},
                    LAST_UPDATE_AT = CURRENT_TIMESTAMP()
                WHERE TREND_ID = {sql_str(TREND_ID)}
                  AND TREND_NAME_B2B IS NULL
            """).collect()
            legacy_identity_set = bool(rs and len(rs) > 0 and int(rs[0][0]) > 0)
        elif category or subcategory:
            # Singular-name path: agent emits category/subcategory but no
            # B2B/B2C. Write taxonomy under the same legacy guard so the
            # first enrichment seeds it on the trend identity row.
            rs = session.sql(f"""
                UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                SET CATEGORY       = {sql_str(category)},
                    SUBCATEGORY    = {sql_str(subcategory)},
                    LAST_UPDATE_AT = CURRENT_TIMESTAMP()
                WHERE TREND_ID = {sql_str(TREND_ID)}
                  AND TREND_NAME_B2B IS NULL
                  AND CATEGORY IS NULL
            """).collect()
            legacy_identity_set = bool(rs and len(rs) > 0 and int(rs[0][0]) > 0)

    return {
        'applied':             True,
        'trend_id':            TREND_ID,
        'kind':                kind,
        'trend_name_set':      trend_name_set,
        'legacy_identity_set': legacy_identity_set,
    }
$$;
