-- Apply with the editorial queue paused and old workers drained. The mutex
-- is initialized once; its UPDATE lock, not a standard-table PK, serializes writers.
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATION_MUTEX (
    LOCK_ID NUMBER NOT NULL,
    REVISION NUMBER NOT NULL
);
INSERT INTO MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATION_MUTEX
SELECT 1, 0 WHERE NOT EXISTS (
    SELECT 1 FROM MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATION_MUTEX
);

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATIONS (
    NOMINATION_ID VARCHAR(64) NOT NULL,
    REQUEST VARIANT NOT NULL,
    DROPPED_URLS VARIANT NOT NULL,
    STATUS VARCHAR NOT NULL DEFAULT 'pending',
    RESULT VARIANT,
    PLAN VARIANT,
    CREATED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    UPDATED_AT TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    OWNER VARCHAR,
    LEASE_UNTIL TIMESTAMP_LTZ,
    QUEUE_CONFIRMED_AT TIMESTAMP_LTZ,
    ATTEMPT_COUNT NUMBER NOT NULL DEFAULT 0
);

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_EDITORIAL_NOMINATION(
    OPERATION VARCHAR, NOMINATION_ID VARCHAR, DATA VARIANT
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

TABLE = 'MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATIONS'
MUTEX = 'MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATION_MUTEX'
CANDIDATES = 'MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES'
LIFECYCLE = 'MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER'


def variant(value):
    return json.loads(value) if isinstance(value, str) else value


def read(session, nid):
    rows = session.sql(f'SELECT * FROM {TABLE} WHERE NOMINATION_ID = ?', [nid]).collect()
    if len(rows) > 1:
        raise ValueError('duplicate nomination receipts require operator repair')
    if not rows:
        return None
    row = rows[0].as_dict()
    result = variant(row['RESULT']) or {}
    return {
        'nomination_id': row['NOMINATION_ID'],
        'request': variant(row['REQUEST']),
        'dropped_urls': variant(row['DROPPED_URLS']),
        'status': row['STATUS'],
        'trend_id': result.get('trend_id'),
        'error': result.get('error'),
        'created_at': str(row['CREATED_AT']),
        'updated_at': str(row['UPDATED_AT']),
        'owner': row['OWNER'],
        'lease_until': str(row['LEASE_UNTIL']) if row['LEASE_UNTIL'] else None,
        'queue_confirmed_at': str(row['QUEUE_CONFIRMED_AT']) if row['QUEUE_CONFIRMED_AT'] else None,
        'plan': variant(row['PLAN']),
    }


def lock(session):
    changed = session.sql(f'UPDATE {MUTEX} SET REVISION = REVISION + 1 WHERE LOCK_ID = 1').collect()
    if int(changed[0][0]) != 1:
        raise ValueError('editorial mutex requires exactly one row')


def active_owner(session, nid):
    rows = session.sql(f'''
        SELECT OWNER FROM {TABLE}
        WHERE NOMINATION_ID = ? AND LEASE_UNTIL > CURRENT_TIMESTAMP()
    ''', [nid]).collect()
    return rows[0][0] if rows else None


def require_owner(session, nid, receipt, data):
    owner = data.get('owner')
    if not owner or receipt['status'] != 'pending' or active_owner(session, nid) != owner:
        raise ValueError('nomination ownership lost')


def candidate(session, nid):
    rows = session.sql(f'''
        SELECT TOPIC, PROMOTED_AT, PROMOTED_TO, DEDUP_OF_TREND_ID
        FROM {CANDIDATES} WHERE CANDIDATE_ID = ?
    ''', [nid]).collect()
    if len(rows) > 1:
        raise ValueError('duplicate nomination candidates require operator repair')
    return rows[0].as_dict() if rows else None


def failure(session, nid, terminal):
    applied = candidate(session, nid)
    target = applied['PROMOTED_TO'] if applied and applied['PROMOTED_AT'] else None
    if terminal:
        message = ('The trend was updated, but nomination processing did not finish.' if target
                   else 'Nomination processing did not finish. Contact support with the nomination ID.')
        code = 'processing_incomplete' if applied else 'processing_failed'
    else:
        message = ('The trend was updated, but nomination processing is incomplete and will retry.'
                   if target else 'Processing was interrupted and will retry.')
        code = 'processing_retry'
    result = {'trend_id': target, 'error': {'code': code, 'message': message}}
    session.sql(f'''
        UPDATE {TABLE} SET STATUS = ?, RESULT = PARSE_JSON(?), OWNER = NULL,
            LEASE_UNTIL = NULL, UPDATED_AT = CURRENT_TIMESTAMP()
        WHERE NOMINATION_ID = ?
    ''', ['failed' if terminal else 'pending', json.dumps(result), nid]).collect()


def revive(session, nid, target):
    prior = session.sql(f'''
        SELECT 1 FROM {LIFECYCLE}
        WHERE TREND_ID = ? AND CHAIN_ID = ? AND NEW_STATUS = 'RESURGENT'
    ''', [target, nid]).collect()
    if prior:
        return True
    rows = session.sql(f'''
        SELECT NEW_STATUS, NEW_HEAT, NEW_HEAT_SMOOTHED, HEAT_BASE FROM {LIFECYCLE}
        WHERE TREND_ID = ? ORDER BY EVALUATED_AT DESC LIMIT 1
    ''', [target]).collect()
    if not rows or rows[0][0] != 'RETIRED':
        return False
    state = rows[0]
    session.sql(f'''
        INSERT INTO {LIFECYCLE}
            (TREND_ID, AGENT_SESSION_ID, CHAIN_ID, PRIOR_STATUS, NEW_STATUS,
             PRIOR_HEAT, NEW_HEAT, NEW_HEAT_SMOOTHED, HEAT_BASE, HEAT_MODIFIER_PCT,
             REASONING, DECISION_PAYLOAD, MODEL_USED, NEXT_EVAL_AT)
        SELECT ?, 'editorial', ?, 'RETIRED', 'RESURGENT', ?, ?, ?, ?, 0,
            'editorial nomination matched a retired trend', PARSE_JSON(?), NULL,
            DATEADD(second, 3600, CURRENT_TIMESTAMP())
    ''', [target, nid, state[1], state[1], state[2], state[3],
          json.dumps({'nomination_id': nid})]).collect()
    return True


def complete(session, nid):
    applied = candidate(session, nid)
    if not applied or not applied['PROMOTED_AT'] or not applied['PROMOTED_TO']:
        raise ValueError('nomination candidate is not committed')
    status = 'created'
    if applied['DEDUP_OF_TREND_ID']:
        status = 'resurgent' if revive(session, nid, applied['PROMOTED_TO']) else 'merged'
    result = {'trend_id': applied['PROMOTED_TO'], 'error': None}
    session.sql(f'''
        UPDATE {TABLE} SET STATUS = ?, RESULT = PARSE_JSON(?),
            OWNER = NULL, LEASE_UNTIL = NULL, UPDATED_AT = CURRENT_TIMESTAMP()
        WHERE NOMINATION_ID = ?
    ''', [status, json.dumps(result), nid]).collect()


def prepare(session, nid, receipt, data):
    if candidate(session, nid):
        return
    plan = receipt['plan']
    if not plan:
        raise ValueError('nomination has no saved evaluation')
    rows = session.sql('''
        CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(?, ?, 500, 'STG_EXTERNAL_SIGNALS')
    ''', [json.dumps(data['signals']), nid]).collect()
    merged = variant(rows[0][0])
    if not isinstance(merged, dict) or merged.get('error'):
        raise ValueError('editorial signal merge failed')
    ids = [url['canonical'] for url in receipt['request']['urls']]
    session.sql(f'''
        INSERT INTO {CANDIDATES}
            (CANDIDATE_ID, AGENT_SESSION_ID, CHAIN_ID, ITERATION, TOPIC,
             SUPPORTING_SIGNAL_IDS, SOURCE_BREAKDOWN, REASONING)
        SELECT ?, ?, ?, 1, ?, PARSE_JSON(?), PARSE_JSON(?), ?
    ''', [nid, nid, nid, plan['topic'], json.dumps(ids),
          json.dumps({'editorial': len(ids)}), receipt['request']['brief']]).collect()


def run(session, OPERATION, NOMINATION_ID, DATA):
    data = variant(DATA) or {}
    nid = NOMINATION_ID
    if OPERATION == 'get':
        return read(session, nid)
    session.sql('BEGIN').collect()
    try:
        lock(session)
        receipt = read(session, nid)
        if OPERATION == 'accept':
            if receipt is None:
                session.sql(f'''
                    INSERT INTO {TABLE} (NOMINATION_ID, REQUEST, DROPPED_URLS)
                    SELECT ?, PARSE_JSON(?), PARSE_JSON(?)
                ''', [nid, json.dumps(data['request']), json.dumps(data['dropped_urls'])]).collect()
        elif receipt is None:
            raise ValueError('unknown nomination')
        elif OPERATION == 'claim':
            if receipt['status'] == 'pending':
                active = active_owner(session, nid)
                if active and active != data['owner']:
                    session.sql('COMMIT').collect()
                    return None
                session.sql(f'''
                    UPDATE {TABLE} SET OWNER = ?,
                        LEASE_UNTIL = DATEADD(second, 960, CURRENT_TIMESTAMP()),
                        ATTEMPT_COUNT = ATTEMPT_COUNT + 1,
                        UPDATED_AT = CURRENT_TIMESTAMP()
                    WHERE NOMINATION_ID = ?
                ''', [data['owner'], nid]).collect()
        elif OPERATION == 'plan':
            require_owner(session, nid, receipt, data)
            if not receipt['plan']:
                session.sql(f'''
                    UPDATE {TABLE} SET PLAN = PARSE_JSON(?), UPDATED_AT = CURRENT_TIMESTAMP()
                    WHERE NOMINATION_ID = ?
                ''', [json.dumps(data['plan']), nid]).collect()
        elif OPERATION == 'attempt_failed':
            if receipt['status'] == 'pending' and receipt['owner'] == data.get('owner'):
                failure(session, nid, False)
        elif OPERATION == 'prepare':
            require_owner(session, nid, receipt, data)
            prepare(session, nid, receipt, data)
        elif OPERATION == 'complete':
            if receipt['status'] == 'pending':
                require_owner(session, nid, receipt, data)
                complete(session, nid)
        elif OPERATION == 'queued':
            session.sql(f'''
                UPDATE {TABLE} SET QUEUE_CONFIRMED_AT = COALESCE(
                    QUEUE_CONFIRMED_AT, CURRENT_TIMESTAMP()), UPDATED_AT = CURRENT_TIMESTAMP()
                WHERE NOMINATION_ID = ?
            ''', [nid]).collect()
        elif OPERATION == 'reconcile':
            if receipt['status'] == 'pending' and not active_owner(session, nid):
                applied = candidate(session, nid)
                if applied and applied['PROMOTED_AT'] and applied['PROMOTED_TO']:
                    complete(session, nid)
                else:
                    failure(session, nid, True)
        else:
            raise ValueError('unknown nomination operation')
        result = read(session, nid)
        session.sql('COMMIT').collect()
        return result
    except Exception:
        session.sql('ROLLBACK').collect()
        raise
$$;
