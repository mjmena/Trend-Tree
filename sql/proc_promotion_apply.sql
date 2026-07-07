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
--     "decision":             "PROMOTE_NEW" | "MERGE_INTO_EXISTING" | "MERGE_INTO_CANDIDATE" | "REJECT" | "DEFER",
--     "decision_category":    "CONFIRM_NEW" | "MISSED_DUPLICATE" | "INTRA_BATCH_DUPE" | ... ,
--     "target_trend_id":      "uuid"  // for MERGE_INTO_EXISTING (must exist in FCT_TRENDS)
--     "target_candidate_id":  "uuid"  // for MERGE_INTO_CANDIDATE (the leader candidate in the same batch)
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
-- MERGE_INTO_CANDIDATE: emitted by run_lead_agent when intra-batch clustering
-- finds two candidates that are near-dupes of each other. The "leader" gets
-- the normal subagent treatment (PROMOTE_NEW or whatever the LLM decides);
-- followers point at the leader via target_candidate_id. The proc topo-sorts
-- decisions so PROMOTE_NEW runs first, then MERGE_INTO_CANDIDATE looks up
-- the leader's PROMOTED_TO and falls through to MERGE_INTO_EXISTING. If the
-- leader was REJECTed/DEFERred, followers mirror that outcome.
--
-- Signal lifecycle by decision:
--   PROMOTE_NEW         — INSERT FCT_TRENDS row; mark candidate PROMOTED_AT/PROMOTED_TO=new_id
--                         signals stay claimed via candidate's SUPPORTING_SIGNAL_IDS
--   MERGE_INTO_EXISTING — recompute target FCT_TRENDS cluster_size/source_count/vector;
--                         mark candidate PROMOTED_AT/PROMOTED_TO/DEDUP_OF_TREND_ID=target
--   REJECT              — mark candidate REJECTED_AT, REJECTION_REASON.
--                         AGENT_SESSION_ID is intentionally NOT released here. Rejected
--                         signals stay stamped so they age out of the main distillation
--                         pool via the 24h window. The daily revisit workflow picks
--                         them up via "stamped but no PROMOTED_TO" and gives them a
--                         second look against signals from later sessions.
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

ALLOWED_DECISIONS = {'PROMOTE_NEW', 'MERGE_INTO_EXISTING', 'MERGE_INTO_CANDIDATE', 'REJECT', 'DEFER'}

# Process order: PROMOTE_NEW first so any MERGE_INTO_CANDIDATE pointing at
# a leader can resolve target_candidate_id → PROMOTED_TO trend_id.
DECISION_ORDER = {
    'PROMOTE_NEW':           0,
    'MERGE_INTO_EXISTING':   1,
    'REJECT':                1,
    'DEFER':                 1,
    'MERGE_INTO_CANDIDATE':  2,
}


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
    """Insert one FCT_PROMOTION_LEDGER row. Best-effort; doesn't raise.
    Renamed from FCT_PROMOTION_AUDIT in the agent-owned-ledgers refactor;
    AUDIT is dropped in step 6 once readers are repointed."""
    try:
        considered = audit_row.get('considered_neighbors', [])
        tokens     = audit_row.get('tokens', {}) or {}
        in_tok     = tokens.get('input')
        out_tok    = tokens.get('output')
        session.sql(f"""
            INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
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


def apply_merge_into_existing(session, cid, target_tid, chain_id):
    """Link candidate to target trend. The cluster_size/source_count recompute
    that used to live here was eliminated by the agent-owned-ledgers refactor —
    those are now derived at query time via V_TREND_AGGREGATES from
    STG_TREND_CANDIDATES (joining on CANDIDATE_ID OR DEDUP_OF_TREND_ID).
    The vector recompute also went away — vectors live in
    FCT_TREND_ENRICHMENT_LEDGER and stay frozen at the trend's most recent
    enrichment/seed; merging signals doesn't justify a re-embed.
    Caller is responsible for BEGIN/COMMIT and target validation."""
    session.sql(f"""
        UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
        SET PROMOTED_AT = CURRENT_TIMESTAMP(),
            PROMOTED_TO = {sql_str(target_tid)},
            DEDUP_OF_TREND_ID = {sql_str(target_tid)},
            PROMOTION_DECIDED_BY = {sql_str(chain_id)}
        WHERE CANDIDATE_ID = {sql_str(cid)}
    """).collect()
    session.sql(f"""
        UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
        SET LAST_UPDATE_AT = CURRENT_TIMESTAMP()
        WHERE TREND_ID = {sql_str(target_tid)}
    """).collect()


def seed_lifecycle_v0(session, trend_id):
    """Insert a v0 lifecycle ledger row for a freshly-promoted trend so
    V_TREND_LIFECYCLE_CURRENT immediately surfaces it. Status NEW, initial
    heat from the same formula PROC v2 used inline, NEXT_EVAL_AT = +1h."""
    # Initial heat seed at promotion mirrors lifecycle subagent's computeHeatBase()
    # — see lifecycle-subagent-p_gYC562o/run_subagent/entry.js. Keep both in sync.
    # At promotion time: recency_factor = 1.0 (just emitted); external_factor = 0
    # (no gtrends yet). Breadth uses source-name count as proxy for publisher
    # count — lifecycle agent recomputes per-publisher within ~1h.
    #
    # heat_base = 20*1 + 25*sigmoid((signal_count - 2)/3) + 25*log_score(sources)
    #           + 0 + 10*confidence
    # log_score = max(0, log2(n) - 0.5) / (log2(10) - 0.5), clamped to [0,1].
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER (
            TREND_ID, EVALUATED_AT, AGENT_SESSION_ID,
            PRIOR_STATUS, NEW_STATUS,
            PRIOR_HEAT, NEW_HEAT, NEW_HEAT_SMOOTHED,
            HEAT_BASE, HEAT_MODIFIER_PCT,
            REASONING, NEXT_EVAL_AT
        )
        SELECT
            TREND_ID, PROMOTED_AT, 'promotion',
            NULL, 'NEW',
            NULL,
            heat_base, heat_base, heat_base,
            0,
            'initial state at promotion',
            DATEADD(hour, 1, CURRENT_TIMESTAMP())
        FROM (
            SELECT
                t.TREND_ID,
                t.PROMOTED_AT,
                ROUND(LEAST(100, GREATEST(0,
                    20.0
                    + 25.0 / (1 + EXP(-((COALESCE(ARRAY_SIZE(c.SUPPORTING_SIGNAL_IDS), 0) - 2.0) / 3.0)))
                    + 25.0 * LEAST(1.0, GREATEST(0.0,
                        (LOG(2, GREATEST(COALESCE(ARRAY_SIZE(OBJECT_KEYS(c.SOURCE_BREAKDOWN)), 0), 1)) - 0.5)
                        / (LOG(2, 10) - 0.5)
                    ))
                    + 0
                    + 10.0 * COALESCE(c.CONFIDENCE, 0.5)
                )), 1) AS heat_base
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
            JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c ON c.CANDIDATE_ID = t.CANDIDATE_ID
            WHERE t.TREND_ID = {sql_str(trend_id)}
        )
    """).collect()


def seed_enrichment_v0(session, trend_id):
    """Insert a promotion_seed enrichment ledger row so V_TREND_ENRICHMENT_CURRENT
    has a vector for the freshly-promoted trend (lifecycle subagent's q_neighbors
    needs vectors for all active trends). Vector computed inline via Cortex
    from TREND_TOPIC since TREND_VECTOR is no longer on FCT_TRENDS."""
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER (
            TREND_ID, WRITTEN_AT, WRITTEN_BY, ENRICHMENT_KIND,
            PAYLOAD, TREND_VECTOR
        )
        SELECT
            t.TREND_ID, t.PROMOTED_AT, 'promotion', 'promotion_seed',
            OBJECT_CONSTRUCT(
                'trend_topic',     t.TREND_TOPIC,
                'gtrends_keyword', t.GTRENDS_KEYWORD,
                'topic_only',      TRUE,
                'note',            'promotion seed; full enrichment pending'
            ),
            SNOWFLAKE.CORTEX.EMBED_TEXT_1024(
                'snowflake-arctic-embed-l-v2.0',
                t.TREND_TOPIC
            )
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
        WHERE t.TREND_ID = {sql_str(trend_id)}
    """).collect()


def lookup_leader_outcome(session, leader_cid):
    """For MERGE_INTO_CANDIDATE — fetch the leader candidate's PROMOTED_TO,
    REJECTED_AT, DEFERRED_UNTIL so we can mirror or resolve."""
    rs = session.sql(f"""
        SELECT PROMOTED_TO, REJECTED_AT, DEFERRED_UNTIL, REJECTION_REASON, DEFER_REASON
        FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
        WHERE CANDIDATE_ID = {sql_str(leader_cid)}
    """).collect()
    if not rs:
        return None
    return {
        'promoted_to':       rs[0][0],
        'rejected_at':       rs[0][1],
        'deferred_until':    rs[0][2],
        'rejection_reason':  rs[0][3],
        'defer_reason':      rs[0][4],
    }


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

    # Topo-sort: PROMOTE_NEW first so MERGE_INTO_CANDIDATE can resolve the
    # leader's PROMOTED_TO. Stable sort preserves caller order within a tier.
    DECISIONS.sort(key=lambda x: DECISION_ORDER.get((x.get('decision') or '').upper(), 99))

    for d in DECISIONS:
        cid       = d.get('candidate_id')
        decision  = (d.get('decision') or '').upper()
        rationale = d.get('rationale', '')
        cat       = d.get('decision_category')
        target    = d.get('target_trend_id')
        target_cid= d.get('target_candidate_id')
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
        # ET corroboration decision record (ADR-0004). et_corr is the agent's ET
        # snapshot; et_second is TRUE only when ET supplied the 2nd source family.
        et_corr   = d.get('et_corroboration')
        et_second = bool(d.get('et_was_second_source'))

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
                        DETECTED_AT, LAST_UPDATE_AT, PROMOTED_AT, GTRENDS_KEYWORD
                    )
                    SELECT
                        UUID_STRING(),
                        c.CANDIDATE_ID,
                        COALESCE({sql_str(topic)}, c.TOPIC),
                        c.AGENT_SESSION_ID,
                        c.CHAIN_ID,
                        c.CREATED_AT, c.CREATED_AT, CURRENT_TIMESTAMP(),
                        -- Search keyword for the gtrends-poller. LLM-derived
                        -- 2-4 word consumer search query, persisted as
                        -- frozen identity (cheap once at promotion).
                        TRIM(SNOWFLAKE.CORTEX.COMPLETE(
                            'mistral-large2',
                            'You convert long marketing trend descriptions into short Google Trends search queries. Output a 2 to 4 word query that real consumers would type into Google when researching this trend. Use simple common terms, not jargon. Output ONLY the query as plain text, no quotes, no explanation, no preamble.\n\nTrend topic: ' || COALESCE({sql_str(topic)}, c.TOPIC) || '\n\nSearch query:'
                        ), ' "''\n\r\t')
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
                        PROMOTION_DECIDED_BY = {sql_str(chain_id)},
                        ET_CORROBORATION = {sql_json(et_corr)},
                        ET_WAS_SECOND_SOURCE = {('TRUE' if et_second else 'FALSE')}
                    WHERE CANDIDATE_ID = {sql_str(cid)}
                """).collect()

                # Seed the agent-owned ledgers so the new trend is immediately
                # visible via V_TREND_LIFECYCLE_CURRENT and V_TREND_ENRICHMENT_CURRENT.
                # Both seeds are inside the same transaction as the FCT_TRENDS
                # insert — a failure here rolls back the whole promotion.
                seed_lifecycle_v0(session, new_tid)
                seed_enrichment_v0(session, new_tid)

                session.sql("COMMIT").collect()
                results.append({'candidate_id': cid, 'decision': 'PROMOTE_NEW',
                                'target_trend_id': new_tid, 'status': 'ok'})

            elif decision == 'MERGE_INTO_EXISTING':
                # Validate target exists in FCT_TRENDS, then run the shared
                # merge body. Heat index intentionally NOT touched here —
                # the lifecycle agent owns heat recomputation per its own cadence.
                if not target:
                    raise ValueError('target_trend_id required for MERGE_INTO_EXISTING')
                check = session.sql(f"""
                    SELECT COUNT(*) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS
                    WHERE TREND_ID = {sql_str(target)}
                """).collect()
                if not check or int(check[0][0]) == 0:
                    raise ValueError(f'target_trend_id {target} not found in FCT_TRENDS')

                apply_merge_into_existing(session, cid, target, chain_id)

                audit_row['target_trend_id'] = target
                session.sql("COMMIT").collect()
                results.append({'candidate_id': cid, 'decision': 'MERGE_INTO_EXISTING',
                                'target_trend_id': target, 'status': 'ok'})

            elif decision == 'MERGE_INTO_CANDIDATE':
                # Look up the leader's outcome and act accordingly:
                #   - leader promoted (PROMOTED_TO set)  → MERGE_INTO_EXISTING into that trend_id
                #   - leader rejected                     → mirror REJECT on this candidate
                #   - leader deferred                     → mirror DEFER on this candidate
                #   - leader has no outcome               → topo-sort failed; surface as error
                if not target_cid:
                    raise ValueError('target_candidate_id required for MERGE_INTO_CANDIDATE')

                leader = lookup_leader_outcome(session, target_cid)
                if leader is None:
                    raise ValueError(f'target_candidate_id {target_cid} not found in STG_TREND_CANDIDATES')

                if leader['promoted_to']:
                    leader_tid = leader['promoted_to']
                    apply_merge_into_existing(session, cid, leader_tid, chain_id)
                    audit_row['target_trend_id'] = leader_tid
                    audit_row['decision_category'] = cat or 'INTRA_BATCH_DUPE'
                    session.sql("COMMIT").collect()
                    results.append({'candidate_id': cid, 'decision': 'MERGE_INTO_CANDIDATE',
                                    'target_candidate_id': target_cid,
                                    'target_trend_id': leader_tid, 'status': 'ok'})

                elif leader['rejected_at']:
                    mirrored_reason = f"leader_{target_cid}_rejected: {(leader['rejection_reason'] or '')[:160]}"
                    session.sql(f"""
                        UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
                        SET REJECTED_AT = CURRENT_TIMESTAMP(),
                            REJECTION_REASON = {sql_str(mirrored_reason[:200])},
                            PROMOTION_DECIDED_BY = {sql_str(chain_id)}
                        WHERE CANDIDATE_ID = {sql_str(cid)}
                    """).collect()
                    session.sql("COMMIT").collect()
                    results.append({'candidate_id': cid, 'decision': 'MERGE_INTO_CANDIDATE',
                                    'target_candidate_id': target_cid,
                                    'mirrored_outcome': 'REJECT', 'status': 'ok'})

                elif leader['deferred_until']:
                    mirrored_reason = f"leader_{target_cid}_deferred: {(leader['defer_reason'] or '')[:160]}"
                    session.sql(f"""
                        UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
                        SET DEFERRED_UNTIL = DATEADD(hour, 48, CURRENT_TIMESTAMP()),
                            DEFER_REASON = {sql_str(mirrored_reason[:200])},
                            PROMOTION_DECIDED_BY = {sql_str(chain_id)}
                        WHERE CANDIDATE_ID = {sql_str(cid)}
                    """).collect()
                    session.sql("COMMIT").collect()
                    results.append({'candidate_id': cid, 'decision': 'MERGE_INTO_CANDIDATE',
                                    'target_candidate_id': target_cid,
                                    'mirrored_outcome': 'DEFER', 'status': 'ok'})

                else:
                    raise ValueError(
                        f'leader candidate {target_cid} has no decided outcome '
                        '(topo-sort should have processed it first)'
                    )

            elif decision == 'REJECT':
                # Mark candidate rejected. AGENT_SESSION_ID stamps on the
                # supporting signals are intentionally preserved — they let
                # the daily revisit workflow find these signals via "stamped
                # but no candidate has PROMOTED_TO" and give them a second
                # look against signals from later main-run sessions.
                # ET record captured on reject too (an ET-rescue candidate whose
                # ET verify missed / was sub-volume) for lift measurement.
                session.sql(f"""
                    UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
                    SET REJECTED_AT = CURRENT_TIMESTAMP(),
                        REJECTION_REASON = {sql_str((rej_reason or 'UNSPECIFIED')[:200])},
                        PROMOTION_DECIDED_BY = {sql_str(chain_id)},
                        ET_CORROBORATION = {sql_json(et_corr)},
                        ET_WAS_SECOND_SOURCE = {('TRUE' if et_second else 'FALSE')}
                    WHERE CANDIDATE_ID = {sql_str(cid)}
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
        'applied_count':         sum(1 for r in results if r['status'] == 'ok'),
        'promote_count':         sum(1 for r in results if r['status'] == 'ok' and r['decision'] == 'PROMOTE_NEW'),
        'merge_count':           sum(1 for r in results if r['status'] == 'ok' and r['decision'] == 'MERGE_INTO_EXISTING'),
        'merge_candidate_count': sum(1 for r in results if r['status'] == 'ok' and r['decision'] == 'MERGE_INTO_CANDIDATE'),
        'reject_count':          sum(1 for r in results if r['status'] == 'ok' and (r['decision'] == 'REJECT' or r.get('mirrored_outcome') == 'REJECT')),
        'defer_count':           sum(1 for r in results if r['status'] == 'ok' and (r['decision'] == 'DEFER' or r.get('mirrored_outcome') == 'DEFER')),
        'error_count':           sum(1 for r in results if r['status'] == 'error'),
        'rejected_count':        sum(1 for r in results if r['status'] == 'rejected'),
        'results':               results,
    }
$$;
