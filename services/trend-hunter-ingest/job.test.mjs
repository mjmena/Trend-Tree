import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runJob} from './job.mjs';

const from = '2026-11-01T00:00:00.000Z';
const to = '2026-11-01T03:00:00.000Z';
const observed = '2026-11-01T03:07:00.000Z';
const first = {id: 'one', url: 'https://trade.example/report', title: 'A refill trial expands',
  first_seen: '2026-11-01T02:00:00Z', status: 'accepted', source: 'Trade press'};
const counts = {accepted_rows: 1, new_signals: 1, repeat_sightings: 0, syndicated_copies: 0, unusable_records: 0};
const env = {CLOUD_RUN_EXECUTION: 'hourly-fixture'};
const window = {id: 'hourly-fixture', origin: 'forward', from, to, cursor: null, page_number: 0, complete: false};

test('an hourly job records an accepted page at its receipt time and reports its committed window', async () => {
  let received, merged;
  const requests = [];
  const result = await runJob(env, {
    now: () => new Date(observed),
    fetchPage: async filters => { requests.push(filters); return {data: [{...first,text:'Unrequested full article'}, {...first,id:'excluded',status:'rejected'}], next_cursor: null}; },
    query: async (sql, [payload]) => {
      assert.equal(sql,'CALL MCC_RAW.MARKETING_DEV.TREND_HUNTER_INTAKE(?)');
      const args = JSON.parse(payload);
      const {action} = args;
      let result;
      if (action === 'open') result = window;
      else if (action === 'gate') result = {retry_at: null};
      else if (action === 'receive') {
        received = args;
        result = {...window, receipt: {observed: args.observed, data: args.data, next_cursor: null}};
      } else if (action === 'commit') {
        merged = args.signals;
        result = {...window, complete: true, page_number: 1, counts};
      } else if (action === 'finish') result = {};
      else throw Error(action);
      return [{TREND_HUNTER_INTAKE: JSON.stringify(result)}];
    },
  });
  assert.deepEqual(requests, [{from, to, cursor: null}]);
  assert.equal(received.observed, observed);
  assert.deepEqual(received.data,[first]);
  assert.equal(JSON.parse(merged[0].METADATA).first_observed_at_utc, observed);
  assert.deepEqual(result, {execution: 'hourly-fixture', window_id: 'hourly-fixture',
    origin: 'forward', from, to, outcome: 'complete', pages: 1, ...counts});
});

test('a detail 429 retains the accepted receipt and defers other executions until its HTTP-date', async () => {
  const row = {...first, source: 'Press releases', text_kind: 'full'};
  let clock = Date.parse(observed), retryAt, receipt, delivered = 0, merged;
  const proofs = new Map(), details = [];
  const finishes = [];
  const opts = {
    now: () => new Date(clock),
    fetchPage: async () => {delivered++; return {data:[{...row,id:'already-verified'},row],next_cursor:null};},
    fetchDetail: async id => {
      details.push(id);
      if (id==='one' && clock < Date.parse('2026-11-01T05:00:00Z')) {
        throw Object.assign(Error('HTTP 429'), {status:429,retryAfter:'Sun, 01 Nov 2026 05:00:00 GMT'});
      }
      return {...row,text:'A short publisher description.'};
    },
    intake: async (action,args) => {
      if (action==='open') return {...window,receipt};
      if (action==='gate') return {retry_at:retryAt};
      if (action==='proof') return {found:proofs.has(args.provider_id),proof:proofs.get(args.provider_id)};
      if (action==='save_proof') {proofs.set(args.provider_id,args.proof); return {found:true,proof:args.proof};}
      if (action==='cooldown') { retryAt=args.retry_at; return {}; }
      if (action==='receive') { receipt={data:args.data,observed:args.observed,next_cursor:null}; return {...window,receipt}; }
      if (action==='commit') { merged=args.signals; return {...window, complete:true,page_number:1,counts}; }
      if (action==='finish') { finishes.push(args.outcome); return {}; }
      throw Error(action);
    },
  };
  assert.equal((await runJob(env,opts)).outcome,'rate_limited');
  assert.equal(retryAt,'2026-11-01T05:00:00.000Z');
  clock += 60000;
  assert.equal((await runJob({CLOUD_RUN_EXECUTION:'overlap'},opts)).outcome,'rate_limited');
  clock = Date.parse(retryAt);
  assert.equal((await runJob({CLOUD_RUN_EXECUTION:'resume'},opts)).outcome,'complete');
  assert.equal(JSON.parse(merged[0].METADATA).first_observed_at_utc,observed);
  assert.equal(delivered,1);
  assert.equal(details.filter(id=>id==='already-verified').length,1);
  assert.deepEqual(finishes,['rate_limited','rate_limited','complete']);
});

test('the scheduler targets the production job hourly and requests the reconciliation override daily in UTC', async () => {
  const {execFileSync} = await import('node:child_process');
  const script = new URL('./schedule.sh', import.meta.url).pathname;
  const {mkdtempSync,writeFileSync,readFileSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const dir = mkdtempSync(tmpdir() + '/th-scheduler-');
  try {
    const log = dir + '/requests', fake = dir + '/gcloud';
    writeFileSync(fake, '#!/usr/bin/env node\nconst fs=require("node:fs");const a=process.argv.slice(2);if(a[2]==="describe")process.exit(1);fs.appendFileSync(process.env.REQUEST_LOG,JSON.stringify(a)+"\\n");\n', {mode:0o755});
    execFileSync('bash',[script],{env:{...process.env,GCLOUD:fake,REQUEST_LOG:log}});
    const requests = readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(requests.length,2);
    const order = requests.sort((a,b)=>a[4].localeCompare(b[4]));
    const options = args => Object.fromEntries(args.slice(5).reduce((pairs,v,i,all)=>i%2 ? pairs : [...pairs,[v,all[i+1]]],[]));
    const [daily,hourly] = order.map(options);
    assert.equal(hourly['--schedule'],'7 * * * *');
    assert.equal(daily['--schedule'],'17 0 * * *');
    for (const r of [daily,hourly]) {
      assert.equal(r['--time-zone'],'UTC');
      assert.match(r['--uri'], /jobs\/trend-tree-trend-hunter-ingest:run$/);
      assert.ok(r['--oauth-service-account-email']);
    }
    assert.deepEqual(JSON.parse(daily['--message-body']).overrides.containerOverrides[0].env,
      [{name:'TREND_HUNTER_ORIGIN',value:'reconcile'}]);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('a resumed list cursor waits out Retry-After seconds without changing its original window', async () => {
  let clock = Date.parse(observed), retryAt, pageCalls = [];
  const sleeps = [];
  await runJob({CLOUD_RUN_EXECUTION:'retry-fixture'},{
    now:()=>new Date(clock),
    sleep:async ms=>{sleeps.push(ms); clock+=ms;},
    fetchPage:async filters=>{
      pageCalls.push({...filters,at:clock});
      if (pageCalls.length===1) throw Object.assign(Error('HTTP 429'),{status:429,retryAfter:'7'});
      return {data:[],next_cursor:null};
    },
    intake:async(action,args)=>{
      const partial={...window,page_number:2,cursor:'opaque-fixed'};
      if(action==='open') return partial;
      if(action==='gate') return {retry_at:retryAt};
      if(action==='cooldown') {retryAt=args.retry_at; return {};}
      if(action==='receive') return {...partial,receipt:{data:[],observed:args.observed,next_cursor:null}};
      if(action==='commit') return {...partial,complete:true,page_number:3};
      if(action==='finish') return {};
      throw Error(action);
    },
  });
  assert.deepEqual(sleeps,[7000]);
  assert.deepEqual(pageCalls,[{from,to,cursor:'opaque-fixed',at:Date.parse(observed)},
    {from,to,cursor:'opaque-fixed',at:Date.parse('2026-11-01T03:07:07Z')}]);
});

test('manual recovery rejects unbounded, future, offset-free and oversized windows before provider access', async () => {
  for (const settings of [{}, {TREND_HUNTER_FROM:from,TREND_HUNTER_TO:'2026-12-01T00:00:00Z'},
    {TREND_HUNTER_FROM:'2026-10-10T00:00:00Z',TREND_HUNTER_TO:to},
    {TREND_HUNTER_FROM:'2026-10-31 00:00:00',TREND_HUNTER_TO:to}]) {
    await assert.rejects(runJob({...env,TREND_HUNTER_ORIGIN:'replay',...settings}, {
      now:()=>new Date(observed),intake:()=>assert.fail('unbounded request reached the warehouse'),
    }), /Replay requires/);
  }
});
