// Tests for the Exploding Topics adapter (ADR-0004, issue #60).
// Run: node --test agents/lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEtResponse,
  buildEtSearchRequest,
  ET_BROWSER_UA,
} from "./exploding_topics.mjs";

// Captured-shape fixture: a real /database-search hit (trimmed).
const HIT_BODY = {
  total: 10,
  result: [
    {
      keyword: "Snail mucin",
      path: "snail-mucin",
      absolute_volume: 165000,
      categories: ["Beauty"],
      classifications: { "12": "regular", "24": "exploding", forecast_12: "peaked" },
      growth: { "12": 1.2, "24": 3.4 },
    },
    { keyword: "Snail mucin essence", path: "snail-mucin-essence", absolute_volume: 40000 },
  ],
};

test("hit: total>0 maps to matched with top fields + candidates", () => {
  const r = normalizeEtResponse({ status: 200, body: HIT_BODY });
  assert.equal(r.matched, true);
  assert.equal(r.total, 10);
  assert.equal(r.keyword, "Snail mucin");
  assert.equal(r.absolute_volume, 165000);
  assert.deepEqual(r.classifications, { "12": "regular", "24": "exploding", forecast_12: "peaked" });
  assert.deepEqual(r.growth, { "12": 1.2, "24": 3.4 });
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[1].keyword, "Snail mucin essence");
});

test("miss sentinel 'No meta trends found.' (HTTP 200) maps to matched=false", () => {
  const r = normalizeEtResponse({ status: 200, body: { message: "No meta trends found." } });
  assert.equal(r.matched, false);
  assert.equal(r.total, 0);
  assert.equal(r.miss_message, "No meta trends found.");
  assert.equal(r.absolute_volume, null);
});

test("miss sentinel 'No topic found.' (HTTP 200) maps to matched=false", () => {
  const r = normalizeEtResponse({ status: 200, body: { message: "No topic found." } });
  assert.equal(r.matched, false);
  assert.equal(r.miss_message, "No topic found.");
});

test("403 (Cloudflare bad-UA) maps to matched=false with error http_403", () => {
  const r = normalizeEtResponse({ status: 403, body: null });
  assert.equal(r.matched, false);
  assert.equal(r.error, "http_403");
});

test("empty result array (total 0) is a miss even without a sentinel", () => {
  const r = normalizeEtResponse({ status: 200, body: { total: 0, result: [] } });
  assert.equal(r.matched, false);
});

test("string absolute_volume is coerced to a number", () => {
  const r = normalizeEtResponse({ status: 200, body: { total: 1, result: [{ keyword: "x", absolute_volume: "500" }] } });
  assert.equal(r.absolute_volume, 500);
});

test("buildEtSearchRequest: api_key is in url but NEVER in log_target, and UA is set", () => {
  const { url, headers, log_target } = buildEtSearchRequest({ keyword: "head spa", apiKey: "SECRET123" });
  assert.match(url, /api_key=SECRET123/);
  assert.doesNotMatch(log_target, /SECRET123/);
  assert.doesNotMatch(log_target, /api_key/);
  assert.match(log_target, /keyword=head\+spa/);
  assert.equal(headers["User-Agent"], ET_BROWSER_UA);
});

test("normalizeEtResponse output never embeds an api_key (it only sees a parsed body)", () => {
  // Defensive: even a body that echoes a key must not surface it in the verdict.
  const r = normalizeEtResponse({ status: 200, body: { total: 0, message: "No meta trends found.", api_key: "LEAK" } });
  assert.doesNotMatch(JSON.stringify(r), /LEAK/);
});
