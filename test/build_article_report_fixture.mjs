import { readFileSync } from 'node:fs';
const read = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const scenario = process.argv[2] || 'linked';
if (!['linked', 'empty', 'immature'].includes(scenario)) throw new Error('Expected linked, empty or immature');
const start = scenario === 'empty' ? '2026-11-11' : '2026-11-02';
const enabled = scenario === 'empty' ? '2026-11-10T01:00:00' : '2026-11-01T01:00:00';
const cutoff = { linked: '2026-11-10', empty: '2026-11-19', immature: '2026-11-05' }[scenario];
const raw = 'MCC_RAW.MARKETING_DEV.';
const fact = 'MCC_PRESENTATION.TREND_AGENT.';
const fixture = (sql) => sql.replaceAll(raw, 'FIX_REPORT_').replaceAll(fact, 'FIX_REPORT_');
const ddl = ['sql/stg_article_evidence.sql', 'sql/trend_hunter_intake.sql', 'sql/trend_hunter_comparison.sql']
  .map(read)
  .join('\n');
for (const match of ddl.matchAll(/CREATE TABLE IF NOT EXISTS [^;]+;/g))
  console.log(fixture(match[0]).replace('TABLE IF NOT EXISTS', 'TEMPORARY TABLE'));
for (const match of ddl.matchAll(/ALTER TABLE [^;]+;/g)) console.log(fixture(match[0]));
for (const name of ['STG_TREND_CANDIDATES', 'STG_EXTERNAL_SIGNALS', 'STG_ATTRIBUTION_BATCHES', 'STG_REVISIT_BATCH_QUEUE'])
  console.log(`CREATE TEMPORARY TABLE FIX_REPORT_${name} LIKE ${raw}${name};`);
for (const name of [
  'FCT_TRENDS',
  'FCT_SIGNALS',
  'FCT_PROMOTION_LEDGER',
  'FCT_TREND_SIGNALS',
  'FCT_TREND_LIFECYCLE_LEDGER',
  'FCT_TREND_ENRICHMENT_LEDGER',
])
  console.log(`CREATE TEMPORARY TABLE FIX_REPORT_${name} LIKE ${fact}${name};`);
console.log(`INSERT INTO FIX_REPORT_STG_TREND_HUNTER_CONTROL (LOCK_ID,REVISION,ENABLED_AT_UTC,FORWARD_THROUGH_UTC)
 SELECT 1,1,'${enabled}','${cutoff}';
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_ARTICLES (OBSERVATION_KEY,PROVIDER_ID,STATUS,SIGNAL_ID,FIRST_SEEN_UTC,FIRST_OBSERVED_AT_UTC,ORIGIN,DISPOSITION)
 SELECT 'id:water','water','accepted','signal-water','2026-11-01T22:00:00','2026-11-02T08:00:00','forward','new_signal';
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_ARTICLE_SIGHTINGS (OBSERVATION_KEY,PROVIDER_ID,ORIGIN,OBSERVED_AT_UTC,HANDLED_AT_UTC,DISPOSITION,REASON)
 SELECT 'id:water','water','forward','2026-11-01T23:50:00','2026-11-01T23:51:00','unusable','missing_status' UNION ALL
 SELECT 'id:water','water','forward','2026-11-02T08:00:00','2026-11-02T08:01:00','unusable','missing_headline';
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_ARTICLE_SIGHTINGS (OBSERVATION_KEY,PROVIDER_ID,ORIGIN,OBSERVED_AT_UTC,HANDLED_AT_UTC,SIGNAL_ID,ORIGINAL_URL,CANONICAL_URL,PUBLISHER,HEADLINE,DISPOSITION)
 SELECT 'id:water','water','reconcile','2026-11-02T10:00:00','2026-11-02T10:01:00','signal-water','https://trade.example/refill','https://trade.example/refill','trade.example','Refill stores expand','new_signal';
INSERT INTO FIX_REPORT_STG_NATIVE_ARTICLE_SIGHTINGS (SOURCE_NAME,NATIVE_SIGNAL_ID,SIGNAL_ID,ORIGINAL_URL,CANONICAL_URL,OBSERVED_AT_UTC,SIGNAL_TITLE)
 SELECT 'gdelt','gdelt_hash','signal-water','https://trade.example/refill','https://trade.example/refill','2026-11-03T10:00:00','The first refill stores';
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_RUNS (WINDOW_ID,ORIGIN,FROM_UTC,TO_UTC,STARTED_AT_UTC,COMPLETED_AT_UTC)
 SELECT 'poll-'||i,'forward',DATEADD(hour,i-1,'${start}'::TIMESTAMP_NTZ),DATEADD(hour,i,'${start}'::TIMESTAMP_NTZ) AS TO_UTC,
 DATEADD(minute,7,TO_UTC),DATEADD(minute,8,TO_UTC) FROM (SELECT ROW_NUMBER() OVER(ORDER BY SEQ4())-1 i FROM TABLE(GENERATOR(ROWCOUNT=>168)));
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_PAGES (WINDOW_ID,PAGE_NUMBER,OBSERVED_AT_UTC,ARTICLES,COMMITTED_AT_UTC,COUNTS)
 SELECT WINDOW_ID,0,STARTED_AT_UTC,ARRAY_CONSTRUCT(),COMPLETED_AT_UTC,OBJECT_CONSTRUCT('accepted_rows',0) FROM FIX_REPORT_STG_TREND_HUNTER_RUNS;
INSERT INTO FIX_REPORT_FCT_SIGNALS (SIGNAL_ID,SOURCE_NAME,SIGNAL_TITLE,SIGNAL_TEXT,EMBEDDED_AT,SIGNAL_VECTOR)
 SELECT 'signal-water','trend_hunter','Refill stores expand','Six new refill stores opened','2026-11-02T05:03:00',ARRAY_GENERATE_RANGE(0,1024)::VECTOR(FLOAT,1024);
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_ARTICLES (OBSERVATION_KEY,PROVIDER_ID,STATUS,FIRST_OBSERVED_AT_UTC,ORIGIN,DISPOSITION)
 SELECT 'id:independent','independent','accepted','2026-11-04T15:00:00','forward','new_signal';
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_ARTICLE_SIGHTINGS (OBSERVATION_KEY,ORIGIN,OBSERVED_AT_UTC,HANDLED_AT_UTC,SIGNAL_ID,ORIGINAL_URL,PUBLISHER,HEADLINE,DISPOSITION)
 SELECT 'id:independent','forward','2026-11-04T15:00:00','2026-11-04T15:01:00','union-report','https://local.example/workers','local.example','Workers at refill stores organize','new_signal';
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_OPPORTUNITIES
 SELECT 'op-early','2026-11-02T12:00:00','main','d1','sess-a',168,320,1600,150,152,TRUE UNION ALL
 SELECT 'op-later','2026-11-03T12:00:00','main','d2','sess-b',168,320,1600,150,153,TRUE;
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_POOL_SIGNALS (OPPORTUNITY_ID,SIGNAL_ID,INPUT_ORDINAL,SOURCE_NAME,SIGNAL_TITLE,SIGNAL_TEXT,INGESTED_AT_UTC,EMBEDDED_AT_UTC,SIGNAL_KIND,HAD_PROMOTED_CANDIDATE,CREDITED_SIGNAL_ID,POOL_RANK)
 SELECT o.OPPORTUNITY_ID,'filler-'||i,1,'bluesky','Other topic','Other topic',DATEADD(hour,-3,o.OBSERVED_AT_UTC),DATEADD(hour,-2,o.OBSERVED_AT_UTC),'discovery_signal',FALSE,'filler-'||i,i+3
 FROM FIX_REPORT_STG_TREND_HUNTER_OPPORTUNITIES o,(SELECT ROW_NUMBER() OVER(ORDER BY SEQ4()) i FROM TABLE(GENERATOR(ROWCOUNT=>150))) f
 UNION ALL SELECT o.OPPORTUNITY_ID,'social',1,'bluesky','Residents refill bottles','Interviews at refill stores','2026-11-02T10:30:00','2026-11-02T10:35:00','discovery_signal',FALSE,'social',1 FROM FIX_REPORT_STG_TREND_HUNTER_OPPORTUNITIES o
 UNION ALL SELECT o.OPPORTUNITY_ID,'signal-water',1,'trend_hunter','Six stores open','Reporting on new openings','2026-11-02T10:01:00','2026-11-02T10:03:00','discovery_signal',FALSE,'signal-water',2 FROM FIX_REPORT_STG_TREND_HUNTER_OPPORTUNITIES o
 UNION ALL SELECT 'op-later','native-news',1,'agent_grok_discovery','Local openings','More refill stores open','2026-11-03T10:45:00','2026-11-03T10:50:00','discovery_signal',FALSE,'native-news',3;
INSERT INTO FIX_REPORT_STG_TREND_CANDIDATES (CANDIDATE_ID,CREATED_AT,TOPIC,QUERY,SUPPORTING_SIGNAL_IDS,CONFIDENCE,SPECIFICITY_SCORE,CHAIN_ID)
 SELECT 'candidate-refills','2026-11-03T09:00:00','New refill stores','refill station',ARRAY_CONSTRUCT('signal-water','social','native-news'),0.8,0.9,'d2';
INSERT INTO FIX_REPORT_FCT_TRENDS (TREND_ID,CANDIDATE_ID,TREND_TOPIC,PROMOTED_AT)
 SELECT 'water-trend','candidate-refills','New refill stores','2026-11-04T03:01:00' UNION ALL
 SELECT 'retail-trend','older-candidate','Water retail','2026-10-31T05:00:00';
INSERT INTO FIX_REPORT_FCT_PROMOTION_LEDGER (AUDIT_ID,CANDIDATE_ID,CHAIN_ID,ITERATION,DECIDED_AT,DECISION,TARGET_TREND_ID)
 SELECT 'mint-audit','candidate-refills','p1',1,'2026-11-04T03:02:00','PROMOTE_NEW','water-trend';
INSERT INTO FIX_REPORT_STG_ATTRIBUTION_BATCHES (BATCH_NAME,CHAIN_ID,TREND_IDS,POOLS,SUBMITTED_AT,STATE,UPDATED_AT)
 SELECT 'fixture-batch','attr1',ARRAY_CONSTRUCT('retail-trend'),PARSE_JSON('{"retail-trend":[{"signal_id":"signal-water","similarity":0.6}]}'),
 '2026-11-03T06:00:00','COLLECTED','2026-11-03T09:00:00';
INSERT INTO FIX_REPORT_FCT_TREND_SIGNALS VALUES ('retail-trend','signal-water','attributed','news','2026-11-03T09:00:00');
INSERT INTO FIX_REPORT_FCT_TREND_ENRICHMENT_LEDGER (ENRICHMENT_ID,TREND_ID,ENRICHMENT_KIND,WRITTEN_AT,PAYLOAD)
 SELECT 'old-fact','retail-trend','initial','2026-11-01T12:00:00',PARSE_JSON('{"evidence":[{"claim":"Businesses are planning a refill trial"}]}') UNION ALL
 SELECT 'future-fact','retail-trend','refinement','2026-11-05T12:00:00',PARSE_JSON('{"evidence":[{"claim":"The stores opened"}]}');
INSERT INTO FIX_REPORT_STG_EXTERNAL_SIGNALS (SIGNAL_ID,SOURCE_NAME,INGESTED_AT)
 SELECT 'https://local.example/workers','gemini_other','2026-11-05T10:00:00';
INSERT INTO FIX_REPORT_STG_NATIVE_ARTICLE_SIGHTINGS (SOURCE_NAME,NATIVE_SIGNAL_ID,SIGNAL_ID,ORIGINAL_URL,CANONICAL_URL,OBSERVED_AT_UTC)
 SELECT 'gemini_other','https://local.example/workers','union-report','https://local.example/workers','https://local.example/workers','2026-11-06T15:00:00';
INSERT INTO FIX_REPORT_STG_ARTICLE_ALIAS_HISTORY VALUES
 ('native-b','older-a','https://archive.example/older-a','2026-10-01T00:00:00','2026-11-03T09:00:00');
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_ARTICLE_SIGHTINGS (OBSERVATION_KEY,ORIGIN,OBSERVED_AT_UTC,HANDLED_AT_UTC,SIGNAL_ID,DISPOSITION)
 SELECT 'id:old-a','forward','2026-10-01T00:00:00','2026-10-01T00:01:00','older-a','new_signal';
INSERT INTO FIX_REPORT_STG_NATIVE_ARTICLE_SIGHTINGS (SOURCE_NAME,NATIVE_SIGNAL_ID,SIGNAL_ID,ORIGINAL_URL,CANONICAL_URL,OBSERVED_AT_UTC)
 SELECT 'gdelt','native-b','older-a','https://local.example/native-b','https://local.example/native-b','2026-11-03T09:05:00';
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_POOL_SIGNALS (OPPORTUNITY_ID,SIGNAL_ID,INPUT_ORDINAL,SOURCE_NAME,SIGNAL_TITLE,INGESTED_AT_UTC,EMBEDDED_AT_UTC,SIGNAL_KIND,HAD_PROMOTED_CANDIDATE,CREDITED_SIGNAL_ID,POOL_RANK)
 SELECT o.OPPORTUNITY_ID,'native-b',1,'gdelt','Original native headline','2026-11-02T07:00:00','2026-11-02T07:01:00','discovery_signal',FALSE,
 IFF(o.OPPORTUNITY_ID='op-early','native-b','older-a'),IFF(o.OPPORTUNITY_ID='op-early',151,NULL) FROM FIX_REPORT_STG_TREND_HUNTER_OPPORTUNITIES o;
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_OPPORTUNITIES
 SELECT column1,'2026-11-07T12:00:00','revisit',column1,'sess-revisit',48,320,1600,1,4,TRUE
 FROM VALUES ('revisit-same'),('revisit-different');
INSERT INTO FIX_REPORT_STG_TREND_HUNTER_POOL_SIGNALS (OPPORTUNITY_ID,SIGNAL_ID,INPUT_ORDINAL,SOURCE_NAME,INGESTED_AT_UTC,EMBEDDED_AT_UTC,CLAIM_SESSION_ID,SIGNAL_KIND,HAD_PROMOTED_CANDIDATE,CREDITED_SIGNAL_ID,POOL_RANK)
 SELECT o.OPPORTUNITY_ID,b.id,1,IFF(o.OPPORTUNITY_ID='revisit-different' AND b.r=4,'trend_hunter','bluesky'),
 DATEADD(minute,-b.r,'2026-11-07T10:00:00'::TIMESTAMP_NTZ),'2026-11-07T10:05:00','sess-main','discovery_signal',FALSE,b.id,b.r
 FROM FIX_REPORT_STG_TREND_HUNTER_OPPORTUNITIES o CROSS JOIN (SELECT column1 id,column2 r FROM VALUES ('batch-a',1),('batch-b',2),('batch-c',3),('omitted',4)) b WHERE o.LANE='revisit';
INSERT INTO FIX_REPORT_STG_REVISIT_BATCH_QUEUE (CHAIN_ID,AGENT_SESSION_ID,BATCH_INDEX,TOTAL_BATCHES,CLUSTER_ROWS,SIGNAL_IDS_JSON,SIGNAL_COUNT,STATUS,CREATED_AT,UPDATED_AT)
 SELECT o.CHAIN_ID,o.SESSION_ID,b.idx,2,ARRAY_CONSTRUCT(),b.ids,b.n,'DONE','2026-11-07T07:01:00','2026-11-07T07:10:00'
 FROM FIX_REPORT_STG_TREND_HUNTER_OPPORTUNITIES o CROSS JOIN (SELECT column1 idx,column2 ids,column3 n
 FROM VALUES (0,'["batch-a","batch-b"]',2),(1,'["batch-c"]',1)) b WHERE o.LANE='revisit';
INSERT INTO FIX_REPORT_STG_TREND_CANDIDATES (CANDIDATE_ID,CREATED_AT,TOPIC,QUERY,SUPPORTING_SIGNAL_IDS,CHAIN_ID)
 SELECT 'prior-fixture','2026-10-31T10:00:00','Earlier topics','earlier topics',
 ARRAY_CONSTRUCT('batch-a','batch-b','batch-c','omitted','native-b'),'prior-chain';
SET cutoff='${cutoff}T00:00:00Z'::TIMESTAMP_TZ;
SET report_snapshot=CURRENT_TIMESTAMP();`);
console.log(fixture(read('services/trend-hunter-ingest/report.sql')));

if (scenario === 'linked') console.log(`
SELECT 'legacy Gemini exact URL uses its earlier surviving receipt even with a later resolver receipt' CHECK_NAME,
  1 / IFF((SELECT native='2026-11-05T15:00:00' AND native_clock='surviving_staging' FROM THR_ARTICLES WHERE id='id:independent'),1,0) PASSED;
SELECT 'an already embedded native alias keeps its own rank and vector before and after verification with its owner outside the pool' CHECK_NAME,
  1 / IFF((SELECT COUNT(*)=2 AND COUNT_IF(op='op-early' AND story='native-b')=1 AND COUNT_IF(op='op-later' AND story='older-a')=1
    AND COUNT_IF(source='gdelt' AND title='Original native headline' AND embedded='2026-11-02T07:01:00'
      AND ingested='2026-11-02T07:00:00' AND rank IS NOT NULL AND representation='staging_snapshot')=2
    FROM THR_NATIVE_POOL WHERE signal='native-b'),1,0) PASSED;`);
