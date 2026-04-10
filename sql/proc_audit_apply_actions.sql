-- Procedure: Dispatcher for audit agent actions
-- Database: MCC_RAW.MARKETING_DEV (temp write side); reads/writes MCC_PRESENTATION.TREND_AGENT
--
-- Called once per audit-agent iteration by the Pipedream workflow
-- `agents/audit-p_pWCwPyL`. Takes a single VARIANT array of action
-- objects, dispatches each one, and writes a FCT_TREND_AUDIT_LOG row for
-- every action (including failures). Returns a summary VARIANT.
--
-- Action object shape:
--   {
--     "trend_id":    "uuid",
--     "audit_type":  "SPLIT_CANDIDATE" | "CATEGORY_DRIFT" | "STALLED_QUEUE",
--     "action":      "SPLIT" | "REQUEUE_FULL" | "REQUEUE_REFRESH" | "UNSTALL_QUEUE" | "FLAG_ONLY",
--     "reason":      "one sentence",
--     "confidence":  0.0-1.0,
--     "finding":     { ... rule-level evidence ... }
--   }
--
-- Also takes CHAIN_ID (VARCHAR) and ITERATION (NUMBER) so every row in
-- FCT_TREND_AUDIT_LOG is grouped to the run that produced it.
--
-- Usage:
--   CALL MCC_RAW.MARKETING_DEV.PROC_AUDIT_APPLY_ACTIONS(
--     PARSE_JSON('[{...}, {...}]'),
--     'chain-uuid',
--     1
--   );

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_AUDIT_APPLY_ACTIONS(
    ACTIONS VARIANT,
    CHAIN_ID VARCHAR,
    ITERATION NUMBER
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

ALLOWED_ACTIONS = {'SPLIT', 'REQUEUE_FULL', 'REQUEUE_REFRESH', 'UNSTALL_QUEUE', 'FLAG_ONLY'}
ALLOWED_AUDIT_TYPES = {'SPLIT_CANDIDATE', 'CATEGORY_DRIFT', 'STALLED_QUEUE'}


def sql_str(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''").replace("\\", "\\\\") + "'"


def sql_json(obj):
    if obj is None:
        return 'NULL'
    return "PARSE_JSON('" + json.dumps(obj).replace("'", "''").replace("\\", "\\\\") + "')"


def log_audit(session, chain_id, iteration, trend_id, audit_type, finding,
              action_proposed, action_taken, action_result, reasoning, confidence):
    reasoning_trimmed = (reasoning or '')[:2000]
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_AUDIT_LOG
            (CHAIN_ID, ITERATION, TREND_ID, AUDIT_TYPE, FINDING,
             ACTION_PROPOSED, ACTION_TAKEN, ACTION_RESULT, LLM_REASONING, LLM_CONFIDENCE)
        SELECT {sql_str(chain_id)}, {iteration}, {sql_str(trend_id)},
               {sql_str(audit_type)}, {sql_json(finding)},
               {sql_str(action_proposed)}, {sql_str(action_taken)},
               {sql_json(action_result)},
               {sql_str(reasoning_trimmed)}, {float(confidence) if confidence is not None else 'NULL'}
    """).collect()


def run(session, ACTIONS, CHAIN_ID, ITERATION):
    # ACTIONS arrives as a Python list/dict tree thanks to VARIANT unwrap
    if ACTIONS is None:
        return {'applied_count': 0, 'results': []}
    if isinstance(ACTIONS, str):
        ACTIONS = json.loads(ACTIONS)
    if not isinstance(ACTIONS, list):
        return {'error': 'ACTIONS must be a JSON array', 'got': str(type(ACTIONS))}

    chain_id = CHAIN_ID
    iteration = int(ITERATION or 1)
    results = []

    for a in ACTIONS:
        tid = a.get('trend_id')
        act_proposed = a.get('action')
        audit_type = a.get('audit_type', 'SPLIT_CANDIDATE')
        reasoning = a.get('reason', '')
        confidence = a.get('confidence')
        finding = a.get('finding', {})

        # Guardrail: drop anything not in the allow-list
        if act_proposed not in ALLOWED_ACTIONS:
            act_taken = 'NONE'
            action_result = {'error': 'action_not_allowed', 'proposed': act_proposed}
            results.append({'trend_id': tid, 'action': act_taken, 'status': 'rejected'})
            log_audit(session, chain_id, iteration, tid, audit_type, finding,
                      act_proposed, act_taken, action_result, reasoning, confidence)
            continue
        if audit_type not in ALLOWED_AUDIT_TYPES:
            audit_type = 'SPLIT_CANDIDATE'

        act_taken = act_proposed
        action_result = {}

        try:
            if act_proposed == 'SPLIT':
                rs = session.sql(
                    f"CALL MCC_RAW.MARKETING_DEV.PROC_SPLIT_TREND({sql_str(tid)})"
                ).collect()
                raw = rs[0][0] if rs and rs[0] else None
                try:
                    action_result = json.loads(raw) if isinstance(raw, str) else (raw or {})
                except Exception:
                    action_result = {'raw': str(raw)}

            elif act_proposed in ('REQUEUE_FULL', 'REQUEUE_REFRESH'):
                etype = 'FULL' if act_proposed == 'REQUEUE_FULL' else 'REFRESH'
                # Insert only if no PENDING row already exists for this trend
                rs = session.sql(f"""
                    INSERT INTO MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE
                        (TREND_ID, TREND_TOPIC, ENRICHMENT_TYPE, PRIORITY, QUEUED_AT, STATUS)
                    SELECT m.TREND_ID, m.TREND_TOPIC, {sql_str(etype)}, 75,
                           CURRENT_TIMESTAMP(), 'PENDING'
                    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
                    WHERE m.TREND_ID = {sql_str(tid)}
                      AND m.VELOCITY_DIRECTION != 'SUPERSEDED'
                      AND NOT EXISTS (
                          SELECT 1 FROM MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE q
                          WHERE q.TREND_ID = {sql_str(tid)} AND q.STATUS = 'PENDING'
                      )
                """).collect()
                inserted = int(rs[0][0]) if rs and rs[0] else 0
                action_result = {'enrichment_type': etype, 'queued': inserted}
                if inserted == 0:
                    act_taken = 'NONE'
                    action_result['skipped'] = 'already_pending_or_superseded'

            elif act_proposed == 'UNSTALL_QUEUE':
                rs = session.sql(f"""
                    UPDATE MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE
                    SET STATUS = 'PENDING', STARTED_AT = NULL
                    WHERE TREND_ID = {sql_str(tid)}
                      AND STATUS = 'IN_PROGRESS'
                      AND STARTED_AT < DATEADD(hour, -2, CURRENT_TIMESTAMP())
                """).collect()
                updated = int(rs[0][0]) if rs and rs[0] else 0
                action_result = {'unstalled': updated}
                if updated == 0:
                    act_taken = 'NONE'
                    action_result['skipped'] = 'not_stuck'

            elif act_proposed == 'FLAG_ONLY':
                action_result = {'flagged': True}

            results.append({
                'trend_id': tid,
                'action': act_taken,
                'status': 'ok',
                'result': action_result,
            })

        except Exception as e:
            act_taken = 'NONE'
            action_result = {'error': str(e)[:500]}
            results.append({
                'trend_id': tid,
                'action': act_proposed,
                'status': 'error',
                'error': str(e)[:500],
            })

        log_audit(session, chain_id, iteration, tid, audit_type, finding,
                  act_proposed, act_taken, action_result, reasoning, confidence)

    # applied_count = actions that changed state (excludes FLAG_ONLY and NONE)
    # This is what eval_and_retrigger uses to decide whether to self-loop.
    changed_state = {'SPLIT', 'REQUEUE_FULL', 'REQUEUE_REFRESH', 'UNSTALL_QUEUE'}
    return {
        'applied_count': sum(1 for r in results if r['status'] == 'ok' and r['action'] in changed_state),
        'flagged_count': sum(1 for r in results if r['status'] == 'ok' and r['action'] == 'FLAG_ONLY'),
        'rejected_count': sum(1 for r in results if r['status'] == 'rejected'),
        'error_count': sum(1 for r in results if r['status'] == 'error'),
        'noop_count': sum(1 for r in results if r['action'] == 'NONE' and r['status'] == 'ok'),
        'results': results,
    }
$$;
