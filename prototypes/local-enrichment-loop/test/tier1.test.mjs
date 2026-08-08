// PROTOTYPE (CRMA-438) — unit tests over the Tier-1 name check. In prod this
// logic is only exercisable by deploying and firing a real enrichment run
// (~$0.40, 3-5 min); here it's `npm test` in milliseconds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tier1Check, firstBeatTokens } from "../src/lib/reviewer.mjs";

test("banned category-of-change word in first beat fails", () => {
  const r = tier1Check("Wellness Architecture for Renters");
  assert.equal(r.pass, false);
  assert.equal(r.banned_word, "wellness");
});

test("banned word beyond the first three beats passes", () => {
  // 'aesthetic' is 4th non-article token — outside the first-beat surface
  const r = tier1Check("Cottage Garden Kitchen Aesthetic");
  assert.equal(r.pass, true);
});

test("leading articles are skipped when finding the beat", () => {
  const r = tier1Check("The Era of Quiet Luxury");
  assert.equal(r.pass, false);
  assert.equal(r.banned_word, "era");
});

test("hyphenated names tokenize per beat", () => {
  assert.deepEqual(firstBeatTokens("Sleep-Divorce Suites"), ["sleep", "divorce", "suites"]);
  assert.equal(tier1Check("Sleep-Divorce Suites").pass, true);
});

test("empty / non-string names pass tier1 (caught upstream as no_trend_name)", () => {
  assert.equal(tier1Check("").pass, true);
  assert.equal(tier1Check(null).pass, true);
});
