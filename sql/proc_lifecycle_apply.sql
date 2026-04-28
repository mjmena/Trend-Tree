-- Procedure: Atomic apply for lifecycle-agent decisions.
-- Database: MCC_RAW.MARKETING_DEV
--
-- Called once per lifecycle sweeper iteration by the Pipedream workflow
-- `lifecycle-agent-p_JZCz73w`. Takes a single VARIANT array of decisions,
-- applies each in its own BEGIN/COMMIT (a bad apple doesn't fail the
-- batch), returns a summary.
--
-- Decision object shape (what the subagent emits, augmented by sweeper):
--   {
--     "trend_id":            "uuid",
--     "agent_session_id":    "lcy-sess-...",
--     "chain_id":            "lcy-chain-...",
--     "heat_base":           42.3,
--     "lifecycle_decision":  {
--       "status":              "GROWING|STABLE|DECLINING|DORMANT|RESURGENT|RETIRED|NEW",
--       "heat_modifier_pct":   -3.5,
--       "heat_modifier_reason":"...",
--       "description_update":  null | {summary_short, summary_long, vibe_shift, social_narrative, change_reason},
--       "retirement_reason":   null | "...",
--       "next_eval_in_hours":  6,
--       "request_re_enrichment": false,
--       "reasoning":           "..."
--     },
--     "tokens":              {"input": 1234, "output": 567},
--     "cost_usd":             0.04,
--     "stop_reason":          "end_turn",
--     "turns":                4,
--     "tool_call_count":      3,
--     "model":                "claude-sonnet-4-6"
--   }
--
-- Two-cycle retire confirm:
--   If decision.status == 'RETIRED', the proc reads the most recent prior
--   FCT_TREND_LIFECYCLE_HISTORY row for this trend. If that row's
--   RETIREMENT_PROPOSAL is non-null, the proc applies the retirement.
--   Otherwise it logs the proposal (RETIREMENT_PROPOSAL set on the new
--   history row) but keeps LIFECYCLE_STATUS unchanged.
--
-- write_live gate (set on the proc call by the sweeper):
--   When write_live=FALSE the proc still writes FCT_TREND_LIFECYCLE_HISTORY
--   and DIM_TREND_NARRATIVE_HISTORY (audit trail), but does NOT update
--   FCT_TRENDS or DIM_TREND_ENRICHMENT (shadow mode).

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

ALLOWED_STATUSES = {'NEW', 'GROWING', 'STABLE', 'DECLINING', 'DORMANT', 'RESURGENT', 'RETIRED'}


def sql_str(s):
    if s is None:
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
        SELECT EVALUATED_AT, NEW_STATUS, RETIREMENT_PROPOSAL
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_HISTORY
        WHERE TREND_ID = {sql_str(trend_id)}
        ORDER BY EVALUATED_AT DESC
        LIMIT 1
    """).collect()
    if not rs:
        return None
    return {
        'evaluated_at': rs[0][0],
        'new_status': rs[0][1],
        'retirement_proposal': rs[0][2],
    }


def get_current_trend_row(session, trend_id):
    rs = session.sql(f"""
        SELECT LIFECYCLE_STATUS,
               COALESCE(TREND_HEAT_INDEX, 0)          AS HEAT,
               COALESCE(TREND_HEAT_INDEX_SMOOTHED, TREND_HEAT_INDEX, 0) AS HEAT_SMOOTHED
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
        WHERE TREND_ID = {sql_str(trend_id)}
    """).collect()
    if not rs:
        return None
    return {'status': rs[0][0], 'heat': rs[0][1], 'heat_smoothed': rs[0][2]}


def insert_history(session, audit):
    """Always-insert history row regardless of write_live."""
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_HISTORY
            (TREND_ID, AGENT_SESSION_ID, CHAIN_ID,
             PRIOR_STATUS, NEW_STATUS, PRIOR_HEAT, NEW_HEAT,
             HEAT_BASE, HEAT_MODIFIER_PCT,
             DECISION_PAYLOAD, REASONING, REQUESTED_RE_ENRICHMENT,
             RETIREMENT_PROPOSAL, TOOL_CALLS_JSON,
             LLM_INPUT_TOKENS, LLM_OUTPUT_TOKENS, LLM_COST_ESTIMATE,
             MODEL_USED, STOP_REASON)
        SELECT {sql_str(audit['trend_id'])},
               {sql_str(audit['agent_session_id'])},
               {sql_str(audit['chain_id'])},
               {sql_str(audit['prior_status'])},
               {sql_str(audit['new_status'])},
               {sql_num(audit['prior_heat'])},
               {sql_num(audit['new_heat'])},
               {sql_num(audit['heat_base'])},
               {sql_num(audit['heat_modifier_pct'])},
               {sql_json(audit['decision_payload'])},
               {sql_str((audit.get('reasoning') or '')[:4000])},
               {('TRUE' if audit.get('requested_re_enrichment') else 'FALSE')},
               {sql_json(audit.get('retirement_proposal'))},
               {sql_json(audit.get('tool_calls'))},
               {audit['llm_input_tokens'] if audit.get('llm_input_tokens') is not None else 'NULL'},
               {audit['llm_output_tokens'] if audit.get('llm_output_tokens') is not None else 'NULL'},
               {sql_num(audit.get('llm_cost_estimate'))},
               {sql_str(audit.get('model_used') or 'claude-sonnet-4-6')},
               {sql_str(audit.get('stop_reason'))}
    """).collect()


def update_trend(session, trend_id, new_status, new_heat, new_heat_smoothed, next_eval_hours, retirement_reason):
    """Apply status + heat + scheduling to FCT_TRENDS. Caller decides whether to invoke."""
    nh = clamp(new_heat, 0, 100)
    nhs = clamp(new_heat_smoothed, 0, 100)
    next_clamped = clamp(next_eval_hours, 1, 168)
    next_clause = (
        f"DATEADD(hour, {int(next_clamped)}, CURRENT_TIMESTAMP())"
        if next_clamped is not None else "NULL"
    )
    if new_status == 'RETIRED':
        next_clause = "NULL"
    session.sql(f"""
        UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
        SET LIFECYCLE_STATUS         = {sql_str(new_status)},
            TREND_HEAT_INDEX         = {sql_num(nh)},
            TREND_HEAT_INDEX_SMOOTHED = {sql_num(nhs)},
            LAST_LIFECYCLE_EVAL_AT   = CURRENT_TIMESTAMP(),
            NEXT_LIFECYCLE_EVAL_AT   = {next_clause},
            RETIREMENT_REASON        = {sql_str((retirement_reason or '')[:500]) if retirement_reason else 'NULL'},
            LAST_UPDATE_AT           = CURRENT_TIMESTAMP()
        WHERE TREND_ID = {sql_str(trend_id)}
    """).collect()


def append_narrative(session, trend_id, agent_session_id, desc):
    """Append DIM_TREND_NARRATIVE_HISTORY row + overwrite DIM_TREND_ENRICHMENT."""
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.DIM_TREND_NARRATIVE_HISTORY
            (TREND_ID, NARRATIVE_VERSION, WRITTEN_BY, AGENT_SESSION_ID,
             SUMMARY_SHORT, SUMMARY_LONG, VIBE_SHIFT, SOCIAL_NARRATIVE,
             CULTURAL_DRIVERS, CHANGE_REASON)
        SELECT {sql_str(trend_id)},
               COALESCE(MAX(NARRATIVE_VERSION), 0) + 1,
               'lifecycle',
               {sql_str(agent_session_id)},
               {sql_str(desc.get('summary_short'))},
               {sql_str(desc.get('summary_long'))},
               {sql_str(desc.get('vibe_shift'))},
               {sql_json(desc.get('social_narrative'))},
               {sql_json(desc.get('cultural_drivers'))},
               {sql_str((desc.get('change_reason') or '')[:500])}
        FROM MCC_PRESENTATION.TREND_AGENT.DIM_TREND_NARRATIVE_HISTORY
        WHERE TREND_ID = {sql_str(trend_id)}
    """).collect()
    session.sql(f"""
        UPDATE MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
        SET SUMMARY_SHORT     = COALESCE({sql_str(desc.get('summary_short'))}, SUMMARY_SHORT),
            SUMMARY_LONG      = COALESCE({sql_str(desc.get('summary_long'))}, SUMMARY_LONG),
            VIBE_SHIFT        = COALESCE({sql_str(desc.get('vibe_shift'))}, VIBE_SHIFT),
            SOCIAL_NARRATIVE  = COALESCE({sql_json(desc.get('social_narrative'))}, SOCIAL_NARRATIVE),
            CULTURAL_DRIVERS  = COALESCE({sql_json(desc.get('cultural_drivers'))}, CULTURAL_DRIVERS),
            ENRICHED_AT       = CURRENT_TIMESTAMP(),
            ENRICHMENT_VERSION = COALESCE(ENRICHMENT_VERSION, 0) + 1
        WHERE TREND_ID = {sql_str(trend_id)}
    """).collect()


def write_daily_snapshot(session, trend_id, status, heat, source_count, cluster_size):
    """Append a daily-snapshot row. Idempotent via PK if it exists."""
    session.sql(f"""
        MERGE INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS target
        USING (
            SELECT {sql_str(trend_id)}::VARCHAR              AS TREND_ID,
                   CURRENT_DATE()::DATE                      AS SNAPSHOT_DATE,
                   {sql_str(status)}::VARCHAR                AS LIFECYCLE_STATUS,
                   {sql_num(heat)}::FLOAT                    AS HEAT_INDEX,
                   {int(source_count) if source_count is not None else 'NULL'}::NUMBER AS SOURCE_COUNT,
                   {int(cluster_size) if cluster_size is not None else 'NULL'}::NUMBER AS CLUSTER_SIZE
        ) source
        ON target.TREND_ID = source.TREND_ID AND target.SNAPSHOT_DATE = source.SNAPSHOT_DATE
        WHEN MATCHED THEN UPDATE SET
            LIFECYCLE_STATUS = source.LIFECYCLE_STATUS,
            HEAT_INDEX       = source.HEAT_INDEX,
            SOURCE_COUNT     = source.SOURCE_COUNT,
            CLUSTER_SIZE     = source.CLUSTER_SIZE
        WHEN NOT MATCHED THEN INSERT (TREND_ID, SNAPSHOT_DATE, LIFECYCLE_STATUS, HEAT_INDEX, SOURCE_COUNT, CLUSTER_SIZE)
            VALUES (source.TREND_ID, source.SNAPSHOT_DATE, source.LIFECYCLE_STATUS, source.HEAT_INDEX, source.SOURCE_COUNT, source.CLUSTER_SIZE)
    """).collect()


def get_trend_aggregates(session, trend_id):
    rs = session.sql(f"""
        SELECT TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
        WHERE TREND_ID = {sql_str(trend_id)}
    """).collect()
    if not rs:
        return (None, None)
    return (rs[0][0], rs[0][1])


def run(session, DECISIONS, CHAIN_ID, WRITE_LIVE):
    if DECISIONS is None:
        return {'applied_count': 0, 'results': []}
    if isinstance(DECISIONS, str):
        DECISIONS = json.loads(DECISIONS)
    if not isinstance(DECISIONS, list):
        return {'error': 'DECISIONS must be a JSON array', 'got': str(type(DECISIONS))}

    chain_id = CHAIN_ID
    write_live = bool(WRITE_LIVE)
    results = []

    for d in DECISIONS:
        trend_id = d.get('trend_id')
        decision = d.get('lifecycle_decision') or {}
        status = (decision.get('status') or '').upper()

        if status not in ALLOWED_STATUSES:
            results.append({
                'trend_id': trend_id,
                'status': 'rejected',
                'error': f'unknown status: {status}',
            })
            continue

        try:
            session.sql("BEGIN").collect()

            current = get_current_trend_row(session, trend_id) or {'status': None, 'heat': None, 'heat_smoothed': None}
            prior_lc = get_prior_lifecycle_row(session, trend_id)

            heat_base = d.get('heat_base')
            modifier = clamp(decision.get('heat_modifier_pct', 0), -20, 20) or 0
            new_heat = None
            if heat_base is not None:
                new_heat = max(0, min(100, float(heat_base) * (1 + modifier / 100.0)))
                new_heat = round(new_heat, 1)

            new_heat_smoothed = None
            if new_heat is not None:
                prior_smoothed = current.get('heat_smoothed') or 0
                new_heat_smoothed = round(0.7 * float(prior_smoothed) + 0.3 * float(new_heat), 1)

            # Two-cycle retire confirm
            retirement_proposal = None
            actually_apply_status = status
            if status == 'RETIRED':
                retirement_proposal = {
                    'reason': decision.get('retirement_reason'),
                    'reasoning': decision.get('reasoning'),
                    'proposed_at': str(__import__('datetime').datetime.utcnow().isoformat()),
                }
                prior_proposal = prior_lc.get('retirement_proposal') if prior_lc else None
                if prior_proposal is None:
                    # First retire proposal — log only, don't flip status
                    actually_apply_status = current.get('status') or 'DORMANT'
                else:
                    # Second consecutive retire proposal — commit
                    actually_apply_status = 'RETIRED'

            # Always insert history row
            insert_history(session, {
                'trend_id': trend_id,
                'agent_session_id': d.get('agent_session_id'),
                'chain_id': chain_id,
                'prior_status': current.get('status'),
                'new_status': actually_apply_status if write_live else status,
                'prior_heat': current.get('heat'),
                'new_heat': new_heat,
                'heat_base': heat_base,
                'heat_modifier_pct': modifier,
                'decision_payload': decision,
                'reasoning': decision.get('reasoning'),
                'requested_re_enrichment': bool(decision.get('request_re_enrichment')),
                'retirement_proposal': retirement_proposal,
                'tool_calls': None,
                'llm_input_tokens': (d.get('llm_token_usage') or {}).get('input'),
                'llm_output_tokens': (d.get('llm_token_usage') or {}).get('output'),
                'llm_cost_estimate': d.get('llm_cost_estimate'),
                'model_used': (d.get('agent_telemetry') or {}).get('model'),
                'stop_reason': (d.get('agent_telemetry') or {}).get('stop_reason'),
            })

            committed_actions = []
            if write_live:
                # Description update first (history before overwrite)
                desc = decision.get('description_update')
                if desc:
                    append_narrative(session, trend_id, d.get('agent_session_id'), desc)
                    committed_actions.append('narrative_updated')

                # Status + heat + scheduling
                update_trend(
                    session, trend_id, actually_apply_status,
                    new_heat, new_heat_smoothed,
                    decision.get('next_eval_in_hours'),
                    decision.get('retirement_reason') if actually_apply_status == 'RETIRED' else None,
                )
                committed_actions.append('trend_updated')

                # Daily snapshot
                cluster_size, source_count = get_trend_aggregates(session, trend_id)
                write_daily_snapshot(session, trend_id, actually_apply_status, new_heat, source_count, cluster_size)
                committed_actions.append('snapshot_written')

            session.sql("COMMIT").collect()

            results.append({
                'trend_id': trend_id,
                'status': 'ok',
                'proposed_status': status,
                'applied_status': actually_apply_status if write_live else None,
                'new_heat': new_heat,
                'retire_first_cycle': (status == 'RETIRED' and actually_apply_status != 'RETIRED'),
                'committed_actions': committed_actions,
            })

        except Exception as e:
            try:
                session.sql("ROLLBACK").collect()
            except Exception:
                pass
            results.append({
                'trend_id': trend_id,
                'status': 'error',
                'error': str(e)[:500],
            })

    return {
        'applied_count':       sum(1 for r in results if r['status'] == 'ok'),
        'error_count':         sum(1 for r in results if r['status'] == 'error'),
        'rejected_count':      sum(1 for r in results if r['status'] == 'rejected'),
        'retire_proposals':    sum(1 for r in results if r.get('retire_first_cycle')),
        'retire_committed':    sum(1 for r in results if r.get('applied_status') == 'RETIRED'),
        'write_live':          write_live,
        'results':             results,
    }
$$;
