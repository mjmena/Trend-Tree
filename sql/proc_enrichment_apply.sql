-- Procedure: Atomic apply for enrichment-agent output.
-- Database: MCC_RAW.MARKETING_DEV
--
-- Called by the enrichment write workflow (write-p_o7CWa2K) once the agent
-- run completes. Appends one row to FCT_TREND_ENRICHMENT_LEDGER. On the
-- first enrichment run for a trend (KIND='initial'), also UPDATEs the
-- frozen identity columns on FCT_TRENDS (TREND_NAME_B2B/B2C, CATEGORY,
-- SUBCATEGORY) — guarded by `TREND_NAME_B2B IS NULL` so re-enrichments
-- never overwrite them.
--
-- KIND values:
--   initial    — first full enrichment-agent run for this trend (sets identity)
--   refinement — lifecycle-triggered light re-enrichment (narrative only)
--   promotion_seed — written by promotion at trend creation (topic vector only)
--
-- Returns a VARIANT summary { applied, kind, trend_id, identity_set }.

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


def sql_vector(vec):
    """1024-dim float vector as a Snowflake VECTOR literal."""
    if vec is None:
        return 'NULL'
    if isinstance(vec, str):
        vec = json.loads(vec)
    if not vec:
        return 'NULL'
    floats = [str(float(x)) for x in vec]
    return "[" + ",".join(floats) + "]::VECTOR(FLOAT, 1024)"


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
            {sql_vector(VECTOR)},
            {sql_str(MODEL_USED)},
            {sql_num(INPUT_TOKENS)},
            {sql_num(OUTPUT_TOKENS)},
            {sql_num(COST_USD)}
    """).collect()

    # 2. First-run identity write to FCT_TRENDS (kind='initial' only, guarded)
    identity_set = False
    if kind == 'initial':
        b2b = payload_dict.get('trend_name_b2b')
        b2c = payload_dict.get('trend_name_b2c')
        category = payload_dict.get('category')
        subcategory = payload_dict.get('subcategory')

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
            # `rs[0][0]` is rows-updated; 1 if first-run, 0 if already set
            identity_set = bool(rs and len(rs) > 0 and int(rs[0][0]) > 0)

    return {
        'applied':      True,
        'trend_id':     TREND_ID,
        'kind':         kind,
        'identity_set': identity_set,
    }
$$;
