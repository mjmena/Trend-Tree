import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProvider, createArticleStore, runWindow} from './ingest.mjs';

const from = '2026-11-01T00:00:00.000Z';
const to = '2026-11-02T00:00:00.000Z';
const observed = '2026-11-02T01:10:00.000Z';
const article = {id: 71, status: 'accepted', verdict: 'queued', source: 'Retail watch',
  url: 'https://www.daily.example/story?utm_source=feed', title: 'Local stores extend refill trials',
  summary: null, published_at: null, first_seen: '2026-11-01T10:00:00-05:00'};

test('a bounded pull submits original publisher articles and observed UTC clocks through the external-signal merge', async () => {
  const stored = [];
  const requests = [];
  const provider = createProvider({apiKey: 'fixture-only', fetchImpl: async (url, opts) => {
    requests.push([new URL(url), opts.headers.Authorization]);
    return Response.json(requests.length === 1 ? {data: [article], next_cursor: 'opaque/01+'} :
      {data: [{...article, id: 72, status: 'rejected'}], next_cursor: null});
  }});
  const recordPage = createArticleStore(async (sql, [payload]) => {
    assert.match(sql, /^CALL MCC_RAW\.MARKETING_DEV\.MERGE_EXTERNAL_SIGNALS/);
    stored.push(...JSON.parse(payload));
    return [{MERGE_EXTERNAL_SIGNALS: {article_counts: {new_signals: 1}}}];
  });
  const result = await runWindow({from, to, origin: 'replay', ...provider, recordPage, now: () => new Date(observed)});
  assert.deepEqual(requests.map(([url]) => Object.fromEntries(url.searchParams)), [
    {status: 'accepted', from, to, sort: 'oldest', limit: '100', fields: '-text'},
    {status: 'accepted', from, to, sort: 'oldest', limit: '100', fields: '-text', cursor: 'opaque/01+'},
  ]);
  assert.equal(requests[0][1], 'Bearer fixture-only');
  assert.equal(stored.length, 1);
  const signal = stored[0];
  assert.equal(signal.SOURCE_NAME, 'trend_hunter');
  assert.equal(signal.SIGNAL_TITLE, article.title);
  assert.equal(signal.SIGNAL_TEXT, article.title);
  assert.equal(signal.SIGNAL_TIMESTAMP, '2026-11-01T15:00:00.000Z');
  assert.equal(signal.URL, article.url);
  const metadata = JSON.parse(signal.METADATA);
  assert.equal(metadata.publisher, 'daily.example');
  assert.equal(metadata.feed_label, 'Retail watch');
  assert.equal(metadata.provider_id, '71');
  assert.equal(metadata.verdict, 'queued');
  assert.equal(metadata.published_at_utc, null);
  assert.equal(metadata.first_seen_utc, '2026-11-01T15:00:00.000Z');
  assert.equal(metadata.first_observed_at_utc, observed);
  assert.equal(metadata.origin, 'replay');
  assert.equal(result.accepted_rows, 1);
});

test('invalid accepted records carry a replayable reason and never enter the signal pool', async () => {
  const stored = [];
  await runWindow({from, to, origin: 'forward', fetchPage: async () => ({next_cursor: null, data: [
    {...article, url: 'mailto:reader@daily.example'}, {...article, id: null, title: ' '},
    {...article, id: 73, first_seen: to}, {...article, id: 74, url: 'https://name:secret@paper.example/story'},
    {...article, id: 79, url: 'https://paper.example/'},
    {...article, id: 75, first_seen: '2026-11-01 02:00:00'}, {...article, id: 76, published_at: 'not a timestamp'},
  ]}), recordPage: async (rows) => {stored.push(...rows); return {unusable_records: rows.length};}});
  const metadata = stored.map(row => JSON.parse(row.METADATA));
  assert.deepEqual(metadata.map(m => m.unusable_reason), ['invalid_original_url', 'missing_provider_id', 'outside_window',
    'invalid_original_url', 'invalid_original_url', 'invalid_first_seen', 'invalid_published_at']);
  assert.ok(stored.every(row => row.SIGNAL_ID === null));
  assert.equal(metadata[1].provider_id, null);
  assert.match(metadata[1].observation_key, /^invalid:[a-f0-9]{64}$/);
});

test('wire attribution in a particular full article supplies a release key while a similar headline supplies none', async () => {
  const source = 'https://www.prnewswire.com/news-releases/refill-stations-roll-out-302123456.html';
  const first = {...article, id: 'copy-1', url: 'https://partner.example/refills', text_kind: 'full',
    source: 'Press release partners', summary: 'New refill program.', title: 'Refills debut in local shops'};
  const requests = [], rows = [];
  const provider = createProvider({apiKey:'fixture',fetchImpl:async url => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path.endsWith('/articles/copy-1')) return Response.json({data: {...first, text:
      `First paragraph.\nView original content to download multimedia: ${source}\nSOURCE Refill Company`}});
    return Response.json({data:[first,{...article,id:77,title:first.title,text_kind:'full'}],next_cursor:null});
  }});
  await runWindow({from,to,origin:'forward',...provider,recordPage:async signals => {rows.push(...signals);return {};}});
  assert.equal(JSON.parse(rows[0].METADATA).release_proof.original_url, source);
  assert.equal(JSON.parse(rows[1].METADATA).release_proof, undefined);
  assert.equal(requests.length, 2);
});

test('an unavailable wire detail leaves a usable accepted article eligible on its own URL', async () => {
  const provider = createProvider({apiKey: 'fixture', fetchImpl: async url => {
    if (url.pathname.endsWith('/articles/71')) return new Response(null, {status: 404});
    return Response.json({data: [{...article, source: 'Press releases', text_kind: 'full'}], next_cursor: null});
  }});
  const rows = [];
  await runWindow({from,to,origin:'forward',...provider,recordPage:async signals => {rows.push(...signals);return {};}});
  assert.equal(rows[0].URL,article.url);
  assert.equal(JSON.parse(rows[0].METADATA).release_proof,undefined);
});
