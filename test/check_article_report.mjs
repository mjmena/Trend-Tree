import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../services/trend-hunter-ingest/report.mjs', import.meta.url));
const render = (...args) =>
  JSON.parse(execFileSync(process.execPath, [script, 'render', process.argv[2], ...args], { encoding: 'utf8' }));
const report = render();
if (process.argv[3] === 'empty') {
  assert.equal(report.status, 'observed');
  assert.equal(report.coverage.forward_hours, 168);
  assert.equal(report.outcomes.accepted_items, 0);
  assert.equal(report.outcomes.confirmed_new_trends, 0);
  assert.equal(report.discovery.median_estimated_lead_hours, null);
  assert.deepEqual(report.examples, []);
  console.log('Seven complete observed days with no eligible articles report zero yield.');
  process.exit(0);
}
if (process.argv[3] === 'immature') {
  assert.equal(report.status, 'awaiting_seven_complete_utc_days');
  assert.equal(report.outcomes, null);
  console.log('An immature cutoff with actual observations leaves the first report pending.');
  process.exit(0);
}
assert.equal(report.status, 'observed');
assert.equal(report.coverage.forward_hours, 168);
assert.equal(report.outcomes.independent_live_stories, 2);
assert.equal(report.article_timing.pickup.median_hours, 36);
assert.equal(report.article_timing.eligible_poll.median_hours, 24);
assert.equal(report.outcomes.confirmed_new_trends, 1);
assert.equal(report.outcomes.verified_active_pairs, 1);
assert.equal(report.outcomes.unknown_unlinked_stories, 1);
assert.equal(
  report.article_cases.find((a) => a.id === 'id:independent').outcome_disposition,
  'unknown_unlinked_at_cutoff'
);
assert.deepEqual(
  report.link_cases[0].prior_facts.map((f) => f.id),
  ['old-fact']
);
assert.equal(report.discovery.median_estimated_lead_hours, null);
const capture = JSON.parse(readFileSync(process.argv[2], 'utf8')).flat();
const packet = (section) => capture.filter((r) => r.SECTION === section).map(({DATA}) => typeof DATA === 'string' ? JSON.parse(DATA) : DATA);
const opportunities = packet('opportunities');
assert.equal(opportunities.find((o) => o.ID === 'revisit-same').NATIVE_GROUPS_KNOWN, true);
assert.equal(opportunities.find((o) => o.ID === 'revisit-different').NATIVE_GROUPS_KNOWN, false);
const batches = (op, arm) => Object.fromEntries(packet('pools').filter((r) => r.OP === op && r.ARM === arm).map((r) => [r.SIGNAL,r.BATCH ?? null]));
assert.deepEqual(batches('revisit-same','native'), {'batch-a':0,'batch-b':0,'batch-c':1,omitted:null});
assert.deepEqual(batches('revisit-different','augmented'), {'batch-a':0,'batch-b':0,'batch-c':1,omitted:null});
assert.deepEqual(batches('revisit-different','native'), {'batch-a':null,'batch-b':null,'batch-c':null});
const nativePackets = report.discovery.sample[0].native.packets;
assert.deepEqual(
  nativePackets[0].evidence.map((e) => e.signal),
  ['social']
);
assert.equal(nativePackets[1].evidence.find((e) => e.signal === 'gdelt_hash').embedded, null);
const judgments = [
  { op: 'op-early', arm: 'augmented', ids: ['signal-water', 'social'] },
  { op: 'op-later', arm: 'native', ids: ['native-news', 'social'] },
].map((j) => ({
  ...j,
  disposition: 'meets',
  reason: 'Two independent accounts identify retail refill openings.',
  query: 'refill station',
  confidence: 0.8,
  specificity: 0.9,
}));
const dir = mkdtempSync(join(tmpdir(), 'article-report-review-'));
try {
  const file = join(dir, 'review.json');
  writeFileSync(
    file,
    JSON.stringify({
      packet_sha256: report.packet_sha256,
      movements: [
        {
          seed: 'candidate-refills',
          candidates: ['candidate-refills'],
          reviewer: 'fixture',
          reason: 'The interviews and trade reporting describe the same store openings.',
          judgments,
        },
      ],
      facts: [
        {
          story: 'signal-water',
          trend: 'retail-trend',
          reviewer: 'fixture',
          fact: 'Six stores have opened.',
          prior_ids: ['old-fact'],
          disposition: 'fresh',
          reason: 'The earlier enrichment documented a proposed trial.',
        },
      ],
    })
  );
  const reviewed = render(file);
  assert.equal(reviewed.discovery.median_estimated_lead_hours, 24);
  assert.equal(reviewed.outcomes.fresh_fact_pairs, 1);
  console.log(
    'The first-week report distinguishes observed clocks, outcomes, fresh facts, unknowns and paired movement estimates.'
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
