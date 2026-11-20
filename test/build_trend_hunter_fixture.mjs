import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SET_QUERIES as attribution} from '../services/lib/attribution_context.mjs';
import {SET_QUERIES as lifecycle} from '../services/lib/lifecycle_context.mjs';
import {runWindow, createArticleStore} from '../services/trend-hunter-ingest/ingest.mjs';

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
async function intake(items) {
  await runWindow({from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z', origin: 'forward',
    now: () => new Date(observed), fetchPage: async () => ({data: items, next_cursor: null}),
    recordPage: createArticleStore(async (sql, [rows]) => {
      assert.match(sql, /^CALL MCC_RAW\.MARKETING_DEV\.MERGE_EXTERNAL_SIGNALS/);
      stage(JSON.parse(rows)); return [{MERGE_EXTERNAL_SIGNALS: {article_counts: {}}}];
    })});
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

statements.push(`INSERT INTO FIX_TH_STG_TREND_CANDIDATES (CANDIDATE_ID,VERDICT,SUPPORTING_SIGNAL_IDS,SOURCE_BREAKDOWN,CONFIDENCE,SPECIFICITY_SCORE)
 SELECT column1,'REAL_TREND',PARSE_JSON(column2)::ARRAY,PARSE_JSON(column3)::OBJECT,0.8,0.8 FROM VALUES
 ('copies','["gdelt_native","https://partner.example/refill-trial"]','{"gdelt":1,"google_trends_rss":1}'),
 ('reverse','["gdelt_after","https://partner-two.example/e-bike"]','{"gdelt":1,"trend_hunter":1}'),
 ('independent','["gdelt_native","https://partner.example/refill-trial","https://reporter.example/refill-trial"]','{"gdelt":1,"google_trends_rss":1,"trend_hunter":1}')`);
const promotion = read('promotion-p_xMC99jg/workflow.yaml').split('- namespace: q_load_pending_candidates')[1].split('      query: |-')[0].split('      value: |-')[1];
statements.push('CREATE TEMPORARY TABLE FIX_TH_PENDING AS '+isolated(promotion));
check('source-family corroboration uses the first writer for both orders and retains the second independent family',
 `SELECT COUNT_IF(ARTICLE_COPIES_ONLY AND CLUSTER_SIZE=1 AND SOURCE_COUNT=1)=2 AND
 COUNT_IF(CANDIDATE_ID='independent' AND CLUSTER_SIZE=2 AND SOURCE_COUNT=2 AND SOURCE_BREAKDOWN:gdelt=1 AND SOURCE_BREAKDOWN:trend_hunter=1)=1 FROM FIX_TH_PENDING`);
statements.push('SELECT CANDIDATE_ID, SOURCE_BREAKDOWN, ARTICLE_COPIES_ONLY, CONFIDENCE, SPECIFICITY_SCORE FROM FIX_TH_PENDING');
const sql = statements.join(';\n') + ';\n';
assert.doesNotMatch(sql, /MCC_(?:RAW|PRESENTATION)\./);
assert.doesNotMatch(sql, /^CREATE (?:OR REPLACE )?(?:VIEW|TABLE|FUNCTION|PROCEDURE|TASK)\b/mi);
process.stdout.write(sql);
