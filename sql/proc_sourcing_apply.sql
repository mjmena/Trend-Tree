-- Procedure: Atomic apply for the sourcing pass (CRMA-774, epic CRMA-772
-- "Trend-to-product sourcing"). Mirrors sql/proc_enrichment_apply.sql's
-- shape (validation-first, VARIANT receipt instead of raising) but also
-- owns the run's lifecycle across two calls, because a sourcing run has a
-- 'running' header at start and only reaches its terminal state after the
-- ecomm agent has actually done the retrieval + selector work:
--
--   1. MODE='open'     — called once at run start, before retrieval. Writes
--                         a FCT_TREND_SOURCING_LEDGER row with STATUS='running'
--                         and returns the generated SOURCING_RUN_ID. This is
--                         the run-level config (threshold, model, versions)
--                         known before any candidate is looked at.
--   2. MODE='complete' — called once after the selector has emitted (or the
--                         run has errored), referencing the SOURCING_RUN_ID
--                         from step 1. Completes the SAME header row to a
--                         terminal STATUS and — for STATUS='matched' only —
--                         appends the candidate rows in the same transaction
--                         as the header update, so a run is never left with
--                         a terminal header but partial/missing candidates.
--
-- Two calls on one proc (not two procs) so callers import a single
-- interface, matching this repo's one-proc-per-write-path convention
-- (PROC_ENRICHMENT_APPLY, PROC_PROMOTION_APPLY). The open/complete split
-- itself is a deliberate deviation from PROC_ENRICHMENT_APPLY's single-call
-- shape: enrichment has no interim state to record, sourcing's whole reason
-- for existing is to make a run visible as 'running' the moment it starts
-- (so a crash mid-run is visibly stuck, not silently absent) — see
-- fct_trend_sourcing_ledger.sql's in-flight-guard note. The proc does not
-- itself dedupe concurrent 'running' headers for the same (TREND_ID, TIER)
-- or expire stale ones — that in-flight guard is the ecomm agent's poll
-- condition (docs/prd/trend-to-product-sourcing.md), out of scope here.
--
-- STATUS-specific validation on MODE='complete' (all enforced BEFORE any
-- write — an invalid payload writes nothing):
--   matched   — CANDIDATES required, non-empty, >=1 row with SELECTED=TRUE;
--               every row needs CATALOG_PRODUCT_ID + numeric SEMANTIC_SCORE
--               + boolean SELECTED; SELECTED=TRUE rows need REASONED_FIT in
--               {strong,partial,weak}; SELECTED=FALSE rows need NULL
--               REASONED_FIT (the selector's emit tool only grades picks —
--               see fct_trend_sourcing_candidates.sql).
--   no_match  — SELECTOR_NOTE required; CANDIDATES must be empty — the
--               ledger's "processed, nothing matched" precedent is zero
--               candidate rows, not a shown-but-all-rejected pool.
--   failed    — ERROR_MESSAGE required; CANDIDATES must be empty.
--
-- CANDIDATE_COUNT / SELECTED_COUNT written on the header: the actual counts
-- for 'matched', 0/0 for 'no_match' (we know the pool was empty), NULL/NULL
-- for 'failed' (we may not have gotten far enough to know).
--
-- Returns a VARIANT receipt: {'applied': false, 'error': '...'} on any
-- invalid input (nothing written), or {'applied': true, 'mode': ...,
-- 'sourcing_run_id': ..., ...} on success.
--
-- Usage:
--   CALL PROC_SOURCING_APPLY('open', NULL, 'trend-uuid', 'shopify',
--       0.40, 'gemini-3.7-flash', 'v1', 'v1', 'sess-abc123',
--       NULL, NULL, NULL, NULL);
--   -- ... ecomm agent runs retrieval + selector ...
--   CALL PROC_SOURCING_APPLY('complete', 'run-uuid-from-open', NULL, NULL,
--       NULL, NULL, NULL, NULL, NULL,
--       'matched', NULL, 'strong seasonal overlap',
--       PARSE_JSON('[{"catalog_product_id": "...", "semantic_score": 0.71,
--                     "selected": true, "reasoned_fit": "strong", ...}, ...]'));

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_SOURCING_APPLY(
    MODE                 VARCHAR,
    SOURCING_RUN_ID      VARCHAR,
    TREND_ID             VARCHAR,
    TIER                 VARCHAR,
    SEMANTIC_THRESHOLD   FLOAT,
    MODEL_USED           VARCHAR,
    EMBED_DOC_VERSION    VARCHAR,
    COMPUTATION_VERSION  VARCHAR,
    AGENT_SESSION_ID     VARCHAR,
    STATUS               VARCHAR,
    ERROR_MESSAGE        VARCHAR,
    SELECTOR_NOTE        VARCHAR,
    CANDIDATES           VARIANT
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

ALLOWED_MODES = {'open', 'complete'}
ALLOWED_STATUSES = {'matched', 'no_match', 'failed'}
ALLOWED_FIT = {'strong', 'partial', 'weak'}


def sql_str(s):
    if s is None or s == '':
        return 'NULL'
    return "'" + str(s).replace("\\", "\\\\").replace("'", "''") + "'"


def sql_num(n):
    if n is None:
        return 'NULL'
    try:
        return str(float(n))
    except (TypeError, ValueError):
        return 'NULL'


def sql_bool(b):
    if b is None:
        return 'NULL'
    return 'TRUE' if b else 'FALSE'


def sql_json(obj):
    if obj is None:
        return 'NULL'
    return "PARSE_JSON('" + json.dumps(obj).replace("\\", "\\\\").replace("'", "''") + "')"


def is_sql_null(v):
    """True for both Python None and Snowpark's sqlNullWrapper — a SQL NULL
    passed positionally for a VARIANT parameter arrives as the latter, not
    None (unlike scalar-typed params). Detected by class name rather than
    import, since sqlNullWrapper is an internal Snowpark type not part of
    the public API."""
    return v is None or type(v).__name__ == 'sqlNullWrapper'


def run(session, MODE, SOURCING_RUN_ID, TREND_ID, TIER, SEMANTIC_THRESHOLD,
        MODEL_USED, EMBED_DOC_VERSION, COMPUTATION_VERSION, AGENT_SESSION_ID,
        STATUS, ERROR_MESSAGE, SELECTOR_NOTE, CANDIDATES):

    mode = (MODE or '').lower()
    if mode not in ALLOWED_MODES:
        return {'applied': False, 'error': f'unknown mode: {MODE!r} (expected open|complete)'}

    # -----------------------------------------------------------------
    # MODE = 'open' — write the running header, return its SOURCING_RUN_ID.
    # -----------------------------------------------------------------
    if mode == 'open':
        if not TREND_ID:
            return {'applied': False, 'error': 'TREND_ID required for open'}
        if not TIER:
            return {'applied': False, 'error': 'TIER required for open'}

        # SOURCING_RUN_ID is always server-generated on open (mirrors
        # PROC_PROMOTION_APPLY's PROMOTE_NEW: UUID_STRING() then look up —
        # never trust a caller-supplied primary key). Any SOURCING_RUN_ID
        # the caller passed in is ignored in this mode.
        session.sql(f"""
            INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER (
                SOURCING_RUN_ID, TREND_ID, TIER, STARTED_AT, STATUS,
                SEMANTIC_THRESHOLD, MODEL_USED, EMBED_DOC_VERSION,
                COMPUTATION_VERSION, AGENT_SESSION_ID
            )
            SELECT
                UUID_STRING(),
                {sql_str(TREND_ID)}, {sql_str(TIER)},
                CURRENT_TIMESTAMP(), 'running',
                {sql_num(SEMANTIC_THRESHOLD)}, {sql_str(MODEL_USED)},
                {sql_str(EMBED_DOC_VERSION)}, {sql_str(COMPUTATION_VERSION)},
                {sql_str(AGENT_SESSION_ID)}
        """).collect()

        rs = session.sql(f"""
            SELECT SOURCING_RUN_ID
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
            WHERE TREND_ID = {sql_str(TREND_ID)}
              AND TIER = {sql_str(TIER)}
              AND STATUS = 'running'
            ORDER BY STARTED_AT DESC
            LIMIT 1
        """).collect()
        new_run_id = rs[0][0] if rs else None

        return {
            'applied':         True,
            'mode':            'open',
            'sourcing_run_id': new_run_id,
            'trend_id':        TREND_ID,
            'tier':            TIER,
            'status':          'running',
        }

    # -----------------------------------------------------------------
    # MODE = 'complete' — validate fully, then complete the header (+
    # candidate rows for 'matched') atomically.
    # -----------------------------------------------------------------
    if not SOURCING_RUN_ID:
        return {'applied': False, 'error': 'SOURCING_RUN_ID required for complete'}

    status = (STATUS or '').lower()
    if status not in ALLOWED_STATUSES:
        return {'applied': False, 'error': f'unknown status: {STATUS!r} (expected matched|no_match|failed)'}

    hdr = session.sql(f"""
        SELECT TREND_ID, TIER
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
        WHERE SOURCING_RUN_ID = {sql_str(SOURCING_RUN_ID)}
          AND STATUS = 'running'
    """).collect()
    if not hdr:
        return {'applied': False,
                'error': f'no running header found for sourcing_run_id {SOURCING_RUN_ID}'}
    header_trend_id, header_tier = hdr[0][0], hdr[0][1]

    candidates = CANDIDATES
    if is_sql_null(candidates):
        candidates = []
    elif isinstance(candidates, str):
        try:
            candidates = json.loads(candidates) if candidates else []
        except (ValueError, TypeError):
            return {'applied': False, 'error': 'CANDIDATES is not valid JSON'}
    if not isinstance(candidates, list):
        return {'applied': False, 'error': 'CANDIDATES must be a JSON array'}

    if status == 'failed':
        if not ERROR_MESSAGE:
            return {'applied': False, 'error': 'ERROR_MESSAGE required when STATUS=failed'}
        if candidates:
            return {'applied': False, 'error': 'a failed completion must not carry candidates'}

    if status == 'no_match':
        if not SELECTOR_NOTE:
            return {'applied': False, 'error': 'SELECTOR_NOTE required when STATUS=no_match'}
        if candidates:
            return {'applied': False,
                    'error': 'a no_match completion must carry zero candidate rows'}

    validated = []
    if status == 'matched':
        if not candidates:
            return {'applied': False, 'error': 'a matched completion requires at least one candidate'}
        for i, c in enumerate(candidates):
            if not isinstance(c, dict):
                return {'applied': False, 'error': f'candidates[{i}] must be an object'}
            if not c.get('catalog_product_id'):
                return {'applied': False, 'error': f'candidates[{i}] missing catalog_product_id'}
            score = c.get('semantic_score')
            if score is None:
                return {'applied': False, 'error': f'candidates[{i}] missing semantic_score'}
            try:
                float(score)
            except (TypeError, ValueError):
                return {'applied': False, 'error': f'candidates[{i}] semantic_score is not numeric'}
            selected = c.get('selected')
            if not isinstance(selected, bool):
                return {'applied': False, 'error': f'candidates[{i}] selected must be a boolean'}
            fit = c.get('reasoned_fit')
            if selected:
                if fit not in ALLOWED_FIT:
                    return {'applied': False,
                            'error': f'candidates[{i}] selected=true requires reasoned_fit in strong|partial|weak'}
            else:
                if fit is not None:
                    return {'applied': False,
                            'error': f'candidates[{i}] selected=false requires reasoned_fit to be NULL'}
            validated.append(c)

        if not any(c.get('selected') for c in validated):
            return {'applied': False,
                    'error': 'a matched completion requires at least one selected candidate'}

    # ---- All validation passed. Apply atomically. ----
    if status == 'matched':
        candidate_count_sql = str(len(validated))
        selected_count_sql = str(sum(1 for c in validated if c.get('selected')))
    elif status == 'no_match':
        candidate_count_sql = '0'
        selected_count_sql = '0'
    else:  # failed
        candidate_count_sql = 'NULL'
        selected_count_sql = 'NULL'

    try:
        session.sql("BEGIN").collect()

        session.sql(f"""
            UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_LEDGER
            SET COMPLETED_AT    = CURRENT_TIMESTAMP(),
                STATUS          = {sql_str(status)},
                ERROR_MESSAGE   = {sql_str(ERROR_MESSAGE)},
                SELECTOR_NOTE   = {sql_str(SELECTOR_NOTE)},
                CANDIDATE_COUNT = {candidate_count_sql},
                SELECTED_COUNT  = {selected_count_sql}
            WHERE SOURCING_RUN_ID = {sql_str(SOURCING_RUN_ID)}
              AND STATUS = 'running'
        """).collect()

        for c in validated:
            session.sql(f"""
                INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCING_CANDIDATES (
                    SOURCING_CANDIDATE_ID, SOURCING_RUN_ID, TREND_ID, TIER,
                    CATALOG_PRODUCT_ID, PRODUCT_HANDLE, PRODUCT_TITLE, PRODUCT_TYPE, VENDOR,
                    PRODUCT_URL, PRICE_AT_MATCH, IMAGE_URL_AT_MATCH, AVAILABLE_AT_MATCH,
                    SEMANTIC_SCORE, REASONED_FIT, REASONED_FIT_RATIONALE, SELECTED,
                    CATALOG_PAYLOAD, CREATED_AT
                )
                SELECT
                    UUID_STRING(), {sql_str(SOURCING_RUN_ID)},
                    {sql_str(header_trend_id)}, {sql_str(header_tier)},
                    {sql_str(c.get('catalog_product_id'))}, {sql_str(c.get('product_handle'))},
                    {sql_str(c.get('product_title'))}, {sql_str(c.get('product_type'))},
                    {sql_str(c.get('vendor'))}, {sql_str(c.get('product_url'))},
                    {sql_num(c.get('price_at_match'))}, {sql_str(c.get('image_url_at_match'))},
                    {sql_bool(c.get('available_at_match'))},
                    {sql_num(c.get('semantic_score'))}, {sql_str(c.get('reasoned_fit'))},
                    {sql_str(c.get('reasoned_fit_rationale'))}, {sql_bool(c.get('selected'))},
                    {sql_json(c.get('catalog_payload'))}, CURRENT_TIMESTAMP()
            """).collect()

        session.sql("COMMIT").collect()
    except Exception as e:
        try:
            session.sql("ROLLBACK").collect()
        except Exception:
            pass
        return {'applied': False, 'error': f'write failed: {str(e)[:500]}'}

    return {
        'applied':         True,
        'mode':            'complete',
        'sourcing_run_id': SOURCING_RUN_ID,
        'trend_id':        header_trend_id,
        'tier':             header_tier,
        'status':          status,
        'candidate_count': len(validated) if status == 'matched' else (0 if status == 'no_match' else None),
        'selected_count':  (sum(1 for c in validated if c.get('selected')) if status == 'matched'
                            else (0 if status == 'no_match' else None)),
    }
$$;
