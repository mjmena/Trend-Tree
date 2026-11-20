import test from 'node:test';
import assert from 'node:assert/strict';
import { contributionReport } from './report.mjs';

const window = {
  enabled: '2026-11-01T01:00:00Z',
  start: '2026-11-02T00:00:00Z',
  end: '2026-11-09T00:00:00Z',
  cutoff: '2026-11-10T00:00:00Z',
  through: '2026-11-09T00:00:00Z',
};
const packet = (sections = {}) => ({ window: [window], ...sections });

test('the first week stays pending at an early outcome cutoff', () => {
  const report = contributionReport(packet({ window: [{ ...window, cutoff: '2026-11-08T12:00:00Z' }] }));
  assert.equal(report.status, 'awaiting_seven_complete_utc_days');
  assert.equal(report.outcomes, null);
});

const days = Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-0${i + 2}`, forward_hours: 24 }));
const article = {
  id: 'id:a',
  story: 'release',
  signal: 'release',
  title: 'Refill stores open',
  url: 'https://trade.example/refills',
  publisher: 'trade.example',
  first: '2026-11-02T08:00:00Z',
  pickup: '2026-11-01T22:00:00Z',
  eligible: '2026-11-02T10:00:00Z',
  handled: '2026-11-02T10:01:00Z',
  origin: 'reconcile',
  first_origin: 'forward',
  native: '2026-11-03T10:00:00Z',
  native_source: 'gdelt',
  embedded: '2026-11-02T10:03:00Z',
  writer: 'trend_hunter',
};

test('pickup and first usable poll have separate clocks, URL denominators and replay exclusions', () => {
  const report = contributionReport(
    packet({
      days,
      articles: [
        article,
        { ...article, id: 'id:b', signal: 'wire-copy', url: 'https://wire.example/copy', native: null },
        { ...article, id: 'id:c', story: 'recovered', origin: 'replay' },
        { ...article, id: 'id:d', story: null, eligible: null, handled: null, native: null },
      ],
    })
  );
  assert.equal(report.outcomes.accepted_items, 4);
  assert.equal(report.outcomes.independent_live_stories, 1);
  assert.equal(report.article_timing.pickup.median_hours, 36);
  assert.equal(report.article_timing.eligible_poll.median_hours, 24);
  assert.deepEqual(report.article_timing.eligible_poll, { eligible_items: 2, paired: 1, unknown: 1, median_hours: 24 });
  assert.equal(report.article_cases.find((a) => a.id === 'id:b').timing_disposition, 'unknown_no_exact_native_url');
  assert.equal(report.article_cases.find((a) => a.id === 'id:c').timing_disposition, 'replay');
});

test('only source-linked candidates, independently confirmed mints and committed merge outcomes count', () => {
  const candidate = {
    id: 'new',
    created: '2026-11-03T10:00:00Z',
    support: ['wire-copy', 'social'],
    query: 'refill station',
    topic: 'Refill stores',
    confidence: 0.8,
    specificity: 0.9,
  };
  const candidates = [
    'new',
    'merge',
    'mirrored',
    'audit-only',
    'pending',
    'missing-audit',
    'editorial',
    'pre-existing',
  ].map((id) => ({ ...candidate, id, created: id === 'pre-existing' ? '2026-11-02T08:00:00Z' : candidate.created }));
  const decision = {
    id: 'audit-new',
    candidate: 'new',
    decision: 'PROMOTE_NEW',
    target: 'trend-new',
    chain: 'p',
    at: '2026-11-04T08:00:00Z',
  };
  const report = contributionReport(
    packet({
      days,
      articles: [article],
      candidates,
      signal_facts: [{ signal: 'wire-copy', embedded: '2026-11-02T10:03:00Z' }],
      aliases: [{ signal: 'wire-copy', story: 'release', verified: '2026-11-02T00:00:00Z' }],
      audits: [
        decision,
        { ...decision, id: 'a2', candidate: 'merge', decision: 'MERGE_INTO_EXISTING', target: 'trend-old' },
        { ...decision, id: 'a3', candidate: 'mirrored', decision: 'MERGE_INTO_CANDIDATE', target: null },
        { ...decision, id: 'a4', candidate: 'audit-only', target: 'no-identity' },
        { ...decision, id: 'a5', candidate: 'editorial', category: 'EDITORIAL', target: 'editor-trend' },
      ],
      states: [
        { candidate: 'merge', chain: 'p', decision: 'MERGE_INTO_EXISTING', promoted_to: 'trend-old', at: decision.at },
        {
          candidate: 'mirrored',
          chain: 'p',
          decision: 'MERGE_INTO_CANDIDATE',
          leader: 'lead',
          rejection_reason: 'leader_lead_rejected: evidence remained insufficient',
          rejected: '2026-11-04T08:00:00Z',
          at: decision.at,
        },
      ],
      trends: [
        { id: 'trend-new', candidate: 'new', minted: '2026-11-04T07:59:00Z' },
        { id: 'trend-old', candidate: 'other', minted: '2026-10-01T10:00:00Z' },
        { id: 'editor-trend', candidate: 'editorial', minted: decision.at },
        { id: 'missing', candidate: 'missing-audit', minted: decision.at },
      ],
    })
  );
  assert.deepEqual(report.candidate_cases.map((c) => [c.id, c.disposition]).sort(), [
    ['audit-only', 'unconfirmed_audit'],
    ['editorial', 'editorial'],
    ['merge', 'merged_existing'],
    ['mirrored', 'mirrored_reject'],
    ['missing-audit', 'identity_without_audit'],
    ['new', 'confirmed_new'],
    ['pending', 'unknown_pending'],
    ['pre-existing', 'preceded_article'],
  ]);
  assert.equal(report.outcomes.confirmed_new_trends, 1);
  assert.equal(report.outcomes.merged_target_trends, 1);
});

test('active credited attribution uses receipt-time lifecycle, actual sweep, first link and pre-receipt facts', () => {
  const at = '2026-11-03T14:00:00Z',
    submitted = '2026-11-03T11:00:00Z';
  const targets = ['active', 'revived', 'previous', 'no-pool', 'support'];
  const data = packet({
    days,
    articles: [article],
    trends: targets.map((id) => ({ id, minted: '2026-10-01T10:00:00Z' })),
    lifecycle: [
      { id: 'l1', trend: 'revived', at: '2026-11-01T10:00:00Z', status: 'DORMANT' },
      { id: 'l2', trend: 'revived', at, status: 'RESURGENT' },
    ],
    links: targets
      .map((trend) => ({
        trend,
        story: 'release',
        signal: 'release',
        kind: trend === 'support' ? 'supporting' : 'attributed',
        at,
      }))
      .concat({
        trend: 'previous',
        story: 'release',
        signal: 'release',
        kind: 'supporting',
        at: '2026-10-31T00:00:00Z',
      }),
    sweeps: targets
      .filter((t) => t !== 'no-pool')
      .map((trend) => ({
        trend,
        story: 'release',
        signal: 'release',
        selected: '2026-11-03T10:59:58Z',
        embedded: article.embedded,
        submitted,
        batch_name: 'b',
        rank: 4,
        similarity: 0.61,
        state: 'COLLECTED',
        updated: at,
      })),
    prior_enrichments: [
      { id: 'old', at: '2026-11-01T08:00:00Z', trend: 'active', evidence: [{ claim: 'Plans announced' }] },
      { id: 'later', at, trend: 'active', evidence: [{ claim: 'Stores have opened' }] },
    ],
  });
  const cases = contributionReport(data).link_cases;
  assert.deepEqual(cases.map((c) => [c.trend, c.disposition]).sort(), [
    ['active', 'verified_active_attribution'],
    ['no-pool', 'unverified_attribution'],
    ['previous', 'already_linked'],
    ['revived', 'inactive_at_poll'],
    ['support', 'supporting'],
  ]);
  assert.deepEqual(
    cases.find((c) => c.trend === 'active').prior_facts.map((f) => f.id),
    ['old']
  );
  assert.equal(contributionReport(data).outcomes.fresh_fact_pairs, null);
  const reviewed = contributionReport(data, {
    facts: [
      {
        story: 'release',
        trend: 'active',
        disposition: 'fresh',
        fact: 'The first six stores have opened.',
        prior_ids: ['old'],
        reviewer: 'source owner',
        reason: 'The earlier ledger documented plans and did not document an opening.',
      },
    ],
  });
  assert.equal(reviewed.outcomes.fresh_fact_pairs, 1);
  assert.throws(
    () =>
      contributionReport(data, {
        facts: [{ ...reviewed.link_cases.find((c) => c.trend === 'active').fact_review, prior_ids: ['later'] }],
      }),
    /prior|reference/i
  );
});

const op1 = {
  id: 'main-1',
  at: '2026-11-02T12:00:00Z',
  lane: 'main',
  floor: 150,
  selected_count: 151,
  native_count: 150,
};
const op2 = { ...op1, id: 'revisit-2', at: '2026-11-03T12:00:00Z', lane: 'revisit', floor: 1, native_groups_known:true, augmented_groups_known:true };
const candidate = {
  id: 'refills',
  created: '2026-11-03T14:00:00Z',
  query: 'refill station',
  topic: 'Refill stores',
  support: ['release', 'social', 'native-news'],
};
const row = (op, arm, signal, source) => ({
  op: op.id,
  arm,
  signal,
  story: signal,
  source,
  title: signal,
  rank: 1,
  batch: op.lane === 'revisit' ? 0 : null,
  ingested: op.at,
  embedded: op.at,
  origin: source === 'trend_hunter' ? 'forward' : null,
});
const movements = packet({
  days,
  articles: [article],
  candidates: [candidate],
  opportunities: [op1, op2],
  pools: [
    row(op1, 'augmented', 'release', 'trend_hunter'),
    row(op1, 'augmented', 'social', 'bluesky'),
    row(op1, 'native', 'social', 'bluesky'),
    row(op2, 'native', 'social', 'bluesky'),
    row(op2, 'native', 'native-news', 'gdelt'),
  ],
});
const call = (op, arm, ids) => ({
  op: op.id,
  arm,
  disposition: 'meets',
  ids,
  query: 'refill station',
  confidence: 0.8,
  specificity: 0.9,
  reason: 'Reports independently document new stores.',
});
const review = {
  seed: 'refills',
  candidates: ['refills'],
  reviewer: 'source owner',
  reason: 'Both reports describe store openings.',
  judgments: [call(op1, 'augmented', ['release', 'social']), call(op2, 'native', ['social', 'native-news'])],
};

test('compares reviewed first qualifying opportunities for the same movement, preserving unseen and censored comparisons', () => {
  assert.equal(contributionReport(movements).discovery.paired, 0);
  assert.equal(contributionReport(movements).discovery.median_estimated_lead_hours, null);
  const report = contributionReport(movements, { movements: [review] });
  const sample = report.discovery.sample[0];
  assert.equal(sample.disposition, 'paired_estimate');
  assert.equal(sample.estimated_lead_hours, 24);
  assert.deepEqual(sample.native.first.ids, ['social', 'native-news']);
  assert.equal(sample.augmented.first.op, 'main-1');
  assert.equal(sample.augmented.first.gate, 'route_normal');
  assert.equal(report.discovery.positive, 1);
  const future = { ...review, judgments: [call(op1, 'native', ['native-news', 'social'])] };
  assert.throws(() => contributionReport(movements, { movements: [future] }), /available|opportunity/i);
});

test('native copies retain their dated evidence before verification, and a known release counts once', () => {
  const earlier = { ...row(op1,'native','native-copy','gdelt'), title:'Native reporting before verification' };
  const data = {...movements, aliases:[{signal:'native-copy',story:'release',verified:'2026-11-03T08:00:00Z'}],
    pools:[...movements.pools, earlier, row(op1,'native','release','google_trends_rss')]};
  const native = (ids) => ({...review, judgments: [call(op1,'augmented',['release','social']),call(op1,'native',ids)]});
  const report = contributionReport(data,{movements:[native(['native-copy','social'])]});
  assert.equal(report.discovery.sample[0].native.first.at,op1.at);
  const copy = report.discovery.sample[0].native.packets[0].evidence.find((r) => r.signal === 'native-copy');
  assert.equal(copy.title,earlier.title);
  assert.equal(copy.story,'native-copy');
  assert.equal(copy.independent_story,'release');
  assert.throws(() => contributionReport(data,{movements:[native(['native-copy','release'])]}), /independent/);
});

test('revisit evidence must share a dispatched batch, and unknown earlier native groups censor a later estimate', () => {
  const split = { ...movements, pools: movements.pools.map((s) => s.op === op2.id && s.signal === 'native-news' ? {...s,batch:1} : s) };
  assert.throws(() => contributionReport(split, {movements:[review]}), /batch|opportunity/i);
  assert.equal(contributionReport(split).discovery.sample[0].native.packets.at(-1).disposition, 'below_gate');
  const truncated = {...split, pools:split.pools.map((s) => s.signal==='native-news' ? {...s,batch:null} : s)};
  assert.throws(() => contributionReport(truncated, {movements:[review]}), /batch|opportunity/i);
  const earlier = {...op2,id:'uncaptured',at:'2026-11-03T09:00:00Z',native_groups_known:false};
  const unknown = {...movements, opportunities:[op1,earlier,op2], pools:[
    ...movements.pools,row(earlier,'native','social','bluesky'),row(earlier,'native','native-news','gdelt'),
  ]};
  const sample = contributionReport(unknown, {movements:[review]}).discovery.sample[0];
  assert.equal(sample.native.packets.find((p) => p.op === earlier.id).disposition, 'unknown_revisit_groups');
  assert.equal(sample.native.first.earlier_unknown,true);
  assert.equal(sample.estimated_lead_hours,null);
});

test('a later provider copy keeps the story history without inheriting its earlier candidate or link', () => {
  const late = { ...article, id: 'later-copy', first: '2026-11-05T10:00:00Z', eligible: '2026-11-05T10:00:00Z',
    handled: '2026-11-05T10:01:00Z' };
  const report = contributionReport(packet({ days, articles: [late, article], candidates: [candidate],
    trends: [{ id: 'shops', minted: '2026-10-10T00:00:00Z' }],
    links: [{ story: 'release', signal: 'release', trend: 'shops', kind: 'attributed', at: '2026-11-03T12:00:00Z' }],
    sweeps: [{ story: 'release', signal: 'release', trend: 'shops', state: 'COLLECTED', selected: '2026-11-03T09:59:59Z', submitted: '2026-11-03T10:00:00Z',
      updated: '2026-11-03T12:01:00Z', rank: 1, similarity: 0.6, embedded: article.embedded }],
  }));
  const [later, original] = report.article_cases;
  assert.deepEqual(original.candidate_ids, ['refills']);
  assert.deepEqual(original.trend_ids, ['shops']);
  assert.deepEqual(later.candidate_ids, []);
  assert.deepEqual(later.trend_ids, []);
  assert.equal(later.outcome_disposition, 'prior_story_association');
  assert.deepEqual(report.examples, [original.id]);
  assert.equal(report.outcomes.stories_supporting_candidates, 1);
  assert.equal(report.outcomes.verified_active_pairs, 1);
});

test('an item arriving after sweep selection and a dormant-at-poll copy cannot inherit an active attribution', () => {
  const time = (hour) => '2026-11-03T' + hour + ':00:00Z';
  const early = {...article,first:time('05'),eligible:time('05'),handled:time('05'),embedded:time('05')};
  const middle = {...early,id:'dormant-copy',first:time('07'),eligible:time('07'),handled:time('07')};
  const late = {...early,id:'after-selection',first:time('11'),eligible:time('11'),handled:time('11')};
  const report = contributionReport(packet({days,articles:[early,middle,late],trends:[{id:'shops',minted:'2026-10-01T00:00:00Z'}],
    lifecycle:[{trend:'shops',id:'quiet',status:'DORMANT',at:time('06')},{trend:'shops',id:'revived',status:'RESURGENT',at:time('09')}],
    links:[{story:'release',signal:'release',trend:'shops',kind:'attributed',at:time('12')}],
    sweeps:[{story:'release',signal:'release',trend:'shops',state:'COLLECTED',selected:time('10'),submitted:time('11'),updated:time('12'),rank:1,similarity:0.8,embedded:time('05')}],
  }));
  const [a,b,c] = report.article_cases;
  assert.deepEqual(c.trend_ids, []);
  assert.equal(c.outcome_disposition, 'prior_story_association');
  assert.deepEqual(a.active_trend_ids, ['shops']);
  assert.deepEqual(b.active_trend_ids, []);
  assert.equal(report.link_cases[0].item_outcomes.find((i) => i.article === middle.id).disposition,'inactive_at_poll');
  assert.equal(report.outcomes.verified_active_pairs,1);
  assert.equal(report.outcomes.unknown_unlinked_stories,0);
});

test('a pre-existing candidate identifies a story without granting an incoming article earlier support', () => {
  const earlier = {...candidate, created:'2026-11-02T01:00:00Z'};
  const report = contributionReport(packet({days, articles:[article], candidates:[earlier]}));
  assert.equal(report.article_cases[0].outcome_disposition,'prior_story_association');
  assert.deepEqual(report.article_cases[0].candidate_ids,[]);
  assert.equal(report.outcomes.stories_supporting_candidates,0);
  assert.equal(report.outcomes.unknown_unlinked_stories,0);
});

test('counts a measured zero only across seven covered days and names each unmatched story and pending outcome', () => {
  const empty = contributionReport(packet({ days }));
  assert.equal(empty.status, 'observed');
  assert.equal(empty.outcomes.confirmed_new_trends, 0);
  assert.equal(empty.discovery.median_estimated_lead_hours, null);
  const uncovered = contributionReport(packet({ days: days.map((day) => ({ ...day, forward_hours: 0 })) }));
  assert.equal(uncovered.status, 'incomplete_intake_coverage');
  assert.equal(uncovered.outcomes, null);
  const report = contributionReport(packet({ days, articles: [{ ...article, native: null }] }));
  assert.equal(report.outcomes.unknown_unlinked_stories, 1);
  assert.equal(report.article_cases[0].outcome_disposition, 'unknown_unlinked_at_cutoff');
  assert.equal(report.coverage.native_sources.find((s) => s.source === 'gdelt').recorded_receipts, 0);
});

test('withholds a paired lead if an earlier native representation lacks its own embedding', () => {
  const data = {
    ...movements,
    pools: [
      ...movements.pools,
      { ...row(op1, 'native', 'native-news', 'gdelt'), embedded: null, representation: 'suppressed_native_receipt' },
    ],
  };
  const report = contributionReport(data, { movements: [review] });
  assert.equal(report.discovery.sample[0].native.first.earlier_unknown, true);
  assert.equal(report.discovery.median_estimated_lead_hours, null);
  const usingMissing = { ...review, judgments: [call(op1, 'native', ['social', 'native-news'])] };
  assert.throws(() => contributionReport(data, { movements: [usingMissing] }), /available/i);
});

test('the owner CLI requires a completed Snowflake export and binds reviews to its bytes', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'article-report-'));
  try {
    const file = join(dir, 'capture.json'),
      decision = join(dir, 'review.json');
    const run = (...files) =>
      spawnSync(process.execPath, [new URL('./report.mjs', import.meta.url).pathname, 'render', ...files], {
        encoding: 'utf8',
      });
    const rows = (section, values) => values.map((data) => ({ SECTION: section, DATA: JSON.stringify(data) }));
    const sections = [rows('window', [window]), rows('days', days)];
    writeFileSync(file, JSON.stringify(sections));
    assert.notEqual(run(file).status, 0);
    sections.push(rows('manifest', [{ version: 1, articles: 0, candidates: 0, opportunities: 0 }]));
    writeFileSync(file, JSON.stringify(sections));
    const report = JSON.parse(run(file).stdout);
    assert.equal(report.outcomes.accepted_items, 0);
    writeFileSync(decision, JSON.stringify({ packet_sha256: 'another report', movements: [] }));
    assert.notEqual(run(file, decision).status, 0);
    writeFileSync(decision, JSON.stringify({ packet_sha256: report.packet_sha256, movements: [] }));
    assert.equal(run(file, decision).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cancelled or already closed sweep cannot verify a later attributed link', () => {
  const trend = { id: 'retail', minted: '2026-10-31T00:00:00Z' };
  const link = { trend: 'retail', story: 'release', signal: 'release', kind: 'attributed', at: '2026-11-03T12:00:00Z' };
  const sweep = {
    trend: 'retail',
    story: 'release',
    signal: 'release',
    selected: '2026-11-03T10:59:58Z',
    embedded: article.embedded,
    submitted: '2026-11-03T11:00:00Z',
    rank: 1,
    similarity: 0.5,
  };
  const result = contributionReport(
    packet({
      days,
      articles: [article],
      trends: [trend],
      links: [link],
      sweeps: [
        { ...sweep, state: 'CANCELLED', updated: link.at },
        { ...sweep, state: 'COLLECTED', updated: '2026-11-03T11:59:00Z' },
      ],
    })
  );
  assert.equal(result.link_cases[0].disposition, 'unverified_attribution');
});

test('active attribution uses the archived selection and embedding clocks, including a delayed batch submission', () => {
  const selected = '2026-11-05T11:00:00Z', submitted = '2026-11-05T11:01:00Z', linked = '2026-11-05T12:00:00Z';
  const nativeFirst = { ...article, first: '2026-11-05T11:00:20Z', eligible: '2026-11-05T11:00:20Z',
    handled: '2026-11-05T11:00:21Z', embedded: '2026-11-02T11:00:05Z', writer: 'gdelt' };
  const score = (item, selection) => contributionReport(packet({ days, articles: [item],
    trends: [{ id: 'active', minted: '2026-10-01T00:00:00Z' }],
    links: [{ story: 'release', trend: 'active', signal: 'release', kind: 'attributed', at: linked }],
    sweeps: [{ story: 'release', trend: 'active', signal: 'release', state: 'COLLECTED', submitted, selected: selection,
      embedded: item.embedded, updated: linked, rank: 1, similarity: 0.6 }],
  })).outcomes.verified_active_pairs;
  assert.equal(score(nativeFirst, selected), 0);
  const early = { ...nativeFirst, first: '2026-11-05T10:00:00Z', eligible: '2026-11-05T10:00:00Z', handled: '2026-11-05T10:00:01Z' };
  assert.equal(score(early, selected), 1);
  assert.equal(score(early, null), 0);
  assert.equal(score({ ...early, embedded: '2026-11-02T10:59:59Z' }, selected), 0);
});

test('a single-source review requires contemporaneous ET corroboration for the same movement and query', () => {
  const oneFamily = {
    ...movements,
    pools: movements.pools.map((s) => ({
      ...s,
      source: s.arm === 'augmented' ? 'trend_hunter' : s.source,
      origin: s.arm === 'augmented' ? 'forward' : s.origin,
    })),
  };
  const augmented = { ...review.judgments[0], et_candidate: 'refills' };
  const single = { ...review, judgments: [augmented, review.judgments[1]] };
  const state = {
    candidate: 'refills',
    chain: 'p',
    at: op2.at,
    et_second: true,
    et: { matched: true, keyword: 'refill station', absolute_volume: 1100,
      candidate_query: 'refill station', queried: ' Refill Station ' },
  };
  assert.throws(
    () => contributionReport({ ...oneFamily, states: [state] }, { movements: [single] }),
    /contemporaneous/
  );
  const withWitness = et => contributionReport(
    { ...oneFamily, states: [{ ...state, at: op1.at, et: { ...state.et, ...et } }] },
    { movements: [single] }
  ).discovery.sample[0];
  assert.equal(withWitness({}).disposition, 'paired_estimate');
  for (const witness of [{ absolute_volume: 1 }, { queried: 'bottled water' }, { queried: null },
                         { candidate_query: 'water bottle' }]) {
    assert.throws(() => withWitness(witness), /contemporaneous/);
  }
  assert.throws(
    () =>
      contributionReport(
        { ...oneFamily, states: [{ ...state, at: op1.at }] },
        { movements: [{ ...single, judgments: [{ ...augmented, confidence: 0.1 }] }] }
      ),
    /gate/
  );
  const differing = { ...review, judgments: [review.judgments[0], { ...review.judgments[1], query: 'bottled water' }] };
  assert.throws(() => contributionReport(movements, { movements: [differing] }), /movement query/);
});
