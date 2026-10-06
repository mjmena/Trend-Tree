import { test } from "node:test";
import assert from "node:assert/strict";

import { REQUIRED_FIELDS, normalizeRecords } from "./scrape_normalize.mjs";

// A minimal well-formed TikTok record and a mapper that passes it through, so
// each test below varies exactly one thing.
const tiktok = (over = {}) => ({
  post_id: "7123",
  url: "https://www.tiktok.com/@a/video/7123",
  description: "brown butter cookies",
  sound: "original sound - a",
  ...over,
});
const identity = (raw) => raw;

const run = (rawRecords, { platform = "tiktok", map = identity } = {}) =>
  normalizeRecords({ platform, rawRecords, map });

test("well-formed records pass through and are counted", () => {
  const out = run([tiktok(), tiktok({ post_id: "7124" })]);
  assert.equal(out.records.length, 2);
  assert.equal(out.rejected, 0);
  assert.deepEqual(out.reject_reasons, {});
});

test("a record missing a required field is dropped and counted", () => {
  const out = run([tiktok(), tiktok({ sound: undefined })]);
  assert.equal(out.records.length, 1);
  assert.equal(out.rejected, 1);
  assert.deepEqual(out.reject_reasons, { "missing:sound": 1 });
});

// The reason this module exists: a half-broken scraper returns the key with an
// empty value rather than dropping it, and treating that as present is the
// silent failure that surfaces days later as trends with no evidence.
test("an empty or whitespace-only string counts as missing", () => {
  const out = run([tiktok({ description: "" }), tiktok({ sound: "   " })]);
  assert.equal(out.records.length, 0);
  assert.deepEqual(out.reject_reasons, { "missing:description": 1, "missing:sound": 1 });
});

test("0 and false are genuine values, not missing", () => {
  const out = normalizeRecords({
    platform: "reddit",
    rawRecords: [{ post_id: 0, url: "https://reddit.com/x", title: "t", subreddit: "s" }],
    map: identity,
  });
  assert.equal(out.records.length, 1);
  assert.equal(out.rejected, 0);
});

// A renamed field and an empty husk need different responses, so every missing
// field is reported rather than just the first.
test("all missing fields are reported together, not just the first", () => {
  const out = run([{ post_id: "7123" }]);
  assert.deepEqual(out.reject_reasons, { "missing:url,description,sound": 1 });
});

test("reject reasons accumulate as a histogram", () => {
  const out = run([tiktok({ sound: null }), tiktok({ sound: null }), tiktok({ url: null })]);
  assert.equal(out.rejected, 3);
  assert.deepEqual(out.reject_reasons, { "missing:sound": 2, "missing:url": 1 });
});

test("one bad record never fails the whole job", () => {
  const out = run([tiktok(), null, "nope", [], tiktok({ post_id: "7125" })]);
  assert.equal(out.records.length, 2);
  assert.equal(out.rejected, 3);
  assert.deepEqual(out.reject_reasons, { not_an_object: 3 });
});

test("a mapper that throws rejects only its own record", () => {
  const out = run([tiktok(), tiktok({ post_id: "boom" })], {
    map: (raw) => {
      if (raw.post_id === "boom") throw new Error("vendor payload changed shape");
      return raw;
    },
  });
  assert.equal(out.records.length, 1);
  assert.equal(out.rejected, 1);
  assert.deepEqual(out.reject_reasons, { "mapper_error: vendor payload changed shape": 1 });
});

// reject_reasons is a histogram keyed by reason. An uncapped message carrying
// record data would make every key unique and turn it into a log dump.
test("a mapper error message is capped so reject_reasons stays a histogram", () => {
  const out = run([tiktok()], {
    map: () => {
      throw new Error("x".repeat(500));
    },
  });
  const [key] = Object.keys(out.reject_reasons);
  assert.ok(key.length <= "mapper_error: ".length + 80);
});

test("the mapper's output is what gets validated, not the vendor payload", () => {
  const out = run([{ id: "7123", desc: "d", music: "m", link: "https://x" }], {
    map: (raw) => ({ post_id: raw.id, url: raw.link, description: raw.desc, sound: raw.music }),
  });
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].sound, "m");
});

test("an empty or absent vendor payload is an empty result, not a throw", () => {
  for (const empty of [[], null, undefined]) {
    const out = run(empty);
    assert.deepEqual(out, { records: [], rejected: 0, reject_reasons: {} });
  }
});

test("an unknown platform is a programming error and throws", () => {
  assert.throws(() => run([], { platform: "myspace" }), /no record shape defined/);
});

test("every platform with a route decision has a required-field list", () => {
  assert.deepEqual(Object.keys(REQUIRED_FIELDS).sort(), ["kickstarter", "reddit", "tiktok"]);
});
