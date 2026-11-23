CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_ARTICLE_MUTEX (
    LOCK_ID INTEGER NOT NULL, REVISION INTEGER NOT NULL
);
INSERT INTO MCC_RAW.MARKETING_DEV.STG_ARTICLE_MUTEX
SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM MCC_RAW.MARKETING_DEV.STG_ARTICLE_MUTEX);

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_ARTICLE_EVIDENCE_KEYS (
    EVIDENCE_KEY VARCHAR NOT NULL, SIGNAL_ID VARCHAR NOT NULL, CANONICAL_URL VARCHAR NOT NULL,
    OWNER_AT_UTC TIMESTAMP_NTZ NOT NULL, HAS_TREND_HUNTER BOOLEAN NOT NULL
);
CREATE TABLE IF NOT EXISTS MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES (
    SIGNAL_ID VARCHAR NOT NULL, CREDITED_SIGNAL_ID VARCHAR NOT NULL, CREDITED_URL VARCHAR NOT NULL,
    CREDITED_OWNER_AT_UTC TIMESTAMP_NTZ NOT NULL, VERIFIED_AT_UTC TIMESTAMP_NTZ NOT NULL
);
CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_TREND_SIGNAL_EVIDENCE COPY GRANTS AS
SELECT l.TREND_ID, COALESCE(a.CREDITED_SIGNAL_ID,l.SIGNAL_ID) AS SIGNAL_ID, l.LINK_KIND, l.LINK_TYPE, l.LINKED_AT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS l
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES a ON a.SIGNAL_ID=l.SIGNAL_ID
QUALIFY ROW_NUMBER() OVER (PARTITION BY l.TREND_ID,COALESCE(a.CREDITED_SIGNAL_ID,l.SIGNAL_ID),l.LINK_KIND
                           ORDER BY l.LINKED_AT,l.SIGNAL_ID)=1;

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLES (
    OBSERVATION_KEY VARCHAR NOT NULL, PROVIDER_ID VARCHAR, SIGNAL_ID VARCHAR, ORIGINAL_URL VARCHAR,
    CANONICAL_URL VARCHAR, PUBLISHER VARCHAR, FEED_LABEL VARCHAR, STATUS VARCHAR, VERDICT VARCHAR,
    HEADLINE VARCHAR, SUMMARY VARCHAR, FIRST_SEEN_UTC TIMESTAMP_NTZ, PUBLISHED_AT_UTC TIMESTAMP_NTZ,
    FIRST_OBSERVED_AT_UTC TIMESTAMP_NTZ NOT NULL, ORIGIN VARCHAR NOT NULL, DISPOSITION VARCHAR NOT NULL,
    REASON VARCHAR, RELEASE_PROOF VARIANT
);
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS (
    SOURCE_NAME VARCHAR NOT NULL, NATIVE_SIGNAL_ID VARCHAR NOT NULL, SIGNAL_ID VARCHAR NOT NULL,
    ORIGINAL_URL VARCHAR NOT NULL, CANONICAL_URL VARCHAR NOT NULL, OBSERVED_AT_UTC TIMESTAMP_NTZ NOT NULL
);

ALTER TABLE MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS ADD COLUMN IF NOT EXISTS BATCH_ID VARCHAR;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS ADD COLUMN IF NOT EXISTS INPUT_INDEX INTEGER;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS ADD COLUMN IF NOT EXISTS MERGE_SESSION_ID VARCHAR;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS ADD COLUMN IF NOT EXISTS SIGNAL_TITLE VARCHAR;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS ADD COLUMN IF NOT EXISTS SIGNAL_TEXT VARCHAR;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS ADD COLUMN IF NOT EXISTS SIGNAL_TIMESTAMP VARCHAR;
ALTER TABLE MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS ADD COLUMN IF NOT EXISTS METADATA VARIANT;

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLE_SIGHTINGS (
    WINDOW_ID VARCHAR, PAGE_NUMBER INTEGER, INPUT_INDEX INTEGER, OBSERVATION_KEY VARCHAR NOT NULL, PROVIDER_ID VARCHAR,
    ORIGIN VARCHAR NOT NULL, OBSERVED_AT_UTC TIMESTAMP_NTZ NOT NULL, HANDLED_AT_UTC TIMESTAMP_NTZ NOT NULL,
    SIGNAL_ID VARCHAR, ORIGINAL_URL VARCHAR, CANONICAL_URL VARCHAR, PUBLISHER VARCHAR,
    HEADLINE VARCHAR, SUMMARY VARCHAR, DISPOSITION VARCHAR NOT NULL, REASON VARCHAR, RELEASE_PROOF VARIANT
);
CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.STG_ARTICLE_ALIAS_HISTORY (
    SIGNAL_ID VARCHAR NOT NULL, CREDITED_SIGNAL_ID VARCHAR NOT NULL, CREDITED_URL VARCHAR NOT NULL,
    CREDITED_OWNER_AT_UTC TIMESTAMP_NTZ NOT NULL, VERIFIED_AT_UTC TIMESTAMP_NTZ NOT NULL
);

CREATE OR REPLACE FUNCTION MCC_RAW.MARKETING_DEV.ARTICLE_EVIDENCE_IDENTITY(SIGNAL VARIANT)
COPY GRANTS
RETURNS OBJECT LANGUAGE PYTHON RUNTIME_VERSION='3.11' HANDLER='identity'
AS $$
import json
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TRACKING = {'fbclid','gclid','dclid','msclkid','mc_cid','mc_eid','ref','ref_src','ref_url','referrer',
            '_ga','_gl','_gac','yclid','wbraid','gbraid','igshid','twclid'}

def canonical(raw):
    if not isinstance(raw, str):
        return None
    try:
        u = urlsplit(raw.strip())
        host = (u.hostname or '').removeprefix('www.').rstrip('.')
        if u.scheme not in ('http','https') or not host or u.username or u.password or re.search(r'\s', host):
            return None
        if ':' in host:
            host = '[' + host + ']'
        else:
            host = host.encode('idna').decode('ascii')
        if u.port and (u.scheme, u.port) not in (('http',80),('https',443)):
            host += ':' + str(u.port)
        params = sorted((k,v) for k,v in parse_qsl(u.query, keep_blank_values=True)
                        if k.lower() not in TRACKING and not k.lower().startswith('utm_'))
        path = u.path.rstrip('/') or '/'
        return urlunsplit((u.scheme,host,path,urlencode(params),''))
    except (ValueError, UnicodeError):
        return None

def identity(signal):
    metadata = signal.get('METADATA') or {}
    if isinstance(metadata,str):
        try:
            metadata = json.loads(metadata)
        except ValueError:
            metadata = {}
    if not isinstance(metadata,dict):
        metadata = {}
    direct = signal.get('SOURCE_NAME') == 'trend_hunter'
    if direct and metadata.get('unusable_reason'):
        return {}
    original = metadata.get('original_url') or metadata.get('url') or signal.get('URL') or signal.get('SIGNAL_ID')
    urls = [metadata.get('canonical_url'),signal.get('SIGNAL_ID'),original,signal.get('URL')]
    canonical_urls = list(dict.fromkeys(filter(None, map(canonical, urls))))
    if not canonical_urls:
        return {}
    if direct:
        publisher_url = urlsplit(canonical_urls[0])
        if publisher_url.path == '/' and not publisher_url.query:
            return {}
    keys = ['url:' + u for u in canonical_urls]
    if direct:
        keys.append('provider:' + metadata['observation_key'])
        proof = metadata.get('release_proof') or {}
        wire_url = canonical(proof.get('original_url'))
        if wire_url:
            keys.append('url:' + wire_url)
            canonical_urls.append(wire_url)
        if proof.get('text_sha256'):
            keys.append('release-text:' + proof['text_sha256'])
    for url in canonical_urls:
        parts = urlsplit(url)
        if parts.hostname in ('prnewswire.com', 'prnewswire.co.uk', 'prnewswire.co.in') and '/news-releases/' in parts.path:
            match = re.search(r'-(\d{9})\.html$', parts.path)
            if match:
                keys.append('prnewswire:' + match[1])
    return {'original_url': original, 'canonical_url': canonical_urls[0], 'keys': list(dict.fromkeys(keys))}
$$;

-- Index surviving native writers without inventing receipts for discarded historical sightings.
BEGIN TRANSACTION;
UPDATE MCC_RAW.MARKETING_DEV.STG_ARTICLE_MUTEX SET REVISION=REVISION+1 WHERE LOCK_ID=1;
MERGE INTO MCC_RAW.MARKETING_DEV.STG_ARTICLE_ALIAS_HISTORY h
USING MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES a
ON h.SIGNAL_ID=a.SIGNAL_ID AND h.VERIFIED_AT_UTC=a.VERIFIED_AT_UTC AND h.CREDITED_SIGNAL_ID=a.CREDITED_SIGNAL_ID
WHEN NOT MATCHED THEN INSERT (SIGNAL_ID,CREDITED_SIGNAL_ID,CREDITED_URL,CREDITED_OWNER_AT_UTC,VERIFIED_AT_UTC)
VALUES (a.SIGNAL_ID,a.CREDITED_SIGNAL_ID,a.CREDITED_URL,a.CREDITED_OWNER_AT_UTC,a.VERIFIED_AT_UTC);
MERGE INTO MCC_RAW.MARKETING_DEV.STG_ARTICLE_EVIDENCE_KEYS target
USING (
    WITH native AS (
        SELECT SIGNAL_ID, INGESTED_AT, MCC_RAW.MARKETING_DEV.ARTICLE_EVIDENCE_IDENTITY(
            OBJECT_CONSTRUCT('SIGNAL_ID',SIGNAL_ID,'URL',URL,'METADATA',METADATA,'SOURCE_NAME',SOURCE_NAME)
        ) AS identity
        FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
        WHERE SOURCE_NAME IN ('agent_chatgpt_discovery','agent_gemini_discovery','agent_grok_discovery',
                              'gdelt','google_trends_rss','gemini_other')
    )
    SELECT k.value::VARCHAR AS evidence_key, n.SIGNAL_ID, n.identity:canonical_url::VARCHAR AS canonical_url,
           CONVERT_TIMEZONE('America/New_York','UTC', n.INGESTED_AT) AS owner_at_utc
    FROM native n, LATERAL FLATTEN(input=>n.identity:keys) k
    QUALIFY ROW_NUMBER() OVER (PARTITION BY k.value::VARCHAR,n.SIGNAL_ID ORDER BY n.INGESTED_AT)=1
) src ON target.EVIDENCE_KEY=src.EVIDENCE_KEY AND target.SIGNAL_ID=src.SIGNAL_ID
WHEN NOT MATCHED THEN INSERT (EVIDENCE_KEY,SIGNAL_ID,CANONICAL_URL,OWNER_AT_UTC,HAS_TREND_HUNTER)
VALUES (src.evidence_key,src.SIGNAL_ID,src.canonical_url,src.owner_at_utc,FALSE);
COMMIT;

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.RESOLVE_ARTICLE_SIGNALS(SIGNALS_JSON VARCHAR)
COPY GRANTS
RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS CALLER AS
$$
const batch = JSON.parse(SIGNALS_JSON);
const counts = {new_signals:0, repeat_sightings:0, syndicated_copies:0, unusable_records:0};
function exec(sqlText, binds) {
    return snowflake.createStatement({sqlText:sqlText, binds:binds || []}).execute();
}
const mutex = exec('UPDATE MCC_RAW.MARKETING_DEV.STG_ARTICLE_MUTEX SET REVISION=REVISION+1 WHERE LOCK_ID=1');
mutex.next();
if (mutex.getColumnValue(1) !== 1) throw new Error('Article mutex is not initialized');

const identityRows = exec(`
    SELECT s.index, MCC_RAW.MARKETING_DEV.ARTICLE_EVIDENCE_IDENTITY(s.value),
           TO_VARCHAR(CONVERT_TIMEZONE('UTC',CURRENT_TIMESTAMP()),'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')
    FROM TABLE(FLATTEN(input=>PARSE_JSON(?))) s ORDER BY s.index`, [SIGNALS_JSON]);
const identities = [], keys = new Set();
let observedAt;
while (identityRows.next()) {
    const identity = identityRows.getColumnValue(2);
    identities.push(identity);
    for (const key of (identity.keys || [])) keys.add(key);
    observedAt = identityRows.getColumnValue(3);
}
const batchResult = exec('SELECT UUID_STRING()');
batchResult.next();
const batchId = batchResult.getColumnValue(1);
const old = exec(`
    WITH requested AS (SELECT value::VARCHAR evidence_key FROM TABLE(FLATTEN(input=>PARSE_JSON(?)))),
    tracked AS (SELECT DISTINCT SIGNAL_ID FROM MCC_RAW.MARKETING_DEV.STG_ARTICLE_EVIDENCE_KEYS WHERE HAS_TREND_HUNTER)
    SELECT k.EVIDENCE_KEY,COALESCE(a.CREDITED_SIGNAL_ID,k.SIGNAL_ID),COALESCE(a.CREDITED_URL,k.CANONICAL_URL),
           TO_VARCHAR(COALESCE(a.CREDITED_OWNER_AT_UTC,k.OWNER_AT_UTC),'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'),(t.SIGNAL_ID IS NOT NULL OR a.SIGNAL_ID IS NOT NULL)
    FROM MCC_RAW.MARKETING_DEV.STG_ARTICLE_EVIDENCE_KEYS k
    LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES a ON a.SIGNAL_ID=k.SIGNAL_ID
    LEFT JOIN tracked t ON t.SIGNAL_ID=k.SIGNAL_ID
    JOIN requested r ON k.EVIDENCE_KEY=r.evidence_key
    UNION ALL
    SELECT r.evidence_key,s.SIGNAL_ID,s.SIGNAL_ID,
           TO_VARCHAR(CONVERT_TIMEZONE('America/New_York','UTC',s.INGESTED_AT),'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'),FALSE
    FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
    JOIN requested r ON r.evidence_key='url:' || s.SIGNAL_ID
    WHERE s.SOURCE_NAME NOT IN ('trend_hunter','gdelt','google_trends_rss','gemini_other',
                                'agent_chatgpt_discovery','agent_gemini_discovery','agent_grok_discovery')`,
    [JSON.stringify(Array.from(keys))]);
const owners = new Map(), trackedOwners = new Set();
while (old.next()) {
    const key=old.getColumnValue(1);
    if (!owners.has(key)) owners.set(key,[]);
    const id=old.getColumnValue(2);
    if (old.getColumnValue(5)) trackedOwners.add(id);
    owners.get(key).push({id:id,url:old.getColumnValue(3),at:old.getColumnValue(4)});
}
const aliases = new Map();
function representative(owner) {
    while (aliases.has(owner.id)) owner=aliases.get(owner.id);
    return owner;
}
const pending = new Map(), observations = [], sightings = [], signals = [], redirects = {};
for (let i=0; i<batch.length; i++) {
    const row = batch[i], identity = identities[i], direct = row.SOURCE_NAME === 'trend_hunter';
    const meta = direct ? JSON.parse(row.METADATA) : null;
    if (direct && (meta.unusable_reason || !identity.keys || !identity.keys.length)) {
        meta.unusable_reason = meta.unusable_reason || 'invalid_original_url';
        observations.push({meta:meta,title:row.SIGNAL_TITLE,summary:row.SIGNAL_TEXT,disposition:'unusable'});
        counts.unusable_records++;
        continue;
    }
    if (!identity.keys || !identity.keys.length) {
        signals.push(row);
        continue;
    }
    const matches = [];
    for (const key of identity.keys) {
        for (const candidate of (owners.get(key) || [])) {
            const resolved = representative(candidate);
            if (direct || trackedOwners.has(resolved.id) || resolved.id === row.SIGNAL_ID) matches.push(resolved);
        }
    }
    matches.sort((a,b) => a.at.localeCompare(b.at) || (a.batchIndex || 0)-(b.batchIndex || 0) || a.id.localeCompare(b.id));
    const previous = matches[0];
    const owner = previous || {id:direct ? identity.canonical_url : row.SIGNAL_ID,
                              url:identity.canonical_url,at:observedAt,batchIndex:i};
    if (direct) {
        if (Array.from(owner.id).length > 2048) {
            meta.unusable_reason = 'signal_id_too_long';
            observations.push({meta:meta,url:identity.canonical_url,title:row.SIGNAL_TITLE,summary:row.SIGNAL_TEXT,disposition:'unusable'});
            counts.unusable_records++;
            continue;
        }
        let disposition = 'new_signal';
        if (previous) disposition = previous.url === identity.canonical_url || owners.has('provider:' + meta.observation_key)
            ? 'repeat' : 'syndicated';
        if (disposition === 'new_signal') counts.new_signals++;
        else if (disposition === 'repeat') counts.repeat_sightings++;
        else counts.syndicated_copies++;
        observations.push({meta:meta,id:owner.id,url:identity.canonical_url,title:row.SIGNAL_TITLE,summary:row.SIGNAL_TEXT,disposition:disposition});
        trackedOwners.add(owner.id);
        for (const other of matches) if (other.id !== owner.id) aliases.set(other.id,owner);
    } else {
        sightings.push({source:row.SOURCE_NAME,native_id:row.SIGNAL_ID,id:owner.id,original:identity.original_url,url:identity.canonical_url,
            input_index:row.MERGE_INPUT_INDEX,session:row.MERGE_SESSION_ID,title:row.SIGNAL_TITLE,text:row.SIGNAL_TEXT,
            source_timestamp:row.SIGNAL_TIMESTAMP,metadata:row.METADATA});
        if (row.SIGNAL_ID !== owner.id) {
            redirects[row.SIGNAL_ID] = owner.id;
            aliases.set(row.SIGNAL_ID,owner);
        }
    }
    for (const key of identity.keys) {
        if (!owners.has(key)) owners.set(key,[]);
        const bucket = owners.get(key);
        if (direct || !bucket.some(v => v.id === owner.id)) {
            bucket.push(owner);
            pending.set(JSON.stringify([key,owner.id]), {key:key, owner:owner});
        }
    }
    if (!previous || previous.batchIndex === undefined || (!direct && row.SIGNAL_ID === owner.id && !trackedOwners.has(owner.id))) {
        row.REFRESH_OWNED_METADATA = row.SOURCE_NAME === 'gemini_other' && row.SIGNAL_ID === owner.id;
        row.SIGNAL_ID = owner.id;
        signals.push(row);
    }
}
if (pending.size) {
    const rows = Array.from(pending.values(), p => ({key:p.key,id:p.owner.id,url:p.owner.url,at:p.owner.at,tracked:trackedOwners.has(p.owner.id)}));
    exec(`MERGE INTO MCC_RAW.MARKETING_DEV.STG_ARTICLE_EVIDENCE_KEYS t
          USING (SELECT value v FROM TABLE(FLATTEN(input=>PARSE_JSON(?)))) s ON t.EVIDENCE_KEY=s.v:key::VARCHAR AND t.SIGNAL_ID=s.v:id::VARCHAR
          WHEN MATCHED AND s.v:tracked::BOOLEAN THEN UPDATE SET SIGNAL_ID=s.v:id::VARCHAR,
              CANONICAL_URL=s.v:url::VARCHAR, OWNER_AT_UTC=s.v:at::TIMESTAMP_NTZ, HAS_TREND_HUNTER=TRUE
          WHEN NOT MATCHED THEN INSERT (EVIDENCE_KEY,SIGNAL_ID,CANONICAL_URL,OWNER_AT_UTC,HAS_TREND_HUNTER)
              VALUES (s.v:key::VARCHAR,s.v:id::VARCHAR,s.v:url::VARCHAR,s.v:at::TIMESTAMP_NTZ,s.v:tracked::BOOLEAN)`,
          [JSON.stringify(rows)]);
}
if (aliases.size) {
    const aliasRows = [];
    for (const [id,candidate] of aliases) {
        const owner = representative(candidate);
        aliasRows.push({id:id,credit:owner.id,url:owner.url,at:owner.at});
    }
    const rows = JSON.stringify(aliasRows);
    exec(`INSERT INTO MCC_RAW.MARKETING_DEV.STG_ARTICLE_ALIAS_HISTORY
          (SIGNAL_ID,CREDITED_SIGNAL_ID,CREDITED_URL,CREDITED_OWNER_AT_UTC,VERIFIED_AT_UTC)
          WITH changed AS (SELECT value v FROM TABLE(FLATTEN(input=>PARSE_JSON(?)))),
          versions AS (
              SELECT s.v:id::VARCHAR id,s.v v FROM changed s
              WHERE NOT EXISTS (SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES a WHERE a.SIGNAL_ID=s.v:id::VARCHAR)
              UNION ALL
              SELECT a.SIGNAL_ID,s.v FROM MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES a JOIN changed s ON a.CREDITED_SIGNAL_ID=s.v:id::VARCHAR)
          SELECT id,v:credit::VARCHAR,v:url::VARCHAR,v:at::TIMESTAMP_NTZ,?::TIMESTAMP_NTZ FROM versions`,[rows,observedAt]);
    exec(`UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES t SET
              CREDITED_SIGNAL_ID=s.v:credit::VARCHAR,CREDITED_URL=s.v:url::VARCHAR,
              CREDITED_OWNER_AT_UTC=s.v:at::TIMESTAMP_NTZ,VERIFIED_AT_UTC=?::TIMESTAMP_NTZ
          FROM (SELECT value v FROM TABLE(FLATTEN(input=>PARSE_JSON(?)))) s
          WHERE t.CREDITED_SIGNAL_ID=s.v:id::VARCHAR`,[observedAt,rows]);
    exec(`MERGE INTO MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES t
          USING (SELECT value v FROM TABLE(FLATTEN(input=>PARSE_JSON(?)))) s ON t.SIGNAL_ID=s.v:id::VARCHAR
          WHEN NOT MATCHED THEN INSERT (SIGNAL_ID,CREDITED_SIGNAL_ID,CREDITED_URL,CREDITED_OWNER_AT_UTC,VERIFIED_AT_UTC)
              VALUES (s.v:id::VARCHAR,s.v:credit::VARCHAR,s.v:url::VARCHAR,s.v:at::TIMESTAMP_NTZ,?::TIMESTAMP_NTZ)`,
          [rows,observedAt]);
}
if (sightings.length) {
    exec(`INSERT INTO MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS
            (SOURCE_NAME,NATIVE_SIGNAL_ID,SIGNAL_ID,ORIGINAL_URL,CANONICAL_URL,OBSERVED_AT_UTC,
             BATCH_ID,INPUT_INDEX,MERGE_SESSION_ID,SIGNAL_TITLE,SIGNAL_TEXT,SIGNAL_TIMESTAMP,METADATA)
          SELECT value:source::VARCHAR,value:native_id::VARCHAR,value:id::VARCHAR,value:original::VARCHAR,value:url::VARCHAR,
                 ?::TIMESTAMP_NTZ,?,value:input_index::INTEGER,value:session::VARCHAR,value:title::VARCHAR,value:text::VARCHAR,
                 value:source_timestamp::VARCHAR,TRY_PARSE_JSON(value:metadata::VARCHAR)
          FROM TABLE(FLATTEN(input=>PARSE_JSON(?)))`, [observedAt,batchId,JSON.stringify(sightings)]);
}
if (observations.length) {
    exec(`INSERT INTO MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLE_SIGHTINGS
          (WINDOW_ID,PAGE_NUMBER,INPUT_INDEX,OBSERVATION_KEY,PROVIDER_ID,ORIGIN,OBSERVED_AT_UTC,HANDLED_AT_UTC,
           SIGNAL_ID,ORIGINAL_URL,CANONICAL_URL,PUBLISHER,HEADLINE,SUMMARY,DISPOSITION,REASON,RELEASE_PROOF)
          SELECT value:meta:window_id::VARCHAR,value:meta:page_number::INTEGER,index,value:meta:observation_key::VARCHAR,
                 value:meta:provider_id::VARCHAR,value:meta:origin::VARCHAR,value:meta:first_observed_at_utc::TIMESTAMP_NTZ,?::TIMESTAMP_NTZ,
                 value:id::VARCHAR,value:meta:original_url::VARCHAR,value:url::VARCHAR,value:meta:publisher::VARCHAR,
                 value:title::VARCHAR,value:summary::VARCHAR,value:disposition::VARCHAR,value:meta:unusable_reason::VARCHAR,value:meta:release_proof
          FROM TABLE(FLATTEN(input=>PARSE_JSON(?)))`,[observedAt,JSON.stringify(observations)]);
    exec(`MERGE INTO MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLES t
          USING (SELECT value v, v:meta m FROM TABLE(FLATTEN(input=>PARSE_JSON(?)))
                 WHERE m:status::VARCHAR='accepted'
                 QUALIFY ROW_NUMBER() OVER (PARTITION BY m:observation_key::VARCHAR ORDER BY (v:disposition='unusable'), index)=1) s
          ON t.OBSERVATION_KEY=s.m:observation_key::VARCHAR
          WHEN MATCHED AND (t.REASON='missing_status' OR (t.DISPOSITION='unusable' AND s.v:disposition!='unusable')) THEN UPDATE SET
              SIGNAL_ID=s.v:id::VARCHAR, ORIGINAL_URL=s.m:original_url::VARCHAR,CANONICAL_URL=s.v:url::VARCHAR,
              PUBLISHER=s.m:publisher::VARCHAR,FEED_LABEL=s.m:feed_label::VARCHAR,STATUS=s.m:status::VARCHAR,
              VERDICT=s.m:verdict::VARCHAR,HEADLINE=s.v:title::VARCHAR,SUMMARY=s.v:summary::VARCHAR,FIRST_SEEN_UTC=s.m:first_seen_utc::TIMESTAMP_NTZ,
              PUBLISHED_AT_UTC=s.m:published_at_utc::TIMESTAMP_NTZ,DISPOSITION=s.v:disposition::VARCHAR,REASON=s.m:unusable_reason::VARCHAR,
              RELEASE_PROOF=s.m:release_proof,
              ORIGIN=IFF(t.STATUS='accepted' AND t.FIRST_OBSERVED_AT_UTC <= s.m:first_observed_at_utc::TIMESTAMP_NTZ,t.ORIGIN,s.m:origin::VARCHAR),
              FIRST_OBSERVED_AT_UTC=IFF(t.STATUS='accepted',LEAST(t.FIRST_OBSERVED_AT_UTC,s.m:first_observed_at_utc::TIMESTAMP_NTZ),s.m:first_observed_at_utc::TIMESTAMP_NTZ)
          WHEN MATCHED AND t.FIRST_OBSERVED_AT_UTC>s.m:first_observed_at_utc::TIMESTAMP_NTZ THEN UPDATE SET
              FIRST_OBSERVED_AT_UTC=s.m:first_observed_at_utc::TIMESTAMP_NTZ, ORIGIN=s.m:origin::VARCHAR
          WHEN NOT MATCHED THEN INSERT (OBSERVATION_KEY,PROVIDER_ID,SIGNAL_ID,ORIGINAL_URL,CANONICAL_URL,PUBLISHER,
              FEED_LABEL,STATUS,VERDICT,HEADLINE,SUMMARY,FIRST_SEEN_UTC,PUBLISHED_AT_UTC,FIRST_OBSERVED_AT_UTC,ORIGIN,DISPOSITION,REASON,RELEASE_PROOF)
          VALUES (s.m:observation_key::VARCHAR,s.m:provider_id::VARCHAR,s.v:id::VARCHAR,s.m:original_url::VARCHAR,
              s.v:url::VARCHAR,s.m:publisher::VARCHAR,s.m:feed_label::VARCHAR,s.m:status::VARCHAR,s.m:verdict::VARCHAR,
              s.v:title::VARCHAR,s.v:summary::VARCHAR,s.m:first_seen_utc::TIMESTAMP_NTZ,s.m:published_at_utc::TIMESTAMP_NTZ,
              s.m:first_observed_at_utc::TIMESTAMP_NTZ,s.m:origin::VARCHAR,s.v:disposition::VARCHAR,
              s.m:unusable_reason::VARCHAR,s.m:release_proof)`, [JSON.stringify(observations)]);
}
return {signals:signals,article_counts:counts,signal_ids:redirects};
$$;
