#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --test services/trend-hunter-ingest/*.test.mjs

fixture=$(mktemp "${TMPDIR:-/tmp}/trend-hunter-fixture.XXXXXX")
results=$(mktemp "${TMPDIR:-/tmp}/trend-hunter-results.XXXXXX")
trap 'rm -f "$fixture" "$results"' EXIT
node test/build_trend_hunter_fixture.mjs > "$fixture"
node test/build_scheduled_article_fixture.mjs >> "$fixture"
node test/build_article_report_fixture.mjs >> "$fixture"
snow sql -c "${SNOWFLAKE_CONNECTION:-claude}" --database MCC_RAW --schema MARKETING_DEV \
  --enable-templating NONE --format json --silent -f "$fixture" > "$results"
node --input-type=module - "$results" <<'JS'
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {classifyCandidate} from './agents/lib/promotion_gate.mjs';
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8')).flat();
for (const row of rows.filter(row => row.CHECK_NAME)) {
  assert.equal(Number(row.PASSED), 1, row.CHECK_NAME);
  console.log(row.CHECK_NAME);
}
const actions = {};
for (const row of rows.filter(row => row.CANDIDATE_ID)) {
  if (typeof row.SOURCE_BREAKDOWN === 'string') row.SOURCE_BREAKDOWN = JSON.parse(row.SOURCE_BREAKDOWN);
  if (typeof row.ARTICLE_COPIES_ONLY === 'string') row.ARTICLE_COPIES_ONLY = row.ARTICLE_COPIES_ONLY.toLowerCase() === 'true';
  actions[row.CANDIDATE_ID] = classifyCandidate(row).action;
}
assert.deepEqual(actions, {copies:'reject', reverse:'reject', independent:'route_normal'});
console.log('The promotion gate rejects verified copies in either order and routes the independently corroborated movement.');
JS
node test/check_article_report.mjs "$results"
