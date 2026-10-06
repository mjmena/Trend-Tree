import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidJobIdError,
  formatJobId,
  parseJobId,
} from "./scrape_job_id.mjs";

test("a formatted job id round-trips through the parser", () => {
  const parts = { vendor: "bd", platform: "tiktok", handle: "s_m1a2b3c4" };
  assert.deepEqual(parseJobId(formatJobId(parts)), parts);
});

test("every decided platform round-trips", () => {
  for (const platform of ["tiktok", "reddit", "kickstarter"]) {
    const id = formatJobId({ vendor: "bd", platform, handle: "snap1" });
    assert.equal(parseJobId(id).platform, platform);
  }
});

// The whole point of the encoding: the GET recovers the normalizer key
// without any stored record of the POST. See scrape_job_id.mjs's header.
test("the parsed id alone carries the (vendor, platform) normalizer key", () => {
  const { vendor, platform } = parseJobId("apify.kickstarter.abc-123");
  assert.equal(vendor, "apify");
  assert.equal(platform, "kickstarter");
});

test("a handle keeps its own dashes and underscores intact", () => {
  assert.equal(parseJobId("bd.reddit.s_a-b_c").handle, "s_a-b_c");
});

test("an unknown vendor is rejected", () => {
  assert.throws(() => parseJobId("zyte.tiktok.snap1"), InvalidJobIdError);
});

test("a platform with no route decision is rejected", () => {
  assert.throws(() => parseJobId("bd.instagram.snap1"), InvalidJobIdError);
});

test("a job id missing a segment is rejected", () => {
  assert.throws(() => parseJobId("bd.tiktok"), InvalidJobIdError);
  assert.throws(() => parseJobId("snap1"), InvalidJobIdError);
});

test("an empty handle is rejected", () => {
  assert.throws(() => parseJobId("bd.tiktok."), InvalidJobIdError);
});

// The id arrives in a URL path and is interpolated into a vendor API request,
// so a handle carrying path or whitespace characters never reaches either.
test("a handle carrying path or whitespace characters is rejected", () => {
  for (const handle of ["../../etc", "a/b", "a b", "a\nb", "a?b=1"]) {
    assert.throws(() => parseJobId(`bd.tiktok.${handle}`), InvalidJobIdError);
  }
});

test("a non-string job id is rejected rather than coerced", () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(() => parseJobId(bad), InvalidJobIdError);
  }
});

test("formatting refuses to mint an id the parser would reject", () => {
  assert.throws(
    () => formatJobId({ vendor: "bd", platform: "tiktok", handle: "a.b" }),
    InvalidJobIdError,
  );
  assert.throws(
    () => formatJobId({ vendor: "bd", platform: "myspace", handle: "x" }),
    InvalidJobIdError,
  );
});
