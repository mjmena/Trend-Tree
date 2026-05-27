-- Procedure: Atomic append for prediction-agent decisions.
-- Database: MCC_RAW.MARKETING_DEV
--
-- Called by the prediction agent's commit_to_ledger step. Each row in the
-- DECISIONS array gets exactly one INSERT into FCT_TREND_PREDICTION_LEDGER.
-- No EWMA, no two-cycle confirm — just append.
--
-- Decision object shape (one per scored trend; PREDICTION_FLAG / SCORE may
-- be NULL when the trend is too young for WoW math):
--   {
--     "trend_id":               "uuid",
--     "prediction_score":       45.0   | null,
--     "prediction_flag":        "Emerging" | "Watchlist" | "High Potential" | null,
--     "prediction_eligible":    true | false,
--     "input_heat_now":         41.9 | null,
--     "input_heat_7d":          38.2 | null,
--     "input_heat_14d":         35.5 | null,
--     "input_acceleration":     1.2 | null,
--     "input_inverse_heat":     58.1 | null,
--     "input_sources_last_7d":  12,
--     "input_sources_prior_7d": 8,
--     "input_source_delta":     4,
--     "input_signals_last_7d":  35,
--     "input_signals_prior_7d": 22,
--     "input_signal_delta":     13,
--     "input_score_percentile": 0.65 | null,
--     "days_since_promotion":   21
--   }

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_PREDICTION_APPLY(
    DECISIONS  VARIANT,
    CHAIN_ID   VARCHAR
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

ALLOWED_FLAGS = {'Emerging', 'Watchlist', 'High Potential'}


def sql_str(s):
    if s is None or s == '':
        return 'NULL'
    return "'" + str(s).replace("'", "''").replace("\\", "\\\\") + "'"


def sql_num(n):
    if n is None:
        return 'NULL'
    try:
        return str(float(n))
    except (TypeError, ValueError):
        return 'NULL'


def sql_int(n):
    if n is None:
        return 'NULL'
    try:
        return str(int(n))
    except (TypeError, ValueError):
        return 'NULL'


def sql_bool(b):
    return 'TRUE' if bool(b) else 'FALSE'


def sql_flag(flag):
    if flag is None or flag == '':
        return 'NULL'
    if flag not in ALLOWED_FLAGS:
        return 'NULL'
    return sql_str(flag)


def append_ledger(session, row, chain_id):
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_PREDICTION_LEDGER (
            TREND_ID, CHAIN_ID,
            PREDICTION_SCORE, PREDICTION_FLAG, PREDICTION_ELIGIBLE,
            INPUT_HEAT_NOW, INPUT_HEAT_7D, INPUT_HEAT_14D,
            INPUT_ACCELERATION, INPUT_INVERSE_HEAT,
            INPUT_SOURCES_LAST_7D, INPUT_SOURCES_PRIOR_7D, INPUT_SOURCE_DELTA,
            INPUT_SIGNALS_LAST_7D, INPUT_SIGNALS_PRIOR_7D, INPUT_SIGNAL_DELTA,
            INPUT_SCORE_PERCENTILE, DAYS_SINCE_PROMOTION
        )
        SELECT
            {sql_str(row.get('trend_id'))},
            {sql_str(chain_id)},
            {sql_num(row.get('prediction_score'))},
            {sql_flag(row.get('prediction_flag'))},
            {sql_bool(row.get('prediction_eligible'))},
            {sql_num(row.get('input_heat_now'))},
            {sql_num(row.get('input_heat_7d'))},
            {sql_num(row.get('input_heat_14d'))},
            {sql_num(row.get('input_acceleration'))},
            {sql_num(row.get('input_inverse_heat'))},
            {sql_int(row.get('input_sources_last_7d'))},
            {sql_int(row.get('input_sources_prior_7d'))},
            {sql_num(row.get('input_source_delta'))},
            {sql_int(row.get('input_signals_last_7d'))},
            {sql_int(row.get('input_signals_prior_7d'))},
            {sql_num(row.get('input_signal_delta'))},
            {sql_num(row.get('input_score_percentile'))},
            {sql_int(row.get('days_since_promotion'))}
    """).collect()


def run(session, DECISIONS, CHAIN_ID):
    if DECISIONS is None:
        return {'applied_count': 0, 'results': []}
    if isinstance(DECISIONS, str):
        DECISIONS = json.loads(DECISIONS)
    if not isinstance(DECISIONS, list):
        return {'error': 'DECISIONS must be a JSON array'}

    applied = 0
    errors = []

    for d in DECISIONS:
        trend_id = d.get('trend_id')
        if not trend_id:
            errors.append({'trend_id': None, 'error': 'missing trend_id'})
            continue
        try:
            append_ledger(session, d, CHAIN_ID)
            applied += 1
        except Exception as e:
            errors.append({'trend_id': trend_id, 'error': str(e)[:500]})

    eligible_count = sum(1 for d in DECISIONS if d.get('prediction_eligible'))
    scored_count   = sum(1 for d in DECISIONS if d.get('prediction_score') is not None)

    return {
        'applied_count':  applied,
        'error_count':    len(errors),
        'eligible_count': eligible_count,
        'scored_count':   scored_count,
        'null_count':     len(DECISIONS) - scored_count,
        'errors':         errors[:20],
    }
$$;
