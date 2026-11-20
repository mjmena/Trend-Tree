CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_CONTROL (
    LOCK_ID INTEGER NOT NULL, REVISION INTEGER NOT NULL,
    ENABLED_AT_UTC TIMESTAMP_NTZ, FORWARD_THROUGH_UTC TIMESTAMP_NTZ, RETRY_AT_UTC TIMESTAMP_NTZ
);
INSERT INTO MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_CONTROL (LOCK_ID,REVISION)
SELECT 1,0 WHERE NOT EXISTS (SELECT 1 FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_CONTROL);

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_RUNS (
    WINDOW_ID VARCHAR NOT NULL, ORIGIN VARCHAR NOT NULL, FROM_UTC TIMESTAMP_NTZ NOT NULL, TO_UTC TIMESTAMP_NTZ NOT NULL,
    STARTED_AT_UTC TIMESTAMP_NTZ NOT NULL, LAST_PAGE_AT_UTC TIMESTAMP_NTZ, COMPLETED_AT_UTC TIMESTAMP_NTZ,
    NEXT_CURSOR VARCHAR, PAGES_COMMITTED INTEGER DEFAULT 0, ACCEPTED_ROWS INTEGER DEFAULT 0,
    NEW_SIGNALS INTEGER DEFAULT 0, REPEAT_SIGHTINGS INTEGER DEFAULT 0, SYNDICATED_COPIES INTEGER DEFAULT 0,
    UNUSABLE_RECORDS INTEGER DEFAULT 0
);
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_RUNS ADD COLUMN IF NOT EXISTS FETCH_TOKEN VARCHAR;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_RUNS ADD COLUMN IF NOT EXISTS FETCH_EXECUTION VARCHAR;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_RUNS ADD COLUMN IF NOT EXISTS FETCH_ATTEMPT INTEGER;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_RUNS ADD COLUMN IF NOT EXISTS FETCH_LEASE_UNTIL_UTC TIMESTAMP_NTZ;
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_PAGES (
    WINDOW_ID VARCHAR NOT NULL, PAGE_NUMBER INTEGER NOT NULL, CURSOR_IN VARCHAR, NEXT_CURSOR VARCHAR,
    OBSERVED_AT_UTC TIMESTAMP_NTZ NOT NULL, ARTICLES VARIANT NOT NULL, COMMITTED_AT_UTC TIMESTAMP_NTZ, COUNTS VARIANT
);
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_DETAILS (
    WINDOW_ID VARCHAR NOT NULL, PAGE_NUMBER INTEGER NOT NULL, PROVIDER_ID VARCHAR NOT NULL,
    VERIFIED_AT_UTC TIMESTAMP_NTZ NOT NULL, RELEASE_PROOF VARIANT
);
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_EXECUTIONS (
    EXECUTION_ID VARCHAR NOT NULL, TASK_ATTEMPT VARCHAR NOT NULL, WINDOW_ID VARCHAR, ORIGIN VARCHAR NOT NULL,
    STARTED_AT_UTC TIMESTAMP_NTZ NOT NULL, FINISHED_AT_UTC TIMESTAMP_NTZ, OUTCOME VARCHAR NOT NULL
);

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.TREND_HUNTER_INTAKE(EVENT_JSON VARCHAR)
COPY GRANTS
RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS CALLER AS
$$
const e = JSON.parse(EVENT_JSON);
const prefix = 'MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_';
const control = prefix+'CONTROL', runs = prefix+'RUNS', pages = prefix+'PAGES', executions = prefix+'EXECUTIONS';
const utcNow = "CONVERT_TIMEZONE('UTC',CURRENT_TIMESTAMP())::TIMESTAMP_NTZ";
function iso(column) { return "TO_VARCHAR("+column+",'YYYY-MM-DD\"T\"HH24:MI:SS.FF3\"Z\"')"; }
function execute(sqlText, binds) {
    return snowflake.createStatement({sqlText:sqlText,binds:binds || []}).execute();
}
function value(sqlText, binds) {
    const result = execute(sqlText,binds);
    return result.next() ? result.getColumnValue(1) : null;
}
function state(id) {
    if (!id) return {id:null,complete:true};
    const result = value(`SELECT OBJECT_CONSTRUCT_KEEP_NULL(
        'id',r.WINDOW_ID,'origin',r.ORIGIN,'from',${iso('r.FROM_UTC')},'to',${iso('r.TO_UTC')},
        'page_number',r.PAGES_COMMITTED,'cursor',r.NEXT_CURSOR,'complete',r.COMPLETED_AT_UTC IS NOT NULL,
        'counts',OBJECT_CONSTRUCT('accepted_rows',r.ACCEPTED_ROWS,'new_signals',r.NEW_SIGNALS,
            'repeat_sightings',r.REPEAT_SIGHTINGS,'syndicated_copies',r.SYNDICATED_COPIES,'unusable_records',r.UNUSABLE_RECORDS),
        'receipt',IFF(p.WINDOW_ID IS NULL,NULL,OBJECT_CONSTRUCT_KEEP_NULL('data',p.ARTICLES,'observed',${iso('p.OBSERVED_AT_UTC')},'next_cursor',p.NEXT_CURSOR)))
        FROM ${runs} r LEFT JOIN ${pages} p ON p.WINDOW_ID=r.WINDOW_ID AND p.PAGE_NUMBER=r.PAGES_COMMITTED
        WHERE r.WINDOW_ID=?`,[id]);
    if (!result) throw new Error('Unknown article window');
    return result;
}
function openWindow() {
    const prior = value(`SELECT OBJECT_CONSTRUCT_KEEP_NULL('id',WINDOW_ID) FROM ${executions}
        WHERE EXECUTION_ID=? ORDER BY STARTED_AT_UTC LIMIT 1`,[e.execution]);
    if (prior) return prior.id;
    const settings = value(`SELECT OBJECT_CONSTRUCT_KEEP_NULL('enabled',${iso('ENABLED_AT_UTC')},
        'through',${iso('FORWARD_THROUGH_UTC')}) FROM ${control} WHERE LOCK_ID=1`);
    if (!settings.enabled || !settings.through) throw new Error('Article intake has no enablement checkpoint');
    const time = new Date(e.now).getTime(), day = 86400000;
    let from, to;
    if (e.origin === 'replay') {
        from=e.from; to=e.to;
        if (!from || !to || !(Date.parse(from)<Date.parse(to)) || Date.parse(to)>time || Date.parse(to)-Date.parse(from)>7*day)
            throw new Error('Replay needs an increasing past window of at most seven days');
    } else if (e.origin === 'forward' || e.origin === 'reconcile') {
        const step=e.origin==='forward' ? 3600000 : day;
        to=new Date(Math.floor(time/step)*step).toISOString();
        from=e.origin==='forward' ? settings.through : new Date(Math.max(Date.parse(settings.enabled),Date.parse(to)-7*day)).toISOString();
    } else throw new Error('Unknown intake origin');
    const active = value(`SELECT WINDOW_ID FROM ${runs} WHERE ORIGIN=? AND COMPLETED_AT_UTC IS NULL
        AND (? != 'replay' OR (FROM_UTC=?::TIMESTAMP_NTZ AND TO_UTC=?::TIMESTAMP_NTZ))
        ORDER BY STARTED_AT_UTC LIMIT 1`,[e.origin,e.origin,from,to]);
    if (active) return active;
    if (Date.parse(from)>=Date.parse(to)) return null;
    if (e.origin === 'reconcile') {
        const previous=value(`SELECT WINDOW_ID FROM ${runs} WHERE ORIGIN='reconcile' AND TO_UTC=?::TIMESTAMP_NTZ LIMIT 1`,[to]);
        if (previous) return previous;
    }
    execute(`INSERT INTO ${runs} (WINDOW_ID,ORIGIN,FROM_UTC,TO_UTC,STARTED_AT_UTC)
        SELECT ?,?,?::TIMESTAMP_NTZ,?::TIMESTAMP_NTZ,${utcNow}`,[e.execution,e.origin,from,to]);
    return e.execution;
}
function releaseClaim() {
    execute(`UPDATE ${runs} SET FETCH_TOKEN=NULL,FETCH_EXECUTION=NULL,FETCH_ATTEMPT=NULL,FETCH_LEASE_UNTIL_UTC=NULL
        WHERE WINDOW_ID=? AND FETCH_TOKEN=?`,[e.id,e.token]);
}
function claim(s) {
    if (s.receipt) return s;
    if (!e.token) throw new Error('Missing page claim token');
    const acquired = value(`UPDATE ${runs} SET FETCH_TOKEN=?,FETCH_EXECUTION=?,FETCH_ATTEMPT=?::INTEGER,
            FETCH_LEASE_UNTIL_UTC=DATEADD(minute,3,${utcNow})
        WHERE WINDOW_ID=? AND (FETCH_TOKEN IS NULL OR FETCH_TOKEN=? OR FETCH_LEASE_UNTIL_UTC<=${utcNow}
            OR (FETCH_EXECUTION=? AND FETCH_ATTEMPT<?::INTEGER))
          AND NOT EXISTS (SELECT 1 FROM ${executions} WHERE EXECUTION_ID=? AND TRY_TO_NUMBER(TASK_ATTEMPT)>?::INTEGER)`,
        [e.token,e.execution,e.attempt,s.id,e.token,e.execution,e.attempt,e.execution,e.attempt]);
    return Object.assign(s, acquired===1 ? {claimed:true} : {busy:true});
}
function receive(s) {
    if (s.receipt) return s;
    if (!e.token) throw new Error('Missing page claim token');
    if (!value(`SELECT COUNT(*) FROM ${runs} WHERE WINDOW_ID=? AND FETCH_TOKEN=?`,[s.id,e.token]))
        return Object.assign(s,{busy:true});
    if (!Array.isArray(e.data) || !(e.next_cursor === null || (typeof e.next_cursor === 'string' && e.next_cursor)))
        throw new Error('Invalid provider page');
    if (e.next_cursor !== null && (e.next_cursor === s.cursor || value(
        `SELECT COUNT(*) FROM ${pages} WHERE WINDOW_ID=? AND CURSOR_IN=?`,[s.id,e.next_cursor])>0))
        throw new Error('Repeated article page cursor');
    execute(`INSERT INTO ${pages} (WINDOW_ID,PAGE_NUMBER,CURSOR_IN,NEXT_CURSOR,OBSERVED_AT_UTC,ARTICLES)
        SELECT ?,?,?,?,?::TIMESTAMP_NTZ,PARSE_JSON(?)`,[s.id,s.page_number,s.cursor,e.next_cursor,e.observed,JSON.stringify(e.data)]);
    releaseClaim();
    return state(s.id);
}
function commitPage(s) {
    if (!s.receipt) throw new Error('No durable article page');
    const counts={accepted_rows:e.accepted,new_signals:0,repeat_sightings:0,syndicated_copies:0,unusable_records:0};
    if (e.signals.length) {
        const merged=value("CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(?, '', 500, 'STG_EXTERNAL_SIGNALS')",[JSON.stringify(e.signals)]);
        if (!merged || !merged.article_counts || merged.error) throw new Error('Article signal merge failed');
        Object.assign(counts,merged.article_counts);
    }
    const next=s.receipt.next_cursor;
    execute(`UPDATE ${pages} SET COMMITTED_AT_UTC=${utcNow},COUNTS=PARSE_JSON(?) WHERE WINDOW_ID=? AND PAGE_NUMBER=?`,
        [JSON.stringify(counts),s.id,s.page_number]);
    execute(`UPDATE ${runs} SET NEXT_CURSOR=?,PAGES_COMMITTED=PAGES_COMMITTED+1,
        ACCEPTED_ROWS=ACCEPTED_ROWS+?,NEW_SIGNALS=NEW_SIGNALS+?,REPEAT_SIGHTINGS=REPEAT_SIGHTINGS+?,
        SYNDICATED_COPIES=SYNDICATED_COPIES+?,UNUSABLE_RECORDS=UNUSABLE_RECORDS+?,LAST_PAGE_AT_UTC=${utcNow},
        COMPLETED_AT_UTC=IFF(?=1,${utcNow},NULL) WHERE WINDOW_ID=?`,
        [next,counts.accepted_rows,counts.new_signals,counts.repeat_sightings,counts.syndicated_copies,counts.unusable_records,next===null?1:0,s.id]);
    if (next===null && s.origin==='forward') {
        const advanced=value(`UPDATE ${control} SET FORWARD_THROUGH_UTC=?::TIMESTAMP_NTZ
            WHERE LOCK_ID=1 AND FORWARD_THROUGH_UTC=?::TIMESTAMP_NTZ`,[s.to,s.from]);
        if (advanced!==1) throw new Error('Forward checkpoint changed during the window');
    }
}
function proof() {
    return value(`SELECT OBJECT_CONSTRUCT_KEEP_NULL('found',TRUE,'proof',RELEASE_PROOF) FROM ${prefix}DETAILS
        WHERE WINDOW_ID=? AND PAGE_NUMBER=? AND PROVIDER_ID=?`,[e.id,e.page_number,e.provider_id]) || {found:false};
}
function apply() {
    if (e.action==='save_proof') {
        const previous=proof();
        if (previous.found) return previous;
        execute(`INSERT INTO ${prefix}DETAILS (WINDOW_ID,PAGE_NUMBER,PROVIDER_ID,VERIFIED_AT_UTC,RELEASE_PROOF)
            SELECT ?,?,?,${utcNow},PARSE_JSON(?)`,[e.id,e.page_number,e.provider_id,JSON.stringify(e.proof)]);
        return {found:true,proof:e.proof};
    }
    if (e.action==='open') {
        const id=openWindow();
        if (e.origin==='forward') execute('CALL MCC_RAW.MARKETING_DEV.CAPTURE_ARTICLE_CANDIDATE_BIRTHS()');
        execute(`MERGE INTO ${executions} t USING (SELECT ? id, ? attempt) s
            ON t.EXECUTION_ID=s.id AND t.TASK_ATTEMPT=s.attempt
            WHEN NOT MATCHED THEN INSERT (EXECUTION_ID,TASK_ATTEMPT,WINDOW_ID,ORIGIN,STARTED_AT_UTC,OUTCOME)
            VALUES(s.id,s.attempt,?,?,${utcNow},'running')`,[e.execution,e.attempt,id,e.origin]);
        return state(id);
    }
    if (e.action==='finish') {
        if (e.id && e.token) releaseClaim();
        execute(`UPDATE ${executions} SET OUTCOME=?,FINISHED_AT_UTC=${utcNow} WHERE EXECUTION_ID=? AND TASK_ATTEMPT=?`,
            [e.outcome,e.execution,e.attempt]);
        return {};
    }
    if (e.action==='cooldown') {
        execute(`UPDATE ${control} SET RETRY_AT_UTC=GREATEST_IGNORE_NULLS(RETRY_AT_UTC,?::TIMESTAMP_NTZ) WHERE LOCK_ID=1`,[e.retry_at]);
        return {};
    }
    const s=state(e.id);
    if (s.complete || s.page_number!==e.page_number) return s;
    if (e.action==='claim') return claim(s);
    if (e.action==='receive') return receive(s);
    if (e.action==='commit') commitPage(s);
    else throw new Error('Unknown intake action');
    return state(e.id);
}
if (e.action==='proof') return proof();
if (e.action==='gate') return {retry_at:value(`SELECT ${iso('RETRY_AT_UTC')} FROM ${control} WHERE LOCK_ID=1`)};
execute('BEGIN TRANSACTION');
try {
    if (value(`UPDATE ${control} SET REVISION=REVISION+1 WHERE LOCK_ID=1`)!==1) throw new Error('Missing article intake control');
    const result=apply();
    execute('COMMIT');
    return result;
} catch (error) {
    execute('ROLLBACK');
    throw error;
}
$$;
