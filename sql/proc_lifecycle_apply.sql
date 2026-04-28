-- Procedure: Atomic apply for lifecycle-agent decisions (v3 — ledger only).
-- Database: MCC_RAW.MARKETING_DEV
--
-- Called by the lifecycle subagent's commit_decision step. Each decision
-- gets exactly one row appended to FCT_TREND_LIFECYCLE_LEDGER. No FCT_TRENDS
-- updates, no narrative writes, no daily snapshot writes — those are all
-- derived now (V_TREND_LIFECYCLE_CURRENT handles "current state").
--
-- Two-cycle retire confirm: if decision.status='RETIRED', the proc reads
-- the prior ledger row's RETIREMENT_PROPOSAL. First proposal logs but keeps
-- status; second consecutive proposal commits status='RETIRED'.
--
-- WRITE_LIVE parameter is deprecated (kept for backwards-compat with the
-- subagent's payload). Every ledger insert is canonical now; for shadow
-- testing add an IS_SHADOW column in a future iteration.
--
-- Decision object shape (per subagent's run_subagent/entry.js decisions_json):
--   {
--     "trend_id":            "uuid",
--     "agent_session_id":    "lcy-sess-...",
--     "chain_id":            "lcy-chain-...",
--     "heat_base":           42.3,
--     "lifecycle_decision":  {
--       "status":               "GROWING|STABLE|DECLINING|DORMANT|RESURGENT|RETIRED|NEW",
--       "heat_modifier_pct":    -3.5,
--       "heat_modifier_reason": "...",
--       "retirement_reason":    null | "...",
--       "next_eval_in_hours":   6,
--       "request_re_enrichment": false,
--       "reasoning":            "..."
--     },
--     "llm_token_usage":      { "input": 1234, "output": 567 },
--     "llm_cost_estimate":     0.04,
--     "agent_telemetry":       { "model": "claude-sonnet-4-6", "stop_reason": "end_turn", ... }
--   }

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_LIFECYCLE_APPLY(
    DECISIONS  VARIANT,
    CHAIN_ID   VARCHAR,
    WRITE_LIVE BOOLEAN
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
from datetime import datetime

ALLOWED_STATUSES = {'NEW', 'GROWING', 'STABLE', 'DECLINING', 'DORMANT', 'RESURGENT', 'RETIRED'}


def sql_str(s):
    if s is None or s == '':
        return 'NULL'
    return "'" + str(s).replace("'", "''").replace("\\", "\\\\") + "'"


def sql_json(obj):
    if obj is None:
        return 'NULL'
    return "PARSE_JSON('" + json.dumps(obj).replace("'", "''").replace("\\", "\\\\") + "')"


def sql_num(n):
    if n is None or not isinstance(n, (int, float)):
        return 'NULL'
    return str(float(n))


def clamp(n, lo, hi):
    try:
        v = float(n)
    except (TypeError, ValueError):
        return None
    return max(lo, min(hi, v))


def get_prior_lifecycle_row(session, trend_id):
    rs = session.sql(f"""
        SELECT EVALUATED_AT, NEW_STATUS, NEW_HEAT, NEW_HEAT_SMOOTHED, RETIREMENT_PROPOSAL
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
        WHERE TREND_ID = {sql_str(trend_id)}
        ORDER BY EVALUATED_AT DESC
        LIMIT 1
    """).collect()
    if not rs:
        return None
    return {
        'evaluated_at':        rs[0][0],
        'new_status':          rs[0][1],
        'new_heat':            rs[0][2],
        'new_heat_smoothed':   rs[0][3],
        'retirement_proposal': rs[0][4],
    }


def append_ledger(session, row):
    """Append one row to FCT_TREND_LIFECYCLE_LEDGER. The next_eval_at_sql
    field is a raw SQL fragment (not a value) so we can compute DATEADD inline."""
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER (
            TREND_ID, AGENT_SESSION_ID, CHAIN_ID,
            PRIOR_STATUS, NEW_STATUS,
            PRIOR_HEAT, NEW_HEAT, NEW_HEAT_SMOOTHED,
            HEAT_BASE, HEAT_MODIFIER_PCT,
            DECISION_PAYLOAD, REASONING, REQUESTED_RE_ENRICHMENT,
            RETIREMENT_PROPOSAL, TOOL_CALLS_JSON,
            LLM_INPUT_TOKENS, LLM_OUTPUT_TOKENS, LLM_COST_ESTIMATE,
            MODEL_USED, STOP_REASON, NEXT_EVAL_AT
        )
        SELECT
            {sql_str(row['trend_id'])},
            {sql_str(row['agent_session_id'])},
            {sql_str(row['chain_id'])},
            {sql_str(row['prior_status'])},
            {sql_str(row['new_status'])},
            {sql_num(row['prior_heat'])},
            {sql_num(row['new_heat'])},
            {sql_num(row['new_heat_smoothed'])},
            {sql_num(row['heat_base'])},
            {sql_num(row['heat_modifier_pct'])},
            {sql_json(row['decision_payload'])},
            {sql_str((row.get('reasoning') or '')[:4000])},
            {('TRUE' if row.get('requested_re_enrichment') else 'FALSE')},
            {sql_json(row.get('retirement_proposal'))},
            {sql_json(row.get('tool_calls'))},
            {sql_num(row.get('llm_input_tokens'))},
            {sql_num(row.get('llm_output_tokens'))},
            {sql_num(row.get('llm_cost_estimate'))},
            {sql_str(row.get('model_used') or 'claude-sonnet-4-6')},
            {sql_str(row.get('stop_reason'))},
            {row['next_eval_at_sql']}
    """).collect()


def run(session, DECISIONS, CHAIN_ID, WRITE_LIVE):
    if DECISIONS is None:
        return {'applied_count': 0, 'results': []}
    if isinstance(DECISIONS, str):
        DECISIONS = json.loads(DECISIONS)
    if not isinstance(DECISIONS, list):
        return {'error': 'DECISIONS must be a JSON array'}

    chain_id = CHAIN_ID
    results = []

    for d in DECISIONS:
        trend_id = d.get('trend_id')
        decision = d.get('lifecycle_decision') or {}
        status   = (decision.get('status') or '').upper()

        if status not in ALLOWED_STATUSES:
            results.append({
                'trend_id': trend_id, 'status': 'rejected',
                'error': f'unknown status: {status}',
            })
            continue

        try:
            prior_lc = get_prior_lifecycle_row(session, trend_id)
            prior_status        = prior_lc['new_status']        if prior_lc else None
            prior_heat          = prior_lc['new_heat']          if prior_lc else None
            prior_heat_smoothed = prior_lc['new_heat_smoothed'] if prior_lc else None
            prior_proposal      = prior_lc['retirement_proposal'] if prior_lc else None

            # Heat computation: clamp modifier, compute final, smooth via EWMA
            heat_base = d.get('heat_base')
            modifier  = clamp(decision.get('heat_modifier_pct', 0), -20, 20) or 0
            new_heat  = None
            if heat_base is not None:
                new_heat = round(max(0, min(100, float(heat_base) * (1 + modifier / 100.0))), 1)

            new_heat_smoothed = None
            if new_heat is not None:
                ps = float(prior_heat_smoothed) if prior_heat_smoothed is not None else float(new_heat)
                new_heat_smoothed = round(0.7 * ps + 0.3 * float(new_heat), 1)

            # Two-cycle retire confirm
            retirement_proposal = None
            actually_apply_status = status
            if status == 'RETIRED':
                retirement_proposal = {
                    'reason': decision.get('retirement_reason'),
                    'reasoning': decision.get('reasoning'),
                    'proposed_at': datetime.utcnow().isoformat(),
                }
                if prior_proposal is None:
                    # First proposal — log only, don't flip status
                    actually_apply_status = prior_status or 'DORMANT'

            # NEXT_EVAL_AT: clamped [1, 168] hours from NOW; NULL for RETIRED
            next_hours = decision.get('next_eval_in_hours')
            try:
                next_clamped = max(1, min(168, int(float(next_hours)))) if next_hours else None
            except (TypeError, ValueError):
                next_clamped = None
            if actually_apply_status == 'RETIRED':
                next_eval_at_sql = 'NULL'
            elif next_clamped is not None:
                next_eval_at_sql = f"DATEADD(hour, {next_clamped}, CURRENT_TIMESTAMP())"
            else:
                next_eval_at_sql = 'NULL'

            append_ledger(session, {
                'trend_id':                trend_id,
                'agent_session_id':        d.get('agent_session_id'),
                'chain_id':                chain_id,
                'prior_status':            prior_status,
                'new_status':              actually_apply_status,
                'prior_heat':              prior_heat,
                'new_heat':                new_heat,
                'new_heat_smoothed':       new_heat_smoothed,
                'heat_base':               heat_base,
                'heat_modifier_pct':       modifier,
                'decision_payload':        decision,
                'reasoning':               decision.get('reasoning'),
                'requested_re_enrichment': bool(decision.get('request_re_enrichment')),
                'retirement_proposal':     retirement_proposal,
                'tool_calls':              None,
                'llm_input_tokens':        (d.get('llm_token_usage') or {}).get('input'),
                'llm_output_tokens':       (d.get('llm_token_usage') or {}).get('output'),
                'llm_cost_estimate':       d.get('llm_cost_estimate'),
                'model_used':              (d.get('agent_telemetry') or {}).get('model'),
                'stop_reason':             (d.get('agent_telemetry') or {}).get('stop_reason'),
                'next_eval_at_sql':        next_eval_at_sql,
            })

            results.append({
                'trend_id':              trend_id,
                'status':                'ok',
                'proposed_status':       status,
                'applied_status':        actually_apply_status,
                'new_heat':              new_heat,
                'retire_first_cycle':    (status == 'RETIRED' and actually_apply_status != 'RETIRED'),
                'request_re_enrichment': bool(decision.get('request_re_enrichment')),
            })

        except Exception as e:
            results.append({
                'trend_id': trend_id, 'status': 'error',
                'error': str(e)[:500],
            })

    return {
        'applied_count':    sum(1 for r in results if r['status'] == 'ok'),
        'error_count':      sum(1 for r in results if r['status'] == 'error'),
        'rejected_count':   sum(1 for r in results if r['status'] == 'rejected'),
        'retire_proposals': sum(1 for r in results if r.get('retire_first_cycle')),
        'retire_committed': sum(1 for r in results if r.get('applied_status') == 'RETIRED'),
        're_enrichment_requests': sum(1 for r in results if r.get('request_re_enrichment')),
        'results':          results,
    }
$$;
