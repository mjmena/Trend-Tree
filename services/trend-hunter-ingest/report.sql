ALTER SESSION SET TIMEZONE='UTC', TIMESTAMP_NTZ_OUTPUT_FORMAT='YYYY-MM-DD"T"HH24:MI:SS.FF9"Z"';

CREATE TEMPORARY TABLE THR_WINDOW AS
SELECT ENABLED_AT_UTC AS enabled, FORWARD_THROUGH_UTC AS through,
       IFF(ENABLED_AT_UTC=DATE_TRUNC(day,ENABLED_AT_UTC),ENABLED_AT_UTC,DATEADD(day,1,DATE_TRUNC(day,ENABLED_AT_UTC))) AS start_at,
       DATEADD(day,7,start_at) AS end_at, CONVERT_TIMEZONE('UTC',$cutoff)::TIMESTAMP_NTZ AS cutoff
FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_CONTROL AT(TIMESTAMP=>$report_snapshot) WHERE LOCK_ID=1;

CREATE TEMPORARY TABLE THR_ALIASES AS
SELECT SIGNAL_ID AS signal,CREDITED_SIGNAL_ID AS story,VERIFIED_AT_UTC AS verified
FROM MCC_RAW.MARKETING_DEV.STG_ARTICLE_ALIAS_HISTORY AT(TIMESTAMP=>$report_snapshot),THR_WINDOW w
WHERE VERIFIED_AT_UTC<=w.cutoff;
CREATE TEMPORARY TABLE THR_OWNERS AS
SELECT signal,story FROM THR_ALIASES QUALIFY ROW_NUMBER() OVER(PARTITION BY signal ORDER BY verified DESC,story)=1;

CREATE TEMPORARY TABLE THR_COHORT AS
WITH first_accepted AS (
    SELECT s.OBSERVATION_KEY,s.OBSERVED_AT_UTC first_poll,s.ORIGIN first_origin
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLE_SIGHTINGS AT(TIMESTAMP=>$report_snapshot) s,THR_WINDOW w
    WHERE s.HANDLED_AT_UTC<=w.cutoff AND s.OBSERVED_AT_UTC<=w.cutoff AND COALESCE(s.REASON,'')!='missing_status'
    QUALIFY ROW_NUMBER() OVER(PARTITION BY s.OBSERVATION_KEY ORDER BY s.OBSERVED_AT_UTC,s.HANDLED_AT_UTC,s.WINDOW_ID,s.INPUT_INDEX)=1
), eligible AS (
    SELECT s.* FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLE_SIGHTINGS AT(TIMESTAMP=>$report_snapshot) s, THR_WINDOW w
    WHERE s.HANDLED_AT_UTC<=w.cutoff AND s.OBSERVED_AT_UTC<=w.cutoff AND s.SIGNAL_ID IS NOT NULL AND DISPOSITION!='unusable'
    QUALIFY ROW_NUMBER() OVER(PARTITION BY s.OBSERVATION_KEY ORDER BY s.OBSERVED_AT_UTC,s.HANDLED_AT_UTC,s.WINDOW_ID,s.INPUT_INDEX)=1
)
SELECT a.OBSERVATION_KEY AS id,a.PROVIDER_ID,p.first_poll AS first,p.first_origin,a.FIRST_SEEN_UTC AS pickup,
       a.PUBLISHED_AT_UTC AS published,s.OBSERVED_AT_UTC AS eligible,s.HANDLED_AT_UTC AS handled,s.ORIGIN,
       COALESCE(s.HEADLINE,a.HEADLINE) AS title,COALESCE(s.SUMMARY,a.SUMMARY) AS summary,
       COALESCE(s.ORIGINAL_URL,a.ORIGINAL_URL) AS url,COALESCE(s.CANONICAL_URL,a.CANONICAL_URL) AS canonical_url,
       COALESCE(s.PUBLISHER,a.PUBLISHER) AS publisher,s.WINDOW_ID,s.PAGE_NUMBER,s.SIGNAL_ID AS signal,
       COALESCE(x.story,s.SIGNAL_ID) AS story,s.RELEASE_PROOF AS proof,COALESCE(s.DISPOSITION,a.DISPOSITION) AS disposition,a.reason
FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLES AT(TIMESTAMP=>$report_snapshot) a
JOIN first_accepted p ON p.OBSERVATION_KEY=a.OBSERVATION_KEY LEFT JOIN eligible s ON s.OBSERVATION_KEY=a.OBSERVATION_KEY LEFT JOIN THR_OWNERS x ON x.signal=s.SIGNAL_ID, THR_WINDOW w
WHERE p.first_poll>=w.start_at AND p.first_poll<w.end_at;

CREATE TEMPORARY TABLE THR_NATIVE AS
SELECT n.SOURCE_NAME AS source,n.NATIVE_SIGNAL_ID AS native_id,n.SIGNAL_ID AS signal,n.ORIGINAL_URL AS url,
       n.OBSERVED_AT_UTC AS seen,n.MERGE_SESSION_ID AS claim,n.SIGNAL_TITLE AS title,n.SIGNAL_TEXT AS body,n.METADATA,
       n.BATCH_ID,n.INPUT_INDEX,'resolver_receipt' AS method
FROM MCC_RAW.MARKETING_DEV.STG_NATIVE_ARTICLE_SIGHTINGS AT(TIMESTAMP=>$report_snapshot) n, THR_WINDOW w
WHERE n.OBSERVED_AT_UTC<=w.cutoff AND (n.OBSERVED_AT_UTC>=DATEADD(day,-7,w.enabled) OR n.ORIGINAL_URL IN (SELECT url FROM THR_COHORT));

CREATE TEMPORARY TABLE THR_ARTICLES AS
WITH staging AS (
    SELECT COALESCE(NULLIF(s.METADATA:original_url::VARCHAR,''),NULLIF(s.METADATA:url::VARCHAR,''),NULLIF(s.URL,''),
             IFF(LOWER(PARSE_URL(s.SIGNAL_ID,1):scheme::VARCHAR) IN ('https','http') AND PARSE_URL(s.SIGNAL_ID,1):host IS NOT NULL,
                 s.SIGNAL_ID,NULL)) AS original_url,s.SOURCE_NAME,s.SIGNAL_ID,CONVERT_TIMEZONE('America/New_York','UTC',s.INGESTED_AT) AS seen
    FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS AT(TIMESTAMP=>$report_snapshot) s,THR_WINDOW w
    WHERE s.SOURCE_NAME IN ('agent_chatgpt_discovery','agent_gemini_discovery','agent_grok_discovery','gdelt','google_trends_rss','gemini_other')
      AND seen<=w.cutoff
), matches AS (
    SELECT url,source,native_id,seen,method FROM THR_NATIVE WHERE url IN (SELECT url FROM THR_COHORT)
    UNION ALL
    SELECT original_url,SOURCE_NAME,SIGNAL_ID,seen,'surviving_staging' FROM staging WHERE original_url IN (SELECT url FROM THR_COHORT)
), first_native AS (
    SELECT * FROM matches QUALIFY ROW_NUMBER() OVER(PARTITION BY url ORDER BY seen,method,source,native_id)=1
), embedded AS (
    SELECT f.SIGNAL_ID,f.SOURCE_NAME,CONVERT_TIMEZONE('America/New_York','UTC',f.EMBEDDED_AT) AS embedded
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS AT(TIMESTAMP=>$report_snapshot) f, THR_WINDOW w
    WHERE f.SIGNAL_VECTOR IS NOT NULL AND embedded<=w.cutoff
    QUALIFY ROW_NUMBER() OVER(PARTITION BY f.SIGNAL_ID ORDER BY embedded,f.SOURCE_NAME)=1
)
SELECT c.*,fs.first_poll AS story_first,fs.first_origin AS story_origin,n.seen AS native,n.source AS native_source,n.native_id,n.method AS native_clock,
       f.embedded,f.SOURCE_NAME AS writer,owner.SOURCE_NAME AS story_writer
FROM THR_COHORT c LEFT JOIN first_native n ON n.url=c.url LEFT JOIN embedded f ON f.SIGNAL_ID=c.signal
LEFT JOIN embedded owner ON owner.SIGNAL_ID=c.story
LEFT JOIN (
    SELECT COALESCE(x.story,s.SIGNAL_ID) AS story,s.OBSERVED_AT_UTC AS first_poll,s.ORIGIN AS first_origin
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLE_SIGHTINGS AT(TIMESTAMP=>$report_snapshot) s
    LEFT JOIN THR_OWNERS x ON x.signal=s.SIGNAL_ID,THR_WINDOW w
    WHERE s.SIGNAL_ID IS NOT NULL AND s.DISPOSITION!='unusable' AND s.HANDLED_AT_UTC<=w.cutoff
    QUALIFY ROW_NUMBER() OVER(PARTITION BY COALESCE(x.story,s.SIGNAL_ID) ORDER BY s.HANDLED_AT_UTC,s.OBSERVED_AT_UTC,s.WINDOW_ID,s.INPUT_INDEX)=1
) fs ON fs.story=c.story;

SELECT 'window' AS section,OBJECT_CONSTRUCT_KEEP_NULL('enabled',enabled,'through',through,'start',start_at,'end',end_at,'cutoff',cutoff) AS data FROM THR_WINDOW;
SELECT 'articles' AS section,OBJECT_CONSTRUCT_KEEP_NULL(a.*) AS data FROM THR_ARTICLES a ORDER BY a.id;
WITH days AS (
    SELECT DATEADD(day,ROW_NUMBER() OVER(ORDER BY SEQ4())-1,w.start_at) AS dt
    FROM THR_WINDOW w,TABLE(GENERATOR(ROWCOUNT=>7))
), polls AS (
    SELECT DATE_TRUNC(day,p.OBSERVED_AT_UTC) dt,COUNT(DISTINCT DATE_TRUNC(hour,p.OBSERVED_AT_UTC)) forward_hours,
           COUNT(DISTINCT r.WINDOW_ID) forward_windows, SUM(p.COUNTS:accepted_rows::INTEGER) accepted_page_rows
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_PAGES AT(TIMESTAMP=>$report_snapshot) p
    JOIN MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_RUNS AT(TIMESTAMP=>$report_snapshot) r USING(WINDOW_ID),THR_WINDOW w
    WHERE r.ORIGIN='forward' AND r.COMPLETED_AT_UTC<=w.cutoff AND p.COMMITTED_AT_UTC<=w.cutoff GROUP BY 1
)
SELECT 'days' AS section,OBJECT_CONSTRUCT_KEEP_NULL('day',d.dt,'forward_hours',COALESCE(p.forward_hours,0),
       'forward_windows',COALESCE(p.forward_windows,0),'accepted_forward_rows',COALESCE(p.accepted_page_rows,0)) AS data
FROM days d LEFT JOIN polls p ON p.dt=d.dt ORDER BY d.dt;
SELECT 'native_coverage' AS section,OBJECT_CONSTRUCT('source',source,'receipts',COUNT(*),'first',MIN(seen),'last',MAX(seen)) AS data
FROM THR_NATIVE,THR_WINDOW w WHERE seen>=w.start_at AND seen<w.end_at GROUP BY source ORDER BY source;
SELECT 'aliases' AS section,OBJECT_CONSTRUCT(a.*) AS data FROM THR_ALIASES a ORDER BY signal,verified;

CREATE TEMPORARY TABLE THR_CANDIDATES AS
WITH births AS (
    SELECT v.CANDIDATE_ID id,v.VERSION_AT_UTC created,v.CANDIDATE c,'archived_creation' origin
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_CANDIDATE_VERSIONS AT(TIMESTAMP=>$report_snapshot) v,THR_WINDOW w
    WHERE v.PHASE='created' AND v.RECORDED_AT_UTC<=w.cutoff
    UNION ALL
    SELECT s.CANDIDATE_ID,CONVERT_TIMEZONE('America/New_York','UTC',s.CREATED_AT),
           OBJECT_CONSTRUCT('SUPPORTING_SIGNAL_IDS',s.SUPPORTING_SIGNAL_IDS,'QUERY',s.QUERY,'TOPIC',s.TOPIC,'CONFIDENCE',s.CONFIDENCE,
                            'SPECIFICITY_SCORE',s.SPECIFICITY_SCORE,'CHAIN_ID',s.CHAIN_ID,'VERDICT',s.VERDICT),'cutoff_snapshot'
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES AT(TIMESTAMP=>$report_snapshot) s, THR_WINDOW w
    WHERE CONVERT_TIMEZONE('America/New_York','UTC',s.CREATED_AT) BETWEEN DATEADD(day,-7,w.enabled) AND w.cutoff
)
SELECT id,created,c:SUPPORTING_SIGNAL_IDS AS support,c:QUERY::VARCHAR AS query,c:TOPIC::VARCHAR AS topic,
       c:CONFIDENCE::FLOAT AS confidence,c:SPECIFICITY_SCORE::FLOAT AS specificity,c:CHAIN_ID::VARCHAR AS chain,
       c:VERDICT::VARCHAR AS verdict,origin FROM births,THR_WINDOW w
WHERE created BETWEEN DATEADD(day,-7,w.enabled) AND w.cutoff
QUALIFY ROW_NUMBER() OVER(PARTITION BY id ORDER BY origin,created)=1;
CREATE TEMPORARY TABLE THR_SUPPORT AS
SELECT DISTINCT f.value::VARCHAR AS signal FROM THR_CANDIDATES c,LATERAL FLATTEN(INPUT=>c.support) f
UNION SELECT signal FROM THR_COHORT WHERE signal IS NOT NULL;
CREATE TEMPORARY TABLE THR_STATES AS
SELECT v.CANDIDATE_ID AS candidate,v.CHAIN_ID AS chain,v.VERSION_AT_UTC AS at_utc,v.DECISION:decision::VARCHAR AS decision,
       NULLIF(v.DECISION:target_candidate_id::VARCHAR,'null') AS leader,NULLIF(v.CANDIDATE:PROMOTED_TO::VARCHAR,'null') AS promoted_to,
       NULLIF(v.CANDIDATE:REJECTED_AT::VARCHAR,'null') AS rejected,NULLIF(v.CANDIDATE:DEFERRED_UNTIL::VARCHAR,'null') AS deferred,
       v.CANDIDATE:REJECTION_REASON::VARCHAR AS rejection_reason,v.CANDIDATE:DEFER_REASON::VARCHAR AS defer_reason,
       v.DECISION:et_was_second_source::BOOLEAN AS et_second,v.DECISION:et_corroboration AS et,
       v.DECISION:rationale::VARCHAR AS rationale
FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_CANDIDATE_VERSIONS AT(TIMESTAMP=>$report_snapshot) v,THR_WINDOW w
WHERE v.PHASE='after_decision' AND v.VERSION_AT_UTC<=w.cutoff AND v.RECORDED_AT_UTC<=w.cutoff
  AND v.CANDIDATE_ID IN (SELECT id FROM THR_CANDIDATES);
CREATE TEMPORARY TABLE THR_AUDITS AS
SELECT a.AUDIT_ID AS id,a.CANDIDATE_ID AS candidate,a.CHAIN_ID AS chain,a.DECISION,a.DECISION_CATEGORY AS category,
       a.TARGET_TREND_ID AS target,CONVERT_TIMEZONE('America/New_York','UTC',a.DECIDED_AT) AS at_utc,a.RATIONALE
FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER AT(TIMESTAMP=>$report_snapshot) a,THR_WINDOW w
WHERE at_utc<=w.cutoff AND a.CANDIDATE_ID IN (SELECT id FROM THR_CANDIDATES);

CREATE TEMPORARY TABLE THR_LINKS AS
SELECT l.TREND_ID AS trend,l.SIGNAL_ID AS signal,COALESCE(x.story,l.SIGNAL_ID) AS story,l.LINK_KIND AS kind,l.LINK_TYPE AS type,
       CONVERT_TIMEZONE('America/New_York','UTC',l.LINKED_AT) AS at_utc
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS AT(TIMESTAMP=>$report_snapshot) l LEFT JOIN THR_OWNERS x ON x.signal=l.SIGNAL_ID,THR_WINDOW w
WHERE COALESCE(x.story,l.SIGNAL_ID) IN (SELECT story FROM THR_COHORT) AND at_utc<=w.cutoff;
CREATE TEMPORARY TABLE THR_SWEEPS AS
WITH batches AS (
    SELECT b.BATCH_NAME,b.POOLS,b.STATE,CONVERT_TIMEZONE('America/New_York','UTC',b.UPDATED_AT) AS updated,CONVERT_TIMEZONE('America/New_York','UTC',b.SUBMITTED_AT) AS submitted
    FROM MCC_RAW.MARKETING_DEV.STG_ATTRIBUTION_BATCHES AT(TIMESTAMP=>$report_snapshot) b,THR_WINDOW w WHERE submitted BETWEEN w.start_at AND w.cutoff
), pools AS (
    SELECT b.BATCH_NAME,b.submitted,b.state,b.updated,p.key AS trend,s.value:signal_id::VARCHAR AS signal,s.index+1 AS rank,s.value:similarity::FLOAT AS similarity,
           TRY_TO_TIMESTAMP_NTZ(s.value:selected_at_utc::VARCHAR) AS selected,TRY_TO_TIMESTAMP_NTZ(s.value:embedded_at_utc::VARCHAR) AS embedded
    FROM batches b,LATERAL FLATTEN(INPUT=>b.POOLS) p,LATERAL FLATTEN(INPUT=>p.value) s
)
SELECT p.*,COALESCE(x.story,p.signal) AS story
FROM pools p LEFT JOIN THR_OWNERS x ON x.signal=p.signal
WHERE COALESCE(x.story,p.signal) IN (SELECT story FROM THR_COHORT);
CREATE TEMPORARY TABLE THR_TARGETS AS
SELECT trend FROM THR_LINKS UNION SELECT trend FROM THR_SWEEPS UNION SELECT target FROM THR_AUDITS WHERE target IS NOT NULL;

SELECT 'candidates' AS section,OBJECT_CONSTRUCT_KEEP_NULL(c.*) AS data FROM THR_CANDIDATES c ORDER BY created,id;
SELECT 'signal_facts' AS section,OBJECT_CONSTRUCT('signal',f.SIGNAL_ID,'source',f.SOURCE_NAME,
       'embedded',CONVERT_TIMEZONE('America/New_York','UTC',f.EMBEDDED_AT)) AS data
FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS AT(TIMESTAMP=>$report_snapshot) f,THR_WINDOW w
WHERE f.SIGNAL_ID IN (SELECT signal FROM THR_SUPPORT) AND f.SIGNAL_VECTOR IS NOT NULL
  AND CONVERT_TIMEZONE('America/New_York','UTC',f.EMBEDDED_AT)<=w.cutoff
QUALIFY ROW_NUMBER() OVER(PARTITION BY f.SIGNAL_ID ORDER BY f.EMBEDDED_AT,f.SOURCE_NAME)=1 ORDER BY f.SIGNAL_ID;
SELECT 'states' AS section,OBJECT_CONSTRUCT_KEEP_NULL(s.*) AS data FROM THR_STATES s ORDER BY candidate,at_utc;
SELECT 'audits' AS section,OBJECT_CONSTRUCT_KEEP_NULL(a.*) AS data FROM THR_AUDITS a ORDER BY at_utc,id;
SELECT 'links' AS section,OBJECT_CONSTRUCT_KEEP_NULL(l.*) AS data FROM THR_LINKS l ORDER BY trend,at_utc,kind,signal;
SELECT 'sweeps' AS section,OBJECT_CONSTRUCT_KEEP_NULL(s.*) AS data FROM THR_SWEEPS s ORDER BY submitted,batch_name,trend,rank;
SELECT 'trends' AS section,OBJECT_CONSTRUCT_KEEP_NULL('id',t.TREND_ID,'candidate',t.CANDIDATE_ID,'topic',t.TREND_TOPIC,
       'minted',CONVERT_TIMEZONE('America/New_York','UTC',t.PROMOTED_AT)) AS data
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS AT(TIMESTAMP=>$report_snapshot) t,THR_WINDOW w
WHERE CONVERT_TIMEZONE('America/New_York','UTC',t.PROMOTED_AT)<=w.cutoff
  AND (t.TREND_ID IN (SELECT trend FROM THR_TARGETS) OR t.CANDIDATE_ID IN (SELECT id FROM THR_CANDIDATES)) ORDER BY t.TREND_ID;
SELECT 'lifecycle' AS section,OBJECT_CONSTRUCT_KEEP_NULL('id',l.LIFECYCLE_EVAL_ID,'trend',l.TREND_ID,'status',l.NEW_STATUS,
       'at',CONVERT_TIMEZONE('America/New_York','UTC',l.EVALUATED_AT)) AS data
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER AT(TIMESTAMP=>$report_snapshot) l,THR_WINDOW w
WHERE l.TREND_ID IN (SELECT trend FROM THR_TARGETS) AND CONVERT_TIMEZONE('America/New_York','UTC',l.EVALUATED_AT)<=w.cutoff
ORDER BY l.TREND_ID,l.EVALUATED_AT,l.LIFECYCLE_EVAL_ID;

CREATE TEMPORARY TABLE THR_PRIOR_BOUNDS AS
SELECT t.trend,MAX(c.eligible) AS last_poll FROM (SELECT trend,story FROM THR_LINKS UNION SELECT trend,story FROM THR_SWEEPS) t
JOIN THR_COHORT c ON c.story=t.story GROUP BY t.trend;
SELECT 'prior_links' AS section,OBJECT_CONSTRUCT_KEEP_NULL('trend',l.TREND_ID,'signal',l.SIGNAL_ID,'kind',l.LINK_KIND,
       'at',CONVERT_TIMEZONE('America/New_York','UTC',l.LINKED_AT),'title',f.SIGNAL_TITLE,'body',f.SIGNAL_TEXT,
       'url',COALESCE(f.METADATA:original_url::VARCHAR,f.METADATA:url::VARCHAR)) AS data
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS AT(TIMESTAMP=>$report_snapshot) l JOIN THR_PRIOR_BOUNDS b ON b.trend=l.TREND_ID
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS AT(TIMESTAMP=>$report_snapshot) f ON f.SIGNAL_ID=l.SIGNAL_ID
  AND CONVERT_TIMEZONE('America/New_York','UTC',f.EMBEDDED_AT)<=CONVERT_TIMEZONE('America/New_York','UTC',l.LINKED_AT)
WHERE CONVERT_TIMEZONE('America/New_York','UTC',l.LINKED_AT)<=b.last_poll ORDER BY l.TREND_ID,l.LINKED_AT,l.SIGNAL_ID;
SELECT 'prior_enrichments' AS section,OBJECT_CONSTRUCT_KEEP_NULL('trend',e.TREND_ID,'id',e.ENRICHMENT_ID,'kind',e.ENRICHMENT_KIND,
       'at',CONVERT_TIMEZONE('America/New_York','UTC',e.WRITTEN_AT),'evidence',COALESCE(e.PAYLOAD:evidence,e.PAYLOAD:social_proof)) AS data
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER AT(TIMESTAMP=>$report_snapshot) e JOIN THR_PRIOR_BOUNDS b ON b.trend=e.TREND_ID
WHERE CONVERT_TIMEZONE('America/New_York','UTC',e.WRITTEN_AT)<=b.last_poll ORDER BY e.TREND_ID,e.WRITTEN_AT,e.ENRICHMENT_ID;

CREATE TEMPORARY TABLE THR_OPPS AS
SELECT o.OPPORTUNITY_ID AS id,o.OBSERVED_AT_UTC AS at_utc,o.LANE,o.CHAIN_ID,o.SESSION_ID,o.LOOKBACK_HOURS,o.PER_SOURCE_CAP,
       o.POOL_LIMIT,o.MIN_POOL AS floor,o.SELECTED_COUNT,o.PASSED_FLOOR
FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_OPPORTUNITIES AT(TIMESTAMP=>$report_snapshot) o, THR_WINDOW w
WHERE o.OBSERVED_AT_UTC BETWEEN w.enabled AND w.cutoff;
CREATE TEMPORARY TABLE THR_INPUTS AS
SELECT o.id AS op,s.SIGNAL_ID AS signal,s.INPUT_ORDINAL,s.SOURCE_NAME AS source,s.CREDITED_SIGNAL_ID AS story,
       s.SIGNAL_TITLE AS title,s.SIGNAL_TEXT AS body,s.INGESTED_AT_UTC AS ingested,s.EMBEDDED_AT_UTC AS embedded,
       s.CLAIM_SESSION_ID AS claim,s.SIGNAL_KIND AS kind,s.HAD_PROMOTED_CANDIDATE AS promoted,s.POOL_RANK AS rank
FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_POOL_SIGNALS AT(TIMESTAMP=>$report_snapshot) s JOIN THR_OPPS o ON o.id=s.OPPORTUNITY_ID;
CREATE TEMPORARY TABLE THR_FIRST_FEED AS
SELECT SIGNAL_ID AS signal,ORIGIN,DISPOSITION,HANDLED_AT_UTC AS handled,OBSERVED_AT_UTC AS observed
FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLE_SIGHTINGS AT(TIMESTAMP=>$report_snapshot) s,THR_WINDOW w
WHERE SIGNAL_ID IS NOT NULL AND DISPOSITION!='unusable' AND HANDLED_AT_UTC<=w.cutoff
QUALIFY ROW_NUMBER() OVER(PARTITION BY s.SIGNAL_ID ORDER BY HANDLED_AT_UTC,OBSERVED_AT_UTC,WINDOW_ID,INPUT_INDEX)=1;

-- Native submissions suppressed by a feed-first writer have no independent vector or subsequent claim history.
CREATE TEMPORARY TABLE THR_NATIVE_POOL AS
WITH suppressed AS (
    SELECT n.*,f.handled FROM THR_NATIVE n JOIN THR_FIRST_FEED f ON f.signal=n.signal AND f.handled<=n.seen
    WHERE (n.native_id!=n.signal OR f.disposition='new_signal')
      AND NOT EXISTS (SELECT 1 FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS AT(TIMESTAMP=>$report_snapshot) s
        WHERE s.SIGNAL_ID=n.native_id AND s.SOURCE_NAME!='trend_hunter' AND CONVERT_TIMEZONE('America/New_York','UTC',s.INGESTED_AT)<=n.seen)
    QUALIFY ROW_NUMBER() OVER(PARTITION BY n.native_id ORDER BY n.seen,n.batch_id,n.input_index)=1
), alternatives AS (
    SELECT op,signal,input_ordinal,source,story,title,body,ingested,embedded,claim,kind,promoted,'staging_snapshot' AS representation
    FROM THR_INPUTS WHERE source!='trend_hunter'
    UNION ALL
    SELECT o.id,n.native_id,1,n.source,COALESCE(a.story,n.signal),n.title,n.body,n.seen,NULL,n.claim,
           COALESCE(n.metadata:signal_kind::VARCHAR,'discovery_signal'),COALESCE(owner.promoted,FALSE),'suppressed_native_receipt'
    FROM THR_OPPS o JOIN suppressed n ON n.seen<=o.at_utc AND n.seen>DATEADD(hour,-o.lookback_hours,o.at_utc)
    LEFT JOIN THR_INPUTS owner ON owner.op=o.id AND owner.signal=n.signal AND owner.input_ordinal=1
    ASOF JOIN THR_ALIASES a MATCH_CONDITION(o.at_utc>=a.verified) ON n.signal=a.signal
    WHERE NOT EXISTS (SELECT 1 FROM THR_INPUTS i WHERE i.op=o.id AND i.signal=n.native_id AND i.source!='trend_hunter')
), admissible AS (
    SELECT i.*,o.per_source_cap,o.pool_limit FROM alternatives i JOIN THR_OPPS o ON o.id=i.op
    WHERE i.kind='discovery_signal' AND IFF(o.lane='main',COALESCE(i.claim,'')='',i.claim LIKE 'sess-%' AND NOT i.promoted)
), within_source AS (
    SELECT * FROM admissible QUALIFY ROW_NUMBER() OVER(PARTITION BY op,source ORDER BY ingested DESC,signal,input_ordinal)<=per_source_cap
)
SELECT *,ROW_NUMBER() OVER(PARTITION BY op ORDER BY ingested DESC,signal,input_ordinal) AS rank FROM within_source QUALIFY rank<=pool_limit AND signal!='';

CREATE TEMPORARY TABLE THR_REVISIT_BATCHES AS
WITH runs AS (
    SELECT * FROM THR_OPPS WHERE lane='revisit'
    QUALIFY COUNT(*) OVER(PARTITION BY chain_id,session_id)=1
)
SELECT o.id AS op,b.BATCH_INDEX,b.TOTAL_BATCHES,TRY_PARSE_JSON(b.SIGNAL_IDS_JSON) AS ids,
       b.STATUS='DONE' AND CONVERT_TIMEZONE('America/New_York','UTC',b.UPDATED_AT)<=w.cutoff
       AND b.SIGNAL_COUNT BETWEEN 1 AND 400 AND ARRAY_SIZE(ids)=b.SIGNAL_COUNT AS completed
FROM runs o JOIN MCC_RAW.MARKETING_DEV.STG_REVISIT_BATCH_QUEUE AT(TIMESTAMP=>$report_snapshot) b
  ON b.CHAIN_ID=o.chain_id AND b.AGENT_SESSION_ID=o.session_id,THR_WINDOW w
WHERE CONVERT_TIMEZONE('America/New_York','UTC',b.CREATED_AT) BETWEEN o.at_utc AND w.cutoff;

CREATE TEMPORARY TABLE THR_REVISIT_GROUPS AS
WITH ambiguous AS (
    SELECT b.op FROM THR_REVISIT_BATCHES b,LATERAL FLATTEN(INPUT=>b.ids) s
    GROUP BY b.op,s.value::VARCHAR HAVING COUNT(DISTINCT b.batch_index)>1
), complete AS (
    SELECT op FROM THR_REVISIT_BATCHES WHERE op NOT IN (SELECT op FROM ambiguous) GROUP BY op
    HAVING BOOLAND_AGG(COALESCE(completed,FALSE)) AND COUNT(DISTINCT batch_index)=COUNT(*)
       AND COUNT(*)=MAX(total_batches) AND MIN(total_batches)=MAX(total_batches)
), actual AS (
    SELECT i.op,ARRAY_AGG(ARRAY_CONSTRUCT(i.signal,i.input_ordinal,i.source,'staging_snapshot')) WITHIN GROUP(ORDER BY i.rank) ids
    FROM THR_INPUTS i JOIN complete c ON c.op=i.op WHERE i.rank IS NOT NULL GROUP BY i.op
), native AS (
    SELECT n.op,ARRAY_AGG(ARRAY_CONSTRUCT(n.signal,n.input_ordinal,n.source,n.representation)) WITHIN GROUP(ORDER BY n.rank) ids
    FROM THR_NATIVE_POOL n JOIN complete c ON c.op=n.op GROUP BY n.op
)
SELECT c.op,TRUE AS augmented_groups_known,COALESCE(a.ids=n.ids,FALSE) AS native_groups_known
FROM complete c LEFT JOIN actual a ON a.op=c.op LEFT JOIN native n ON n.op=c.op;

WITH excluded AS (
    SELECT i.op,COUNT(*) n FROM THR_INPUTS i JOIN THR_OPPS o ON o.id=i.op
    LEFT JOIN THR_FIRST_FEED f ON f.signal=i.signal AND f.handled<=o.at_utc
    WHERE i.source='trend_hunter' AND i.rank IS NOT NULL AND COALESCE(f.origin,'unknown') NOT IN ('forward','reconcile') GROUP BY i.op
), totals AS (
    SELECT o.*,COALESCE(n.n,0) AS native_count,COALESCE(e.n,0) AS excluded_feed_count,
           COALESCE(g.native_groups_known,FALSE) AS native_groups_known,COALESCE(g.augmented_groups_known,FALSE) AS augmented_groups_known
    FROM THR_OPPS o LEFT JOIN (SELECT op,COUNT(*) n FROM THR_NATIVE_POOL GROUP BY op) n ON n.op=o.id
    LEFT JOIN excluded e ON e.op=o.id LEFT JOIN THR_REVISIT_GROUPS g ON g.op=o.id
)
SELECT 'opportunities' AS section,OBJECT_CONSTRUCT_KEEP_NULL(o.*) AS data FROM totals o ORDER BY o.at_utc,o.id;
WITH arms AS (
    SELECT i.op,'augmented' AS arm,i.signal,i.story,i.source,i.title,i.body,i.ingested,i.embedded,i.rank,'staging_snapshot' AS representation,
           IFF(i.source='trend_hunter',COALESCE(f.origin,'unverified'),NULL) AS origin
    FROM THR_INPUTS i JOIN THR_OPPS o ON o.id=i.op
    LEFT JOIN THR_FIRST_FEED f ON f.signal=i.signal AND f.handled<=o.at_utc WHERE i.rank IS NOT NULL
    UNION ALL
    SELECT op,'native',signal,story,source,title,body,ingested,embedded,rank,representation,NULL FROM THR_NATIVE_POOL
), members AS (
    SELECT b.op,b.batch_index,s.value::VARCHAR AS signal,g.native_groups_known
    FROM THR_REVISIT_BATCHES b JOIN THR_REVISIT_GROUPS g ON g.op=b.op,LATERAL FLATTEN(INPUT=>b.ids) s
    QUALIFY ROW_NUMBER() OVER(PARTITION BY b.op,s.value::VARCHAR ORDER BY b.batch_index)=1
), relevant AS (
    SELECT COALESCE(x.story,s.signal) story FROM THR_SUPPORT s LEFT JOIN THR_OWNERS x ON x.signal=s.signal
)
SELECT 'pools' AS section,OBJECT_CONSTRUCT_KEEP_NULL(r.*) AS data FROM (
    SELECT i.*,m.batch_index AS batch FROM arms i LEFT JOIN THR_OWNERS x ON x.signal=i.story
    LEFT JOIN members m ON m.op=i.op AND m.signal=i.signal AND (i.arm='augmented' OR m.native_groups_known)
    WHERE COALESCE(x.story,i.story) IN (SELECT story FROM relevant)
) r ORDER BY r.op,r.arm,r.rank,r.signal;

SELECT 'sightings' AS section,OBJECT_CONSTRUCT('origin',s.ORIGIN,'disposition',s.DISPOSITION,'receipts',COUNT(*),
       'items',COUNT(DISTINCT s.OBSERVATION_KEY)) AS data
FROM MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_ARTICLE_SIGHTINGS AT(TIMESTAMP=>$report_snapshot) s,THR_WINDOW w
WHERE s.OBSERVED_AT_UTC>=w.start_at AND s.OBSERVED_AT_UTC<w.end_at AND s.HANDLED_AT_UTC<=w.cutoff
GROUP BY s.ORIGIN,s.DISPOSITION ORDER BY s.ORIGIN,s.DISPOSITION;
SELECT 'manifest' AS section,OBJECT_CONSTRUCT('version',1,'articles',(SELECT COUNT(*) FROM THR_COHORT),
       'candidates',(SELECT COUNT(*) FROM THR_CANDIDATES),'opportunities',(SELECT COUNT(*) FROM THR_OPPS)) AS data;
