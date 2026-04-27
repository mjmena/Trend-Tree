-- Procedure: Atomic apply for promotion-agent decisions.
-- Database: MCC_RAW.MARKETING_DEV (calls); reads/writes MCC_PRESENTATION.TREND_AGENT
--
-- Called once per promotion-agent iteration by the Pipedream workflow
-- `promotion-p_xMC99jg`. Takes a single VARIANT array of decision objects,
-- dispatches each one inside a transaction, writes a FCT_PROMOTION_AUDIT row
-- per decision (including failures), and returns a summary VARIANT.
--
-- Decision object shape:
--   {
--     "candidate_id":         "uuid",
--     "decision":             "PROMOTE_NEW" | "MERGE_INTO_EXISTING" | "REJECT" | "DEFER",
--     "decision_category":    "CONFIRM_NEW" | "MISSED_DUPLICATE" | ... ,
--     "target_trend_id":      "uuid"  // for MERGE_INTO_EXISTING (must exist in FCT_TRENDS)
--     "trend_topic":          "..."   // for PROMOTE_NEW
--     "trend_vector":         [1024 floats]  // for PROMOTE_NEW
--     "rejection_reason":     "..."   // for REJECT
--     "defer_until":          "ISO timestamp"  // for DEFER
--     "defer_reason":         "..."   // for DEFER
--     "rationale":            "...",
--     "distillation_verdict": "REAL_TREND" | "DUPLICATE_OF_<id>" | "NOISE" | "CATEGORY_TOO_BROAD",
--     "max_neighbor_sim":     0.83,
--     "considered_neighbors": [...],
--     "tokens":               {"input": 3000, "output": 800},
--     "cost_usd":             0.04
--   }
--
-- Signal lifecycle by decision:
--   PROMOTE_NEW         — INSERT FCT_TRENDS row; mark candidate PROMOTED_AT/PROMOTED_TO=new_id
--                         signals stay claimed via candidate's SUPPORTING_SIGNAL_IDS
--   MERGE_INTO_EXISTING — UPDATE existing FCT_TRENDS.LAST_UPDATE_AT;
--                         mark candidate PROMOTED_AT/PROMOTED_TO/DEDUP_OF_TREND_ID=target
--   REJECT              — mark candidate REJECTED_AT, REJECTION_REASON;
--                         RELEASE signal claims (set AGENT_SESSION_ID=NULL on STG_EXTERNAL_SIGNALS)
--                         so future distillation runs can re-cluster them
--   DEFER               — mark candidate DEFERRED_UNTIL, DEFER_REASON;
--                         signal claims preserved (we'll resolve later)
--
-- Each per-decision change is wrapped in BEGIN/COMMIT; on exception ROLLBACK
-- and continue to the next decision. A bad apple doesn't fail the batch.
--
-- Usage:
--   CALL MCC_RAW.MARKETING_DEV.PROC_PROMOTION_APPLY(
--     PARSE_JSON('[{...}, {...}]'),
--     'chain-uuid',
--     1
--   );

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_PROMOTION_APPLY(
    DECISIONS VARIANT,
    CHAIN_ID  VARCHAR,
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

ALLOWED_DECISIONS = {'PROMOTE_NEW', 'MERGE_INTO_EXISTING', 'REJECT', 'DEFER'}


def sql_str(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''").replace("\\", "\\\\") + "'"


def sql_json(obj):
    if obj is None:
        return 'NULL'
    return "PARSE_JSON('" + json.dumps(obj).replace("'", "''").replace("\\", "\\\\") + "')"


def sql_vector_literal(vec):
    """1024-dim float vector as Snowflake VECTOR literal."""
    if vec is None:
        return 'NULL'
    if isinstance(vec, str):
        vec = json.loads(vec)
    floats = [str(float(x)) for x in vec]
    return "[" + ",".join(floats) + "]::VECTOR(FLOAT, 1024)"


def log_audit(session, audit_row):
    """Insert one FCT_PROMOTION_AUDIT row. Best-effort; doesn't raise."""
    try:
        considered = audit_row.get('considered_neighbors', [])
        tokens     = audit_row.get('tokens', {}) or {}
        in_tok     = tokens.get('input')
        out_tok    = tokens.get('output')
        session.sql(f"""
            INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_AUDIT
                (CANDIDATE_ID, CHAIN_ID, ITERATION,
                 DECISION, DECISION_CATEGORY, TARGET_TREND_ID,
                 DISTILLATION_VERDICT, OVERRODE_VERDICT,
                 MAX_NEIGHBOR_SIM, CONSIDERED_NEIGHBORS,
                 CLUSTER_SIZE, SOURCE_COUNT, CONFIDENCE,
                 RATIONALE, MODEL_USED, INPUT_TOKENS, OUTPUT_TOKENS, COST_ESTIMATE)
            SELECT {sql_str(audit_row.get('candidate_id'))},
                   {sql_str(audit_row.get('chain_id'))},
                   {int(audit_row.get('iteration') or 1)},
                   {sql_str(audit_row.get('decision'))},
                   {sql_str(audit_row.get('decision_category'))},
                   {sql_str(audit_row.get('target_trend_id'))},
                   {sql_str(audit_row.get('distillation_verdict'))},
                   {('TRUE' if audit_row.get('overrode_verdict') else 'FALSE')},
                   {float(audit_row['max_neighbor_sim']) if audit_row.get('max_neighbor_sim') is not None else 'NULL'},
                   {sql_json(considered)},
                   {int(audit_row['cluster_size']) if audit_row.get('cluster_size') is not None else 'NULL'},
                   {int(audit_row['source_count']) if audit_row.get('source_count') is not None else 'NULL'},
                   {float(audit_row['confidence']) if audit_row.get('confidence') is not None else 'NULL'},
                   {sql_str((audit_row.get('rationale') or '')[:4000])},
                   {sql_str(audit_row.get('model_used') or 'claude-sonnet-4-6')},
                   {int(in_tok) if in_tok is not None else 'NULL'},
                   {int(out_tok) if out_tok is not None else 'NULL'},
                   {float(audit_row['cost_usd']) if audit_row.get('cost_usd') is not None else 'NULL'}
        """).collect()
    except Exception:
        # Audit-log failure must not crash the whole batch.
        pass


def overrode(decision, distillation_verdict):
    """True if agent decision conflicts with distillation's verdict."""
    if not distillation_verdict:
        return False
    dv = distillation_verdict.upper()
    if decision == 'PROMOTE_NEW':
        return dv.startswith('DUPLICATE_OF') or dv in ('NOISE', 'CATEGORY_TOO_BROAD')
    if decision == 'MERGE_INTO_EXISTING':
        return dv == 'REAL_TREND' or dv in ('NOISE', 'CATEGORY_TOO_BROAD')
    if decision == 'REJECT':
        return dv == 'REAL_TREND' or dv.startswith('DUPLICATE_OF')
    if decision == 'DEFER':
        return False  # DEFER is not really an override
    return False


def derive_candidate_meta(session, candidate_id):
    """Pull cluster_size, source_count, confidence from the candidate row for audit."""
    rs = session.sql(f"""
        SELECT
          ARRAY_SIZE(SUPPORTING_SIGNAL_IDS),
          ARRAY_SIZE(OBJECT_KEYS(SOURCE_BREAKDOWN)),
          CONFIDENCE
        FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
        WHERE CANDIDATE_ID = {sql_str(candidate_id)}
    """).collect()
    if not rs or not rs[0]:
        return (None, None, None)
    return (rs[0][0], rs[0][1], rs[0][2])


def run(session, DECISIONS, CHAIN_ID, ITERATION):
    if DECISIONS is None:
        return {'applied_count': 0, 'results': []}
    if isinstance(DECISIONS, str):
        DECISIONS = json.loads(DECISIONS)
    if not isinstance(DECISIONS, list):
        return {'error': 'DECISIONS must be a JSON array', 'got': str(type(DECISIONS))}

    chain_id  = CHAIN_ID
    iteration = int(ITERATION or 1)
    results   = []

    for d in DECISIONS:
        cid       = d.get('candidate_id')
        decision  = (d.get('decision') or '').upper()
        rationale = d.get('rationale', '')
        cat       = d.get('decision_category')
        target    = d.get('target_trend_id')
        topic     = d.get('trend_topic')
        vector    = d.get('trend_vector')
        rej_reason= d.get('rejection_reason')
        def_until = d.get('defer_until')
        def_reason= d.get('defer_reason')
        dv        = d.get('distillation_verdict')
        max_sim   = d.get('max_neighbor_sim')
        considered= d.get('considered_neighbors', [])
        tokens    = d.get('tokens', {})
        cost_usd  = d.get('cost_usd')

        # Derive candidate meta for audit (cluster_size, source_count, confidence)
        cluster_size, source_count, confidence = derive_candidate_meta(session, cid)

        audit_row = {
            'candidate_id':         cid,
            'chain_id':             chain_id,
            'iteration':            iteration,
            'decision':             decision,
            'decision_category':    cat,
            'target_trend_id':      None,  # set below for PROMOTE_NEW / MERGE
            'distillation_verdict': dv,
            'overrode_verdict':     overrode(decision, dv),
            'max_neighbor_sim':     max_sim,
            'considered_neighbors': considered,
            'cluster_size':         cluster_size,
            'source_count':         source_count,
            'confidence':           confidence,
            'rationale':            rationale,
            'model_used':           d.get('model_used'),
            'tokens':               tokens,
            'cost_usd':             cost_usd,
        }

        # Guardrail: drop anything not in the allow-list
        if decision not in ALLOWED_DECISIONS:
            results.append({'candidate_id': cid, 'decision': decision, 'status': 'rejected',
                            'error': 'unknown_decision'})
            log_audit(session, audit_row)
            continue

        try:
            session.sql("BEGIN").collect()

            if decision == 'PROMOTE_NEW':
                # Insert new FCT_TRENDS row; copy candidate fields.
                # New TREND_ID assigned by UUID_STRING(); captured via the
                # candidate update so we can audit it.
                rs = session.sql(f"""
                    INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS (
                        TREND_ID, CANDIDATE_ID, TREND_TOPIC, AGENT_SESSION_ID, CHAIN_ID,
                        DETECTED_AT, LAST_UPDATE_AT, PROMOTED_AT,
                        TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT,
                        CONFIDENCE, SPECIFICITY_SCORE, VELOCITY_DIRECTION,
                        TREND_HEAT_INDEX, TREND_VECTOR
                    )
                    SELECT
                        UUID_STRING(),
                        c.CANDIDATE_ID,
                        COALESCE({sql_str(topic)}, c.TOPIC),
                        c.AGENT_SESSION_ID,
                        c.CHAIN_ID,
                        c.CREATED_AT, c.CREATED_AT, CURRENT_TIMESTAMP(),
                        ARRAY_SIZE(c.SUPPORTING_SIGNAL_IDS),
                        ARRAY_SIZE(OBJECT_KEYS(c.SOURCE_BREAKDOWN)),
                        c.CONFIDENCE, c.SPECIFICITY_SCORE, 'NEW',
                        -- Heat formula (placeholder until a daily-snapshot
                        -- recomputation task lands): cluster_size × 5 +
                        -- source_count × 3 + confidence × 20, baselined at 50,
                        -- capped at 100. New trends typically land 75-100.
                        LEAST(
                            50
                            + COALESCE(ARRAY_SIZE(c.SUPPORTING_SIGNAL_IDS), 0) * 5
                            + COALESCE(ARRAY_SIZE(OBJECT_KEYS(c.SOURCE_BREAKDOWN)), 0) * 3
                            + COALESCE(c.CONFIDENCE, 0.5) * 20,
                            100
                        ),
                        -- Vector: prefer agent-supplied (trend_vector in the
                        -- decision payload) but fall back to a Cortex embedding
                        -- of the topic so this column is never null.
                        COALESCE(
                            {sql_vector_literal(vector)},
                            SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
                                'snowflake-arctic-embed-l-v2.0',
                                COALESCE({sql_str(topic)}, c.TOPIC)
                            )
                        )
                    FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
                    WHERE c.CANDIDATE_ID = {sql_str(cid)}
                """).collect()

                # Look up the TREND_ID we just generated (only one row per candidate)
                tid_rs = session.sql(f"""
                    SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                    WHERE CANDIDATE_ID = {sql_str(cid)}
                    ORDER BY PROMOTED_AT DESC LIMIT 1
                """).collect()
                new_tid = tid_rs[0][0] if tid_rs else None
                audit_row['target_trend_id'] = new_tid

                session.sql(f"""
                    UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
                    SET PROMOTED_AT = CURRENT_TIMESTAMP(),
                        PROMOTED_TO = {sql_str(new_tid)},
                        PROMOTION_DECIDED_BY = {sql_str(chain_id)}
                    WHERE CANDIDATE_ID = {sql_str(cid)}
                """).collect()

                session.sql("COMMIT").collect()
                results.append({'candidate_id': cid, 'decision': 'PROMOTE_NEW',
                                'target_trend_id': new_tid, 'status': 'ok'})

            elif decision == 'MERGE_INTO_EXISTING':
                # Validate target exists in FCT_TRENDS
                if not target:
                    raise ValueError('target_trend_id required for MERGE_INTO_EXISTING')
                check = session.sql(f"""
                    SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                    WHERE TREND_ID = {sql_str(target)}
                """).collect()
                if not check or int(check[0][0]) == 0:
                    raise ValueError(f'target_trend_id {target} not found in FCT_TRENDS')

                # Link candidate to target FIRST so the aggregate below sees it.
                session.sql(f"""
                    UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
                    SET PROMOTED_AT = CURRENT_TIMESTAMP(),
                        PROMOTED_TO = {sql_str(target)},
                        DEDUP_OF_TREND_ID = {sql_str(target)},
                        PROMOTION_DECIDED_BY = {sql_str(chain_id)}
                    WHERE CANDIDATE_ID = {sql_str(cid)}
                """).collect()

                # Recompute cluster fields across the original promoting
                # candidate plus every candidate merged INTO this trend.
                # Re-embed vector using topic + concatenated reasoning so it
                # reflects the broader evidence. Heat index NOT touched here:
                # placeholder formula belongs to the future lifecycle agent.
                session.sql(f"""
                    UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
                    SET
                        TOTAL_CLUSTER_SIZE = (
                            SELECT COUNT(DISTINCT f.value::STRING)
                            FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
                                 LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
                            WHERE c.CANDIDATE_ID = t.CANDIDATE_ID
                               OR c.DEDUP_OF_TREND_ID = t.TREND_ID
                        ),
                        DISTINCT_SOURCE_COUNT = (
                            SELECT COUNT(DISTINCT f.value::STRING)
                            FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
                                 LATERAL FLATTEN(INPUT => OBJECT_KEYS(c.SOURCE_BREAKDOWN)) f
                            WHERE c.CANDIDATE_ID = t.CANDIDATE_ID
                               OR c.DEDUP_OF_TREND_ID = t.TREND_ID
                        ),
                        TREND_VECTOR = SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
                            'snowflake-arctic-embed-l-v2.0',
                            LEFT(
                                COALESCE(t.TREND_TOPIC, '') || ' | ' ||
                                COALESCE((
                                    SELECT LISTAGG(LEFT(c.REASONING, 400), ' || ')
                                             WITHIN GROUP (ORDER BY c.CREATED_AT)
                                    FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
                                    WHERE c.CANDIDATE_ID = t.CANDIDATE_ID
                                       OR c.DEDUP_OF_TREND_ID = t.TREND_ID
                                ), ''),
                                4000
                            )
                        ),
                        LAST_UPDATE_AT = CURRENT_TIMESTAMP()
                    WHERE t.TREND_ID = {sql_str(target)}
                """).collect()

                audit_row['target_trend_id'] = target
                session.sql("COMMIT").collect()
                results.append({'candidate_id': cid, 'decision': 'MERGE_INTO_EXISTING',
                                'target_trend_id': target, 'status': 'ok'})

            elif decision == 'REJECT':
                # Mark candidate rejected
                session.sql(f"""
                    UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
                    SET REJECTED_AT = CURRENT_TIMESTAMP(),
                        REJECTION_REASON = {sql_str((rej_reason or 'UNSPECIFIED')[:200])},
                        PROMOTION_DECIDED_BY = {sql_str(chain_id)}
                    WHERE CANDIDATE_ID = {sql_str(cid)}
                """).collect()

                # Release signal claims so future distillation can re-cluster
                session.sql(f"""
                    UPDATE MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
                    SET AGENT_SESSION_ID = NULL
                    WHERE s.SIGNAL_ID IN (
                        SELECT DISTINCT sig.value::STRING
                        FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
                             LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) sig
                        WHERE c.CANDIDATE_ID = {sql_str(cid)}
                    )
                """).collect()

                session.sql("COMMIT").collect()
                results.append({'candidate_id': cid, 'decision': 'REJECT', 'status': 'ok'})

            elif decision == 'DEFER':
                # Always compute defer time in SQL — LLMs are unreliable at
                # picking absolute future dates ("now + 48h" frequently lands
                # in the past). Hard-coded 48h hold.
                session.sql(f"""
                    UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
                    SET DEFERRED_UNTIL = DATEADD(hour, 48, CURRENT_TIMESTAMP()),
                        DEFER_REASON = {sql_str((def_reason or 'UNSPECIFIED')[:200])},
                        PROMOTION_DECIDED_BY = {sql_str(chain_id)}
                    WHERE CANDIDATE_ID = {sql_str(cid)}
                """).collect()

                session.sql("COMMIT").collect()
                results.append({'candidate_id': cid, 'decision': 'DEFER', 'status': 'ok'})

        except Exception as e:
            try:
                session.sql("ROLLBACK").collect()
            except Exception:
                pass
            results.append({'candidate_id': cid, 'decision': decision,
                            'status': 'error', 'error': str(e)[:500]})

        log_audit(session, audit_row)

    return {
        'applied_count':  sum(1 for r in results if r['status'] == 'ok'),
        'promote_count':  sum(1 for r in results if r['status'] == 'ok' and r['decision'] == 'PROMOTE_NEW'),
        'merge_count':    sum(1 for r in results if r['status'] == 'ok' and r['decision'] == 'MERGE_INTO_EXISTING'),
        'reject_count':   sum(1 for r in results if r['status'] == 'ok' and r['decision'] == 'REJECT'),
        'defer_count':    sum(1 for r in results if r['status'] == 'ok' and r['decision'] == 'DEFER'),
        'error_count':    sum(1 for r in results if r['status'] == 'error'),
        'rejected_count': sum(1 for r in results if r['status'] == 'rejected'),
        'results':        results,
    }
$$;
