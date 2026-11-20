import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {preparePage} from '../services/trend-hunter-ingest/ingest.mjs';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const isolate = sql => sql.trim().replace(/;$/, '').replaceAll('MCC_RAW.MARKETING_DEV.', 'FIX_JOB_')
  .replaceAll('MCC_PRESENTATION.TREND_AGENT.', 'FIX_JOB_')
  .replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE IF NOT EXISTS')
  .replace(/CREATE OR REPLACE (FUNCTION|PROCEDURE|VIEW)/g, 'CREATE OR REPLACE TEMPORARY $1');
const statements = [];
const literal = s => "'" + s.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
const check = (name, predicate) => statements.push(`SELECT ${literal(name)} CHECK_NAME, 1 / IFF((${predicate}),1,0) PASSED`);
statements.push(`CREATE TEMPORARY TABLE FIX_JOB_STG_EXTERNAL_SIGNALS
  (SIGNAL_ID VARCHAR,SOURCE_NAME VARCHAR,SIGNAL_TIMESTAMP TIMESTAMP_NTZ,SIGNAL_TITLE VARCHAR,SIGNAL_TEXT VARCHAR,
   METADATA VARIANT, URL VARCHAR, AGENT_SESSION_ID VARCHAR, INGESTED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`,
  `CREATE TEMPORARY TABLE FIX_JOB_FCT_TREND_SIGNALS (TREND_ID VARCHAR,SIGNAL_ID VARCHAR,LINK_KIND VARCHAR,LINK_TYPE VARCHAR,LINKED_AT TIMESTAMP_NTZ)`);
statements.push(`CREATE TEMPORARY TABLE FIX_JOB_FCT_SIGNALS (SIGNAL_ID VARCHAR,EMBEDDED_AT TIMESTAMP_NTZ,SIGNAL_VECTOR VECTOR(FLOAT,3))`);
for (const f of ['sql/stg_trend_candidates.sql','sql/alter_stg_trend_candidates_add_states.sql','sql/alter_stg_trend_candidates_add_query.sql',
  'sql/alter_stg_trend_candidates_add_et.sql','sql/stg_article_evidence.sql','sql/proc_merge_external_signals.sql',
  'sql/trend_hunter_intake.sql','sql/trend_hunter_comparison.sql']) {
  statements.push(isolate(read(f)));
}
const from = '2026-11-01T00:15:00.000Z';
const to = '2026-11-01T03:00:00.000Z';
const observed = '2026-11-01T03:07:01.000Z';
const article = {id: 'fixture', status: 'accepted', title: 'A city refill trial', source: 'Trade',
  url: 'https://press.example/refills', first_seen: '2026-11-01T02:00:00Z'};
const prepared = await preparePage({data:[article], observed, from, to, origin:'forward',windowId:'fixture-one',pageNumber:0});
const action = (execution, action, args = {}) => statements.push(`CALL FIX_JOB_TREND_HUNTER_INTAKE(${literal(JSON.stringify({execution,attempt:'0',action,...args}))})`);
statements.push(`UPDATE FIX_JOB_STG_TREND_HUNTER_CONTROL SET ENABLED_AT_UTC='${from}', FORWARD_THROUGH_UTC='${from}' WHERE LOCK_ID=1`);
action('fixture-one','open',{origin:'forward',now:observed});
action('fixture-overlap','open',{origin:'forward',now:'2026-11-01T04:01:00Z'});
check('overlapping forward jobs share the first fixed bounds', `SELECT COUNT(*)=1 AND MIN(FROM_UTC)='${from}' AND MAX(TO_UTC)='${to}' FROM FIX_JOB_STG_TREND_HUNTER_RUNS`);
action('fixture-one','receive',{id:'fixture-one',page_number:0,next_cursor:'page-two',data:[article],observed});
action('fixture-one','commit',{id:'fixture-one',page_number:0,...prepared});
action('fixture-overlap','commit',{id:'fixture-one',page_number:0,...prepared});
check('first page advances only its cursor and counts exactly once', `SELECT COUNT(*)=1 AND MAX(NEXT_CURSOR)='page-two' AND MAX(PAGES_COMMITTED)=1
 AND MAX(NEW_SIGNALS)=1 AND MAX(ACCEPTED_ROWS)=1 AND MAX(REPEAT_SIGHTINGS)=0 AND MAX(COMPLETED_AT_UTC) IS NULL FROM FIX_JOB_STG_TREND_HUNTER_RUNS`);
check('partial window leaves the forward checkpoint at enablement', `SELECT FORWARD_THROUGH_UTC='${from}' FROM FIX_JOB_STG_TREND_HUNTER_CONTROL`);
action('fixture-overlap','receive',{id:'fixture-one',page_number:1,next_cursor:null,data:[],observed});
action('fixture-overlap','commit',{id:'fixture-one',page_number:1,signals:[],accepted:0});
check('terminal page commits the original upper bound', `SELECT FORWARD_THROUGH_UTC='${to}' FROM FIX_JOB_STG_TREND_HUNTER_CONTROL`);
check('accepted signal and original receipt survive overlap', `SELECT COUNT(*)=1 AND MAX(FIRST_OBSERVED_AT_UTC)='${observed}' AND MAX(PUBLISHER)='press.example'
 FROM FIX_JOB_STG_TREND_HUNTER_ARTICLES`);
const native = {SIGNAL_ID:'gdelt_repeat',SOURCE_NAME:'gdelt',SIGNAL_TITLE:'Independent native headline',SIGNAL_TEXT:'Native reporting context',
  SIGNAL_TIMESTAMP:'2026-11-01T02:30:00Z',METADATA:JSON.stringify({url:article.url,signal_kind:'discovery_signal'})};
statements.push(`CALL FIX_JOB_MERGE_EXTERNAL_SIGNALS(${literal(JSON.stringify([native,{...native,SIGNAL_TEXT:'Second observable input'}]))},'sess-fixture',500,'STG_EXTERNAL_SIGNALS')`);
check('both native representations survive merge suppression', `SELECT COUNT(*)=2 AND COUNT(DISTINCT INPUT_INDEX)=2 AND COUNT(DISTINCT BATCH_ID)=1
 AND COUNT_IF(SIGNAL_TEXT='Second observable input')=1 AND MIN(SIGNAL_TITLE)='Independent native headline'
 AND MIN(MERGE_SESSION_ID)='sess-fixture' AND MIN(SIGNAL_ID)='https://press.example/refills'
 FROM FIX_JOB_STG_NATIVE_ARTICLE_SIGHTINGS WHERE NATIVE_SIGNAL_ID='gdelt_repeat'`);
check('accepted version identifies the poll, eligibility and actual handling clock', `SELECT COUNT(*)=1 AND MAX(WINDOW_ID)='fixture-one'
 AND MIN(OBSERVED_AT_UTC)='${observed}' AND MIN(HANDLED_AT_UTC)>=MIN(OBSERVED_AT_UTC) AND MAX(DISPOSITION)='new_signal'
 FROM FIX_JOB_STG_TREND_HUNTER_ARTICLE_SIGHTINGS WHERE PROVIDER_ID='fixture'`);
check('a later verified redirect is available as-of its warehouse timestamp', `SELECT COUNT(*)=1 AND MAX(CREDITED_SIGNAL_ID)='https://press.example/refills'
 AND MAX(VERIFIED_AT_UTC) IS NOT NULL FROM FIX_JOB_STG_ARTICLE_ALIAS_HISTORY WHERE SIGNAL_ID='gdelt_repeat'`);
statements.push(`INSERT INTO FIX_JOB_STG_EXTERNAL_SIGNALS (SIGNAL_ID,SOURCE_NAME,SIGNAL_TITLE,SIGNAL_TEXT,AGENT_SESSION_ID,INGESTED_AT)
  SELECT 'native-claimed','bluesky','Native angle','Account of a new trial','sess-prior',DATEADD(minute,-10,CURRENT_TIMESTAMP())
  UNION ALL SELECT 'native-overflow','bluesky','Third study','Trial extended',NULL,DATEADD(minute,-30,CURRENT_TIMESTAMP())
  UNION ALL SELECT 'native-selected','rss','A duplicate','Earlier claim','sess-duplicate',DATEADD(minute,-12,CURRENT_TIMESTAMP())
  UNION ALL SELECT 'native-selected','bluesky','Second study','Shop adds station',NULL,DATEADD(minute,-15,CURRENT_TIMESTAMP())`);
statements.push(`INSERT INTO FIX_JOB_FCT_SIGNALS SELECT 'native-selected',CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,[1,0,0]::VECTOR(FLOAT,3)
  UNION ALL SELECT 'native-selected',DATEADD(hour,-1,CURRENT_TIMESTAMP())::TIMESTAMP_NTZ,NULL`);
statements.push(`INSERT INTO FIX_JOB_STG_TREND_CANDIDATES (CANDIDATE_ID,CREATED_AT,TOPIC,QUERY,SUPPORTING_SIGNAL_IDS,CHAIN_ID)
  SELECT 'candidate1',CURRENT_TIMESTAMP(),'Refill stores','refill stores',ARRAY_CONSTRUCT('native-selected'),'chain-fixture'`);
statements.push(`CALL FIX_JOB_ACQUIRE_ARTICLE_COMPARISON_POOL('main','chain-main','sess-main',168,1,2,150)`);
check('the main floor and actual selected rows are preserved', `SELECT COUNT(*)=1 AND MAX(SELECTED_COUNT)=1 AND NOT BOOLOR_AGG(PASSED_FLOOR)
 FROM FIX_JOB_STG_TREND_HUNTER_OPPORTUNITIES WHERE LANE='main'`);
check('overflow and claimed native representations survive alongside the selected evidence', `SELECT COUNT_IF(SIGNAL_ID='native-selected' AND POOL_RANK IS NOT NULL AND EMBEDDED_AT_UTC IS NOT NULL)=1
 AND COUNT_IF(SIGNAL_ID='native-selected' AND CLAIM_SESSION_ID='sess-duplicate' AND POOL_RANK IS NULL)=1
 AND COUNT_IF(SIGNAL_ID='native-selected')=2 AND COUNT_IF(SIGNAL_ID='native-overflow' AND POOL_RANK IS NULL AND SIGNAL_TEXT='Trial extended')=1
 AND COUNT_IF(SIGNAL_ID='native-claimed' AND CLAIM_SESSION_ID='sess-prior' AND POOL_RANK IS NULL)=1
 FROM FIX_JOB_STG_TREND_HUNTER_POOL_SIGNALS`);
statements.push(`UPDATE FIX_JOB_STG_EXTERNAL_SIGNALS SET AGENT_SESSION_ID='sess-main' WHERE SIGNAL_ID='native-selected'`);
statements.push(`UPDATE FIX_JOB_STG_TREND_CANDIDATES SET PROMOTED_TO='minted' WHERE CANDIDATE_ID='candidate1'`);
statements.push(`CALL FIX_JOB_ACQUIRE_ARTICLE_COMPARISON_POOL('revisit','chain-revisit','sess-revisit',48,320,1600,1)`);
check('a later revisit excludes previous promotions and leaves the main capture intact', `SELECT COUNT_IF(o.LANE='revisit' AND s.SIGNAL_ID='native-selected'
 AND s.HAD_PROMOTED_CANDIDATE AND s.POOL_RANK IS NULL)=2 AND COUNT_IF(o.LANE='main' AND s.SIGNAL_ID='native-selected' AND s.CLAIM_SESSION_ID IS NULL AND s.POOL_RANK IS NOT NULL)=1
 AND COUNT_IF(o.LANE='revisit' AND s.SIGNAL_ID='native-claimed' AND s.POOL_RANK IS NOT NULL)=1
 FROM FIX_JOB_STG_TREND_HUNTER_POOL_SIGNALS s JOIN FIX_JOB_STG_TREND_HUNTER_OPPORTUNITIES o USING(OPPORTUNITY_ID)`);
action('fixture-births','open',{origin:'forward',now:observed});
check('the initial candidate evidence is durable without later promotion state', `SELECT COUNT(*)=1 AND MIN(CANDIDATE:QUERY::VARCHAR)='refill stores'
 AND MIN(CANDIDATE:PROMOTED_TO::VARCHAR) IS NULL FROM FIX_JOB_STG_TREND_HUNTER_CANDIDATE_VERSIONS WHERE PHASE='created' AND CANDIDATE_ID='candidate1'`);
statements.push(isolate(read('sql/proc_promotion_apply.sql')));
const decision = item => statements.push(`CALL FIX_JOB_PROC_PROMOTION_APPLY(PARSE_JSON(${literal(JSON.stringify([item]))}),'review-chain',1)`);
decision({candidate_id:'candidate1',decision:'DEFER',defer_reason:'Independent source pending'});
decision({candidate_id:'candidate1',decision:'MERGE_INTO_CANDIDATE',target_candidate_id:'missing',rationale:'Unconfirmed target'});
check('committed decisions retain both candidate states and rolled-back decisions leave no comparison evidence',
  `SELECT COUNT(*)=2 AND COUNT_IF(PHASE='before_decision' AND CANDIDATE:DEFERRED_UNTIL::VARCHAR IS NULL)=1
   AND COUNT_IF(PHASE='after_decision' AND CANDIDATE:DEFER_REASON::VARCHAR='Independent source pending')=1
   AND COUNT_IF(DECISION:decision::VARCHAR='DEFER')=2 FROM FIX_JOB_STG_TREND_HUNTER_CANDIDATE_VERSIONS WHERE PHASE!='created'`);
const late = {...article,id:'late',url:'https://another.example/report',title:'Accepted on reconciliation'};
const previouslyUnusable={...article,id:'repair',url:'https://news.example/correction',title:''};
const reconcileAt='2026-11-08T00:17:00.000Z';
const reconcileEnd='2026-11-08T00:00:00.000Z';
action('reconcile','open',{origin:'reconcile',now:reconcileAt});
action('reconcile','receive',{id:'reconcile',page_number:0,next_cursor:null,data:[article,late,previouslyUnusable],observed:reconcileAt});
const reconcile=await preparePage({data:[article,late,previouslyUnusable],observed:reconcileAt,origin:'reconcile',from,to:reconcileEnd,windowId:'reconcile',pageNumber:0});
action('reconcile','commit',{id:'reconcile',page_number:0,...reconcile});
check('reconciliation catches later acceptance and leaves forward progress untouched', `SELECT COUNT(*)=1 AND MAX(FROM_UTC)='${from}'
 AND MAX(TO_UTC)='${reconcileEnd}' AND MAX(NEW_SIGNALS)=1 AND MAX(REPEAT_SIGHTINGS)=1 AND MAX(UNUSABLE_RECORDS)=1
 FROM FIX_JOB_STG_TREND_HUNTER_RUNS WHERE ORIGIN='reconcile'`);
const replayAt='2026-11-11T01:00:00.000Z';
const repaired={...previouslyUnusable,title:'Corrected headline'};
action('manual','open',{origin:'replay',from,to,now:replayAt});
action('manual','receive',{id:'manual',page_number:0,data:[article,repaired],next_cursor:null,observed:replayAt});
const replay=await preparePage({data:[article,repaired],observed:replayAt,origin:'replay',from,to,windowId:'manual',pageNumber:0});
statements.push(`CREATE OR REPLACE TEMPORARY PROCEDURE FIX_JOB_EXPECT_INTAKE_ERROR(PAYLOAD VARCHAR)
 RETURNS BOOLEAN LANGUAGE JAVASCRIPT AS $$
 try {snowflake.execute({sqlText:'CALL FIX_JOB_TREND_HUNTER_INTAKE(?)',binds:[PAYLOAD]});}
 catch (error) {return true;} throw new Error('Expected an intake failure');
 $$`);
statements.push(`CALL FIX_JOB_EXPECT_INTAKE_ERROR(${literal(JSON.stringify({execution:'manual',attempt:'0',action:'commit',id:'manual',page_number:0,...replay,accepted:'bad-count'}))})`);
check('a failed page after the signal merge rolls back facts and metrics and keeps the original list receipt',
 `SELECT (SELECT COUNT(*) FROM FIX_JOB_STG_EXTERNAL_SIGNALS WHERE SIGNAL_ID='https://news.example/correction')=0
 AND (SELECT COUNT(*) FROM FIX_JOB_STG_TREND_HUNTER_ARTICLE_SIGHTINGS WHERE WINDOW_ID='manual')=0
 AND (SELECT COMMITTED_AT_UTC IS NULL AND OBSERVED_AT_UTC='${replayAt}' FROM FIX_JOB_STG_TREND_HUNTER_PAGES WHERE WINDOW_ID='manual')
 AND (SELECT PAGES_COMMITTED=0 AND ACCEPTED_ROWS=0 FROM FIX_JOB_STG_TREND_HUNTER_RUNS WHERE WINDOW_ID='manual')`);
action('manual','commit',{id:'manual',page_number:0,...replay});
check('the first accepted clock, first usable clock and replay origin can be distinguished',
 `SELECT MIN(OBSERVED_AT_UTC)='${reconcileAt}' AND MIN(IFF(DISPOSITION!='unusable',OBSERVED_AT_UTC,NULL))='${replayAt}'
 AND COUNT_IF(ORIGIN='replay' AND DISPOSITION='new_signal')=1 FROM FIX_JOB_STG_TREND_HUNTER_ARTICLE_SIGHTINGS WHERE PROVIDER_ID='repair'`);
check('a repeated window preserves first accepted clocks and unique evidence', `SELECT COUNT(*)=1 AND MIN(FIRST_OBSERVED_AT_UTC)='${observed}'
 AND MIN(ORIGIN)='forward' FROM FIX_JOB_STG_TREND_HUNTER_ARTICLES WHERE PROVIDER_ID='fixture'`);
check('reconciliation and replay leave the forward checkpoint intact', `SELECT FORWARD_THROUGH_UTC='${to}' FROM FIX_JOB_STG_TREND_HUNTER_CONTROL`);
action('next-day','open',{origin:'reconcile',now:'2026-11-12T00:17:00Z'});
check('the daily recovery horizon covers exactly seven UTC days after rollout', `SELECT FROM_UTC='2026-11-05 00:00:00' AND TO_UTC='2026-11-12 00:00:00'
 FROM FIX_JOB_STG_TREND_HUNTER_RUNS WHERE WINDOW_ID='next-day'`);
action('next-day','receive',{id:'next-day',page_number:0,data:[],next_cursor:'cycle',observed:replayAt});
action('next-day','commit',{id:'next-day',page_number:0,signals:[],accepted:0});
statements.push(`CALL FIX_JOB_EXPECT_INTAKE_ERROR(${literal(JSON.stringify({execution:'next-day',attempt:'0',action:'receive',id:'next-day',page_number:1,data:[],next_cursor:'cycle',observed:replayAt}))})`);
check('a looping cursor leaves the active page eligible for retry', `SELECT PAGES_COMMITTED=1 AND NEXT_CURSOR='cycle' AND COMPLETED_AT_UTC IS NULL
 FROM FIX_JOB_STG_TREND_HUNTER_RUNS WHERE WINDOW_ID='next-day'`);
action('next-day','cooldown',{retry_at:'2026-11-12T02:00:00Z'});
action('other','cooldown',{retry_at:'2026-11-12T01:00:00Z'});
check('a shorter cooldown never reopens the shared provider quota early', `SELECT RETRY_AT_UTC='2026-11-12 02:00:00' FROM FIX_JOB_STG_TREND_HUNTER_CONTROL`);
action('next-day','save_proof',{id:'next-day',page_number:1,provider_id:'wire',proof:null});
action('overlap','save_proof',{id:'next-day',page_number:1,provider_id:'wire',proof:{text_sha256:'example'}});
check('concurrent detail verification keeps the first durable result, including an unverified detail',
 `SELECT COUNT(*)=1 AND COUNT_IF(RELEASE_PROOF IS NULL OR IS_NULL_VALUE(RELEASE_PROOF))=1 FROM FIX_JOB_STG_TREND_HUNTER_DETAILS`);
const sql=statements.join(';\n')+';\n';
assert.doesNotMatch(sql.replace(/^\s*--.*$/gm,''),/MCC_(?:RAW|PRESENTATION)\./);
assert.doesNotMatch(sql,/^CREATE (?:OR REPLACE )?(?:VIEW|TABLE|FUNCTION|PROCEDURE|TASK)\b/mi);
process.stdout.write(sql);
