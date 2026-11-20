import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SET_QUERIES as attribution} from '../services/lib/attribution_context.mjs';
import {SET_QUERIES as lifecycle} from '../services/lib/lifecycle_context.mjs';
import {preparePage} from '../services/trend-hunter-ingest/ingest.mjs';

const prefix = 'FIX_TH_';
function isolated(sql) {
  return sql.trim().replace(/;$/, '').replaceAll('MCC_RAW.MARKETING_DEV.', prefix).replaceAll('MCC_PRESENTATION.TREND_AGENT.', prefix)
    .replace(/CREATE TABLE IF NOT EXISTS/g, 'CREATE TEMPORARY TABLE IF NOT EXISTS')
    .replace(/CREATE OR REPLACE (FUNCTION|PROCEDURE|VIEW)/g, 'CREATE OR REPLACE TEMPORARY $1');
}
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const literal = value => "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
const statements = [`CREATE TEMPORARY TABLE FIX_TH_STG_EXTERNAL_SIGNALS (
  SIGNAL_ID VARCHAR, SOURCE_NAME VARCHAR, SIGNAL_TIMESTAMP TIMESTAMP_NTZ,
  SIGNAL_TITLE VARCHAR, SIGNAL_TEXT VARCHAR, URL VARCHAR, METADATA VARIANT, AGENT_SESSION_ID VARCHAR,
  INGESTED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`];
statements.push(`CREATE TEMPORARY TABLE FIX_TH_FCT_TREND_SIGNALS (TREND_ID VARCHAR,SIGNAL_ID VARCHAR,LINK_KIND VARCHAR,LINK_TYPE VARCHAR,LINKED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`);
const article = {id: 'a1', url: 'https://www.paper.example/article?utm_campaign=th', title: 'A city changes',
  first_seen: '2026-11-01T07:00:00-04:00', published_at: null, status: 'accepted', verdict: 'queued', source: 'General news'};
let observed = '2026-11-01T13:00:00Z';
function stage(rows) {
  const proc = prefix + 'MERGE_EXTERNAL_SIGNALS';
  statements.push(`CALL ${proc}(${literal(JSON.stringify(rows))}, '', 500, 'STG_EXTERNAL_SIGNALS')`);
}
async function intake(items, origin = 'forward') {
  const {signals} = await preparePage({from:'2026-11-01T00:00:00.000Z', to:'2026-11-02T00:00:00.000Z',
    origin, observed:new Date(observed).toISOString(), data:items});
  stage(signals);
}
statements.push(`INSERT INTO FIX_TH_STG_EXTERNAL_SIGNALS (SIGNAL_ID,SOURCE_NAME,SIGNAL_TITLE,METADATA,INGESTED_AT)
 SELECT 'gdelt_prelaunch','gdelt','First receipt',PARSE_JSON('{"url":"https://www.archive.example/report?utm_source=old","domain":"archive.example"}'),
 '2026-10-15 12:00:00'::TIMESTAMP_NTZ`);
statements.push(isolated(read('sql/stg_article_evidence.sql')), isolated(read('sql/proc_merge_external_signals.sql')));
await intake([article, {...article, id: 'bad', title: ''}, {...article, id: 'no', status: 'rejected'}]);
observed = '2026-11-02T02:00:00Z';
await intake([article]);
const check = (label, predicate) => statements.push(`SELECT ${literal(label)} AS CHECK_NAME, 1 / IFF((${predicate}),1,0) AS PASSED`);
check('first observation and origin survive replay', `SELECT COUNT(*)=1 FROM FIX_TH_STG_TREND_HUNTER_ARTICLES
 WHERE PROVIDER_ID='a1' AND ORIGINAL_URL='https://www.paper.example/article?utm_campaign=th'
 AND SIGNAL_ID='https://paper.example/article' AND PUBLISHER='paper.example' AND FEED_LABEL='General news' AND VERDICT='queued'
 AND FIRST_SEEN_UTC='2026-11-01 11:00:00' AND FIRST_OBSERVED_AT_UTC='2026-11-01 13:00:00' AND PUBLISHED_AT_UTC IS NULL AND ORIGIN='forward'`);
check('only the eligible story reaches staging', `SELECT COUNT(*)=1 AND MIN(SIGNAL_TITLE)='A city changes'
 AND MIN(SIGNAL_TEXT)='A city changes' FROM FIX_TH_STG_EXTERNAL_SIGNALS WHERE SOURCE_NAME='trend_hunter'`);
check('malformed article has a reason and a rejected article produces no observation', `SELECT COUNT(*)=2
 AND COUNT_IF(DISPOSITION='unusable' AND REASON='missing_headline' AND SIGNAL_ID IS NULL)=1 FROM FIX_TH_STG_TREND_HUNTER_ARTICLES`);
const eventual = {...article, id:'eventual', url:'https://status.example/accepted'};
const corrected = {...article, id:'corrected', url:'https://status.example/corrected'};
observed = '2026-11-02T04:00:00Z';
await intake([{...eventual,status:null},{...corrected,title:''}], 'replay');
observed = '2026-11-02T06:00:00Z';
await intake([eventual,corrected], 'reconcile');
observed = '2026-11-02T03:00:00Z';
await intake([{...eventual,status:null},{...corrected,title:''}], 'forward');
check('malformed polls before acceptance never set the accepted clock or origin, including late-arriving writes',
  `SELECT (SELECT COUNT(*)=2 FROM FIX_TH_STG_TREND_HUNTER_ARTICLE_SIGHTINGS WHERE PROVIDER_ID='eventual' AND REASON='missing_status')
   AND FIRST_OBSERVED_AT_UTC='2026-11-02 06:00:00' AND ORIGIN='reconcile' AND DISPOSITION='new_signal'
   FROM FIX_TH_STG_TREND_HUNTER_ARTICLES WHERE PROVIDER_ID='eventual'`);
check('the earliest accepted but unusable poll keeps its clock and origin after repair in either arrival order',
  `SELECT FIRST_OBSERVED_AT_UTC='2026-11-02 03:00:00' AND ORIGIN='forward' AND DISPOSITION='new_signal'
   FROM FIX_TH_STG_TREND_HUNTER_ARTICLES WHERE PROVIDER_ID='corrected'`);
await intake([{...article,id:'legacy',url:'https://archive.example/report#new'}]);
check('a pre-install hashed native writer keeps its identity and origin time is not invented for old discarded native receipts',
  `SELECT (SELECT COUNT(*) FROM FIX_TH_STG_TREND_HUNTER_ARTICLES WHERE PROVIDER_ID='legacy' AND SIGNAL_ID='gdelt_prelaunch' AND DISPOSITION='repeat')=1
   AND (SELECT COUNT(*) FROM FIX_TH_STG_NATIVE_ARTICLE_SIGHTINGS WHERE SIGNAL_ID='gdelt_prelaunch')=0`);
const wire = 'https://www.prnewswire.com/news-releases/refill-trial-302123456.html';
const native = (id, url, source) => ({SIGNAL_ID: id,SOURCE_NAME:source, SIGNAL_TITLE:'Native first headline',
  SIGNAL_TEXT:'Coverage',SIGNAL_TIMESTAMP:'2026-11-01 12:00:00',METADATA:JSON.stringify({url,domain:new URL(url).hostname.replace(/^www[.]/,''),publisher:new URL(url).hostname.replace(/^www[.]/,'')})});
const independent = {...article,id:'independent',url:'https://reporter.example/refill-trial',title:'Refill trial'};
const copy = {...article,id:'copy',url:'https://partner.example/refill-trial',title:independent.title,
  summary:'View original content to download multimedia: '+wire};
stage([native('gdelt_native',wire,'gdelt'),native('https://partner.example/refill-trial',copy.url,'google_trends_rss')]);
await intake([copy,independent]);
check('late release verification retains both native facts and credits the earlier one', `SELECT COUNT(*)=1
 FROM FIX_TH_FCT_ARTICLE_SIGNAL_ALIASES WHERE SIGNAL_ID='https://partner.example/refill-trial' AND CREDITED_SIGNAL_ID='gdelt_native'`);
check('provider copies still identify the credited native signal', `SELECT COUNT(*)=1 FROM FIX_TH_STG_TREND_HUNTER_ARTICLES
 WHERE PROVIDER_ID='copy' AND DISPOSITION='syndicated' AND SIGNAL_ID='gdelt_native' AND PUBLISHER='partner.example'`);
const otherWire = 'https://prnewswire.com/news-releases/e-bike-trial-302123457.html';
await intake([{...copy,id:'copy-first',url:'https://partner-two.example/e-bike',
  summary:'View original content: '+otherWire}]);
stage([native('gdelt_after',otherWire,'gdelt')]);
check('direct-first copies and hashed native sightings converge on the existing direct signal',
  `SELECT COUNT(*)=1 FROM FIX_TH_STG_NATIVE_ARTICLE_SIGHTINGS WHERE NATIVE_SIGNAL_ID='gdelt_after'
   AND SIGNAL_ID='https://partner-two.example/e-bike'`);
check('independent reporting remains an eligible article despite the similar title',
  `SELECT COUNT(*)=1 FROM FIX_TH_STG_EXTERNAL_SIGNALS WHERE SIGNAL_ID='https://reporter.example/refill-trial'`);
const geminiUrl = 'https://daily.example/gemini-story?utm_term=native';
stage([{...native(geminiUrl,geminiUrl,'gemini_other'),METADATA:JSON.stringify({source_name:'Daily news'})}]);
await intake([{...article,id:'gemini-second',url:'https://www.daily.example/gemini-story#top'}]);
stage([{...native(geminiUrl,geminiUrl,'gemini_other'),SIGNAL_TITLE:'Refreshed native owner'}]);
stage([{...native('https://www.paper.example/article?utm_campaign=gemini',article.url,'gemini_other'),SIGNAL_TITLE:'Wrong owner'}]);
check('Gemini can refresh its own signal while the earlier direct signal keeps its first headline',
  `SELECT COUNT_IF(SIGNAL_ID='${geminiUrl}' AND SIGNAL_TITLE='Refreshed native owner')=1 AND
   COUNT_IF(SIGNAL_ID='https://paper.example/article' AND SIGNAL_TITLE='A city changes')=1 FROM FIX_TH_STG_EXTERNAL_SIGNALS`);

statements.push(`CREATE TEMPORARY TABLE FIX_TH_FCT_SIGNALS (
  SIGNAL_ID VARCHAR,SOURCE_NAME VARCHAR,SIGNAL_TIMESTAMP TIMESTAMP_NTZ,SIGNAL_TITLE VARCHAR,SIGNAL_TEXT VARCHAR,
  METADATA VARIANT,SIGNAL_VECTOR VECTOR(FLOAT,3),EMBEDDED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`);
const embed = read('sql/fct_signals.sql').match(/^INSERT INTO MCC_PRESENTATION[\s\S]*?;$/m)[0];
statements.push(isolated(embed.replace(/SNOWFLAKE\.CORTEX\.EMBED_TEXT_1024\([\s\S]*?\n    \)/,'[1,0,0]::VECTOR(FLOAT,3)')));
const candidateDdl = `CREATE TEMPORARY TABLE FIX_TH_STG_TREND_CANDIDATES (
  CANDIDATE_ID VARCHAR,AGENT_SESSION_ID VARCHAR,CHAIN_ID VARCHAR,ITERATION INT,CREATED_AT TIMESTAMP_NTZ,TOPIC VARCHAR,
  QUERY VARCHAR,VERDICT VARCHAR,DEDUP_OF_TREND_ID VARCHAR,REASONING VARCHAR,SUPPORTING_SIGNAL_IDS ARRAY,SOURCE_BREAKDOWN OBJECT,
  CONFIDENCE FLOAT,SPECIFICITY_SCORE FLOAT,BUCKET VARCHAR,PROMOTED_TO VARCHAR,PROMOTED_AT TIMESTAMP_NTZ,REJECTED_AT TIMESTAMP_NTZ,DEFERRED_UNTIL TIMESTAMP_NTZ)`;
statements.push(candidateDdl);
statements.push(isolated(read('sql/trend_hunter_intake.sql')), isolated(read('sql/trend_hunter_comparison.sql')));
statements.push(`CALL FIX_TH_ACQUIRE_ARTICLE_COMPARISON_POOL('main','chain-fixture','sess-fixture',168,320,1600,150)`);
statements.push(`CREATE TEMPORARY TABLE FIX_TH_CLAIMABLE AS SELECT SIGNAL_ID FROM FIX_TH_STG_TREND_HUNTER_POOL_SIGNALS WHERE POOL_RANK IS NOT NULL`);
check('main distillation can claim the direct and independent articles and omits the verified copy',
  `SELECT COUNT_IF(SIGNAL_ID='https://paper.example/article')=1 AND COUNT_IF(SIGNAL_ID='https://reporter.example/refill-trial')=1
    AND COUNT_IF(SIGNAL_ID='https://partner.example/refill-trial')=0 FROM FIX_TH_CLAIMABLE`);
statements.push(`CREATE TEMPORARY TABLE FIX_TH_FCT_TREND_ENRICHMENT_LEDGER AS
  SELECT 'trend' TREND_ID,[1,0,0]::VECTOR(FLOAT,3) TREND_VECTOR,CURRENT_TIMESTAMP() WRITTEN_AT`);
const pool = isolated(attribution.candidate_signals.replace(':1',literal('["trend"]')));
statements.push('CREATE TEMPORARY TABLE FIX_TH_ATTRIBUTION AS '+pool);
check('the live attribution pool includes the embedded direct article and excludes the credited copy',
  `SELECT COUNT_IF(SIGNAL_ID='https://paper.example/article')=1 AND COUNT_IF(SIGNAL_ID='https://partner.example/refill-trial')=0
   FROM FIX_TH_ATTRIBUTION`);
statements.push(`INSERT INTO FIX_TH_FCT_TREND_SIGNALS (TREND_ID,SIGNAL_ID,LINK_KIND,LINK_TYPE) VALUES
 ('late','gdelt_native','supporting','news'),('late','https://partner.example/refill-trial','attributed','news'),
 ('late','https://reporter.example/refill-trial','attributed','news'),
 ('direct','https://partner-two.example/e-bike','supporting','news'),('direct','gdelt_after','attributed','news')`);
const dashboard = read('sql/dt_trend_dashboard.sql').match(/\nsignal_domains AS \([\s\S]*?\n\),\ntrend_aggregates AS \([\s\S]*?\n\),/)[0].slice(0,-1);
statements.push('CREATE TEMPORARY TABLE FIX_TH_BREADTH AS WITH '+isolated(dashboard)+' SELECT * FROM trend_aggregates');
check('the dashboard credits two publishers for a wire and an independent report, and one for the reverse-order pair',
  `SELECT COUNT_IF(TREND_ID='late' AND TOTAL_CLUSTER_SIZE=2 AND DISTINCT_SOURCE_COUNT=2)=1 AND
   COUNT_IF(TREND_ID='direct' AND TOTAL_CLUSTER_SIZE=1 AND DISTINCT_SOURCE_COUNT=1)=1 FROM FIX_TH_BREADTH`);
statements.push('CREATE TEMPORARY TABLE FIX_TH_LIFECYCLE_DOMAINS AS '+isolated(lifecycle.signal_domains
  .replace(':1',literal('["late","direct"]')).replace('DATEADD(day, -21, CURRENT_TIMESTAMP())',"'2026-10-01'::TIMESTAMP_NTZ")));
check('lifecycle breadth credits one linked signal per publisher for each independent article', `SELECT COUNT(*)=3
 AND MAX(SIGNAL_COUNT)=1 AND COUNT_IF(DOMAIN='partner.example')=0 FROM FIX_TH_LIFECYCLE_DOMAINS`);

statements.push(`INSERT INTO FIX_TH_FCT_SIGNALS (SIGNAL_ID,SIGNAL_TIMESTAMP,SIGNAL_VECTOR)
  SELECT 'linked-'||n,DATEADD(minute,n,'2026-11-02'::TIMESTAMP_NTZ),[1,0,0]::VECTOR(FLOAT,3)
  FROM (SELECT ROW_NUMBER() OVER(ORDER BY SEQ4()) n FROM TABLE(GENERATOR(ROWCOUNT=>28)))`);
statements.push(`INSERT INTO FIX_TH_FCT_TREND_SIGNALS (TREND_ID,SIGNAL_ID,LINK_KIND,LINK_TYPE)
  SELECT 'late',SIGNAL_ID,'supporting','news' FROM FIX_TH_FCT_SIGNALS WHERE SIGNAL_ID LIKE 'linked-%'`);
const recent = isolated(lifecycle.recent_signals.replace(':1',literal('["late"]'))
  .replace('DATEADD(day, -14, CURRENT_TIMESTAMP())',"'2026-10-01'::TIMESTAMP_NTZ"));
statements.push('CREATE TEMPORARY TABLE FIX_TH_RECENT AS '+recent);
check('lifecycle counts a story linked as both supporting and attributed once in recent heat evidence',
  `SELECT COUNT(*)=30 AND COUNT_IF(SIGNAL_ID='gdelt_native')=1 AND COUNT_IF(SIGNAL_ID='https://reporter.example/refill-trial')=1 FROM FIX_TH_RECENT`);
statements.push(`INSERT INTO FIX_TH_FCT_TREND_ENRICHMENT_LEDGER SELECT 'late',[0,1,0]::VECTOR(FLOAT,3),CURRENT_TIMESTAMP()`);
statements.push(`UPDATE FIX_TH_FCT_SIGNALS SET SIGNAL_VECTOR=[0,1,0]::VECTOR(FLOAT,3) WHERE SIGNAL_ID='https://partner.example/refill-trial'`);
statements.push(`INSERT INTO FIX_TH_FCT_SIGNALS (SIGNAL_ID,SIGNAL_VECTOR)
  SELECT 'new-fact-'||n,IFF(n=20,[0.2,1,0],[0,1,0])::VECTOR(FLOAT,3)
  FROM (SELECT ROW_NUMBER() OVER(ORDER BY SEQ4()) n FROM TABLE(GENERATOR(ROWCOUNT=>20)))`);
const advisory = isolated(lifecycle.candidate_signals.replace(':1',literal('["late"]')));
statements.push('CREATE TEMPORARY TABLE FIX_TH_ADVISORY AS '+advisory);
check('a linked release alias cannot occupy a lifecycle advisory slot',
  `SELECT COUNT(*)=20 AND COUNT_IF(SIGNAL_ID='https://partner.example/refill-trial')=0 AND COUNT_IF(SIGNAL_ID='new-fact-20')=1 FROM FIX_TH_ADVISORY`);

statements.push(`INSERT INTO FIX_TH_STG_TREND_CANDIDATES (CANDIDATE_ID,VERDICT,SUPPORTING_SIGNAL_IDS,SOURCE_BREAKDOWN,CONFIDENCE,SPECIFICITY_SCORE)
 SELECT column1,'REAL_TREND',PARSE_JSON(column2)::ARRAY,PARSE_JSON(column3)::OBJECT,0.8,0.8 FROM VALUES
 ('copies','["gdelt_native","https://partner.example/refill-trial"]','{"gdelt":1,"google_trends_rss":1}'),
 ('reverse','["gdelt_after","https://partner-two.example/e-bike"]','{"gdelt":1,"trend_hunter":1}'),
 ('independent','["gdelt_native","https://partner.example/refill-trial","https://reporter.example/refill-trial"]','{"gdelt":1,"google_trends_rss":1,"trend_hunter":1}')`);
statements.push(`INSERT INTO FIX_TH_FCT_ARTICLE_SIGNAL_ALIASES VALUES
  ('pending-copy-a','pending-owner','https://old.example/release',CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP()),
  ('pending-copy-b','pending-owner','https://old.example/release',CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP())`);
statements.push(`INSERT INTO FIX_TH_STG_TREND_CANDIDATES (CANDIDATE_ID,VERDICT,SUPPORTING_SIGNAL_IDS,SOURCE_BREAKDOWN,CONFIDENCE,SPECIFICITY_SCORE)
  SELECT 'pending-owner','REAL_TREND',ARRAY_CONSTRUCT('pending-copy-a','pending-copy-b'),
  OBJECT_CONSTRUCT('gdelt',1,'trend_hunter',1),0.9,0.9 UNION ALL
  SELECT 'pending-independent','REAL_TREND',ARRAY_CONSTRUCT('pending-copy-b','https://reporter.example/refill-trial'),
  OBJECT_CONSTRUCT('gdelt',1,'trend_hunter',1),0.9,0.9`);
const promotion = read('promotion-p_xMC99jg/workflow.yaml').split('- namespace: q_load_pending_candidates')[1].split('      query: |-')[0].split('      value: |-')[1];
statements.push('CREATE TEMPORARY TABLE FIX_TH_PENDING AS '+isolated(promotion));
check('source-family corroboration uses the first writer for both orders and retains the second independent family',
 `SELECT COUNT_IF(ARTICLE_COPIES_ONLY AND CLUSTER_SIZE=1 AND SOURCE_COUNT=1)=2 AND
 COUNT_IF(CANDIDATE_ID='independent' AND CLUSTER_SIZE=2 AND SOURCE_COUNT=2 AND SOURCE_BREAKDOWN:gdelt=1 AND SOURCE_BREAKDOWN:trend_hunter=1)=1 FROM FIX_TH_PENDING`);
check('promotion retains the candidate with an unembedded owner and exposes zero available supporting facts',
 `SELECT COUNT(*)=1 AND MAX(CLUSTER_SIZE)=0 AND MAX(SOURCE_COUNT)=0 AND BOOLAND_AGG(ARTICLE_COPIES_ONLY)
  FROM FIX_TH_PENDING WHERE CANDIDATE_ID='pending-owner'`);
statements.push('SELECT CANDIDATE_ID, SOURCE_BREAKDOWN, ARTICLE_COPIES_ONLY, CONFIDENCE, SPECIFICITY_SCORE FROM FIX_TH_PENDING');
check('a candidate with independently credited stories remains pending while a required owner has no vector',
  `SELECT (SELECT COUNT(*) FROM FIX_TH_PENDING WHERE CANDIDATE_ID='pending-independent')=0
   AND (SELECT COUNT(*) FROM FIX_TH_STG_TREND_CANDIDATES WHERE CANDIDATE_ID='pending-independent' AND REJECTED_AT IS NULL)=1`);
statements.push(`INSERT INTO FIX_TH_FCT_SIGNALS (SIGNAL_ID,SOURCE_NAME,SIGNAL_VECTOR)
  SELECT 'pending-owner','gdelt',[1,0,0]::VECTOR(FLOAT,3)`);
statements.push('CREATE TEMPORARY TABLE FIX_TH_EMBEDDED_PENDING AS '+isolated(promotion));
check('the same candidate enters promotion with two independent facts after its missing owner embeds',
  `SELECT COUNT(*)=1 AND MAX(CLUSTER_SIZE)=2 AND MAX(SOURCE_COUNT)=2 AND NOT BOOLOR_AGG(ARTICLE_COPIES_ONLY)
   FROM FIX_TH_EMBEDDED_PENDING WHERE CANDIDATE_ID='pending-independent'`);
statements.push("SELECT CANDIDATE_ID, SOURCE_BREAKDOWN, ARTICLE_COPIES_ONLY, CONFIDENCE, SPECIFICITY_SCORE FROM FIX_TH_EMBEDDED_PENDING WHERE CANDIDATE_ID='pending-independent'");
for (const together of [false,true]) {
  const suffix=together?'batch':'separate';
  const redirect='https://redirect.example/'+suffix, final='https://daily.example/'+suffix;
  const first=native('discovery-'+suffix,redirect,'agent_chatgpt_discovery');
  first.METADATA=JSON.stringify({url:redirect,canonical_url:final});
  stage([first]);
  const {signals}=await preparePage({data:[{...article,id:suffix,url:final}],observed,origin:'forward',
    from:'2026-11-01T00:00:00.000Z',to:'2026-11-02T00:00:00.000Z'});
  const later=native('gdelt-'+suffix,redirect,'gdelt');
  if (together) stage([...signals,later]);
  else { stage(signals); stage([later]); }
  check('all URL keys of the credited owner resolve in '+suffix+' submissions',
    `SELECT (SELECT COUNT(*) FROM FIX_TH_STG_EXTERNAL_SIGNALS WHERE SIGNAL_ID IN ('discovery-${suffix}','gdelt-${suffix}'))=1
       AND COUNT_IF(SIGNAL_ID='gdelt-${suffix}' AND CREDITED_SIGNAL_ID='discovery-${suffix}')=1 FROM FIX_TH_FCT_ARTICLE_SIGNAL_ALIASES`);
}
const tooLong='https://long.example/'+'a'.repeat(2048);
const tracking='https://short.example/news?utm_content='+'a'.repeat(2048);
await intake([{...article,id:'long-id',url:tooLong},{...article,id:'short-id',url:tracking}]);
check('the final supporting ID limit preserves both original URLs and accepts long tracking parameters',
  `SELECT COUNT_IF(PROVIDER_ID='long-id' AND DISPOSITION='unusable' AND REASON='signal_id_too_long'
       AND ORIGINAL_URL=${literal(tooLong)} AND SIGNAL_ID IS NULL)=1
   AND COUNT_IF(PROVIDER_ID='short-id' AND SIGNAL_ID='https://short.example/news' AND ORIGINAL_URL=${literal(tracking)})=1
   FROM FIX_TH_STG_TREND_HUNTER_ARTICLES`);

// Read the deployed Pipedream queries against the same native-first, verified-copy fixtures.
function workflowQuery(file,step,trend='late') {
  const query=read(file).split('- namespace: '+step+'\n')[1].split('      value: |-\n')[1].split('      query: |-\n')[0];
  return isolated(query.replace(/\{\{steps\.[^}]+\}\}/g,trend));
}
statements.push(`CREATE TEMPORARY TABLE FIX_TH_FCT_TRENDS AS SELECT 'late' TREND_ID,'copies' CANDIDATE_ID,'Refill stores' TREND_TOPIC,
  'Refill' TREND_NAME,'Refill' TREND_NAME_B2C,'Retail' CATEGORY,'Stores' SUBCATEGORY,
  CURRENT_TIMESTAMP() DETECTED_AT,CURRENT_TIMESTAMP() LAST_UPDATE_AT`);
statements.push('CREATE TEMPORARY TABLE FIX_TH_FCT_TREND_LIFECYCLE_LEDGER (TREND_ID VARCHAR,NEW_STATUS VARCHAR,NEW_HEAT NUMBER,NEW_HEAT_SMOOTHED NUMBER,EVALUATED_AT TIMESTAMP_NTZ)');
statements.push('ALTER TABLE FIX_TH_FCT_TREND_ENRICHMENT_LEDGER ADD COLUMN PAYLOAD VARIANT');
const enrichment='enrichment-p_xMC995w/workflow.yaml';
for (const step of ['q_metrics','q_neighbors']) {
  check(step+' credits the two verified copies as one story and one source before the link task runs',
    'SELECT COUNT(*)=1 AND MAX(TOTAL_CLUSTER_SIZE)=1 AND MAX(DISTINCT_SOURCE_COUNT)=1 FROM ('+
    workflowQuery(enrichment,step,step==='q_neighbors'?'other':'late')+')');
}
check('enrichment presents one original supporting article',
  `SELECT COUNT(*)=1 AND MAX(SIGNAL_NAME)='gdelt' AND MAX(URL)=${literal(wire)} FROM (`+workflowQuery(enrichment,'q_signals')+')');
statements.push("DELETE FROM FIX_TH_FCT_TREND_SIGNALS WHERE TREND_ID='late' AND SIGNAL_ID LIKE 'linked-%'");
check('source metrics credit a release and an independent linked report once each',
  'SELECT MAX(TOTAL_CLUSTER_SIZE)=2 FROM ('+workflowQuery('sources-p_7NCy36w/workflow.yaml','query_metrics')+')');
const sql = statements.join(';\n') + ';\n';
assert.doesNotMatch(sql, /MCC_(?:RAW|PRESENTATION)\./);
assert.doesNotMatch(sql, /^CREATE (?:OR REPLACE )?(?:VIEW|TABLE|FUNCTION|PROCEDURE|TASK)\b/mi);
process.stdout.write(sql);
