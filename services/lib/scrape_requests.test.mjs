import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidRequestError,
  SOURCE_KIND,
  buildRequest,
  encodeUnlockerHandle,
  urlFromUnlockerHandle,
} from "./scrape_requests.mjs";
import { formatJobId, parseJobId } from "./scrape_job_id.mjs";

const tiktok = (params) => buildRequest({ source: "tiktok", params });
const reddit = (params) => buildRequest({ source: "reddit", params });
const kickstarter = (params) => buildRequest({ source: "kickstarter", params });

// --- source routing ---------------------------------------------------------

test("an unknown source is rejected before any vendor call is shaped", () => {
  assert.throws(() => buildRequest({ source: "instagram", params: {} }), InvalidRequestError);
  assert.throws(() => buildRequest({ params: {} }), InvalidRequestError);
});

test("the source is case-insensitive", () => {
  assert.equal(buildRequest({ source: "TikTok", params: { keywords: ["x"] } }).source, "tiktok");
});

test("params must be an object, not an array or a scalar", () => {
  assert.throws(() => buildRequest({ source: "tiktok", params: ["x"] }), InvalidRequestError);
  assert.throws(() => buildRequest({ source: "tiktok", params: "x" }), InvalidRequestError);
});

// The two platform families the header explains: a vendor job to poll, versus
// a deferred fetch encoded into the job id.
test("each source declares which vendor product serves it", () => {
  assert.equal(SOURCE_KIND.tiktok, "dataset");
  assert.equal(SOURCE_KIND.reddit, "dataset");
  assert.equal(SOURCE_KIND.kickstarter, "unlocker");
  assert.equal(tiktok({ keywords: ["x"] }).kind, "dataset");
  assert.equal(kickstarter({ category_ids: ["22"] }).kind, "unlocker");
});

// --- tiktok -----------------------------------------------------------------

test("tiktok: keywords become one vendor input object each", () => {
  const req = tiktok({ keywords: ["cottage cheese", "#girlDinner"] });
  assert.equal(req.discoverBy, "keyword");
  assert.deepEqual(req.input, [
    { search_keyword: "cottage cheese" },
    { search_keyword: "#girlDinner" },
  ]);
});

// CRMA-983 is hashtag-funnel-first, and the vendor treats a "#tag" string as a
// hashtag search, so the gateway needs no second mode for it.
test("tiktok: a hashtag is just a keyword to the vendor", () => {
  assert.deepEqual(tiktok({ keywords: ["#baking"] }).input, [{ search_keyword: "#baking" }]);
});

test("tiktok: keywords are required and must be non-empty strings", () => {
  assert.throws(() => tiktok({}), InvalidRequestError);
  assert.throws(() => tiktok({ keywords: [] }), InvalidRequestError);
  assert.throws(() => tiktok({ keywords: [""] }), InvalidRequestError);
  assert.throws(() => tiktok({ keywords: "cookies" }), InvalidRequestError);
});

test("tiktok: limit_per_input is bounded and optional", () => {
  assert.equal(tiktok({ keywords: ["x"] }).limitPerInput, null);
  assert.equal(tiktok({ keywords: ["x"], limit_per_input: 50 }).limitPerInput, 50);
  assert.throws(() => tiktok({ keywords: ["x"], limit_per_input: 0 }), InvalidRequestError);
  assert.throws(() => tiktok({ keywords: ["x"], limit_per_input: 9999 }), InvalidRequestError);
  assert.throws(() => tiktok({ keywords: ["x"], limit_per_input: 1.5 }), InvalidRequestError);
});

// --- reddit -----------------------------------------------------------------

test("reddit: subreddit URLs become one vendor input object each", () => {
  const req = reddit({ subreddit_urls: ["https://www.reddit.com/r/cooking/"] });
  assert.equal(req.discoverBy, "subreddit_url");
  assert.deepEqual(req.input, [{ url: "https://www.reddit.com/r/cooking/" }]);
});

test("reddit: a non-subreddit URL is refused", () => {
  for (const url of [
    "https://www.reddit.com/",
    "https://www.reddit.com/r/cooking/comments/abc/x/",
    "https://example.com/r/cooking/",
    "not a url",
  ]) {
    assert.throws(() => reddit({ subreddit_urls: [url] }), InvalidRequestError, url);
  }
});

test("reddit: both the www and bare host forms are accepted", () => {
  assert.doesNotThrow(() => reddit({ subreddit_urls: ["https://reddit.com/r/cooking"] }));
  assert.doesNotThrow(() => reddit({ subreddit_urls: ["https://www.reddit.com/r/cooking/"] }));
});

// The vendor publishes no authoritative enum for sort_by and its own docs
// contradict each other on case, so the gateway passes it through rather than
// guessing. CRMA-986's gate check 1 settles the real values.
test("reddit: sort_by passes through verbatim, in any casing", () => {
  const url = "https://www.reddit.com/r/cooking/";
  assert.deepEqual(reddit({ subreddit_urls: [url], sort_by: "Top" }).input, [{ url, sort_by: "Top" }]);
  assert.deepEqual(reddit({ subreddit_urls: [url], sort_by: "top" }).input, [{ url, sort_by: "top" }]);
});

test("reddit: sort_by is omitted entirely when not given", () => {
  const [input] = reddit({ subreddit_urls: ["https://www.reddit.com/r/cooking/"] }).input;
  assert.equal("sort_by" in input, false);
  assert.equal("sort_by_time" in input, false);
});

// The undocumented field that makes CRMA-982's top?t=day route possible.
// Enumerated on 2026-09-07 from Bright Data's own validation errors.
test("reddit: sort_by_time carries the top?t=day half of CRMA-982", () => {
  const url = "https://www.reddit.com/r/cooking/";
  const [input] = reddit({ subreddit_urls: [url], sort_by: "Top", sort_by_time: "Today" }).input;
  assert.deepEqual(input, { url, sort_by: "Top", sort_by_time: "Today" });
});

// Verified end-to-end: Top alone returned r/Cooking posts from 2020, 2021 and
// 2024 at 25k-35k upvotes — the same canonical posts every pull would return.
// Top + Today returned three posts inside 24 hours.
test("reddit: a Top pull with no time window warns rather than silently returning all-time", () => {
  const req = reddit({ subreddit_urls: ["https://www.reddit.com/r/cooking/"], sort_by: "Top" });
  assert.equal(req.warnings.length, 1);
  assert.match(req.warnings[0], /ALL-TIME/);
});

test("reddit: no warning once a time window is given, or for time-free sorts", () => {
  const url = "https://www.reddit.com/r/cooking/";
  assert.deepEqual(reddit({ subreddit_urls: [url], sort_by: "Top", sort_by_time: "Today" }).warnings, []);
  assert.deepEqual(reddit({ subreddit_urls: [url], sort_by: "New" }).warnings, []);
});

// --- kickstarter ------------------------------------------------------------

test("kickstarter: a pull becomes a discover/advanced URL carrying the traction gate", () => {
  const req = kickstarter({ category_ids: ["22"], raised: "2" });
  const url = new URL(req.url);
  assert.equal(url.origin + url.pathname, "https://www.kickstarter.com/discover/advanced");
  assert.equal(url.searchParams.get("category_id"), "22");
  assert.equal(url.searchParams.get("state"), "live");
  assert.equal(url.searchParams.get("raised"), "2");
  assert.equal(url.searchParams.get("format"), "json");
});

// CRMA-984 gates on live projects only; that is not a caller-supplied option.
test("kickstarter: state=live is always set and not caller-overridable", () => {
  const url = new URL(kickstarter({ category_ids: ["22"], state: "successful" }).url);
  assert.equal(url.searchParams.get("state"), "live");
});

test("kickstarter: raised accepts only Kickstarter's three buckets", () => {
  for (const raised of ["0", "1", "2"]) {
    assert.doesNotThrow(() => kickstarter({ category_ids: ["22"], raised }));
  }
  assert.throws(() => kickstarter({ category_ids: ["22"], raised: "3" }), InvalidRequestError);
  assert.throws(() => kickstarter({ category_ids: ["22"], raised: "75%" }), InvalidRequestError);
});

test("kickstarter: category ids must be numeric", () => {
  assert.throws(() => kickstarter({ category_ids: ["design"] }), InvalidRequestError);
  assert.throws(() => kickstarter({}), InvalidRequestError);
});

// Kickstarter's discover endpoint takes ONE category, so a multi-category pull
// is several job ids. Failing loudly beats silently dropping the rest.
test("kickstarter: more than one category is refused rather than silently truncated", () => {
  assert.throws(() => kickstarter({ category_ids: ["22", "23"] }), InvalidRequestError);
});

test("kickstarter: paging is optional and bounded", () => {
  assert.equal(new URL(kickstarter({ category_ids: ["22"] }).url).searchParams.get("page"), null);
  assert.equal(new URL(kickstarter({ category_ids: ["22"], page: 3 }).url).searchParams.get("page"), "3");
  assert.throws(() => kickstarter({ category_ids: ["22"], page: 0 }), InvalidRequestError);
});

// --- the deferred-fetch handle ---------------------------------------------
// Kickstarter has no vendor-side job, so its job id must carry its own
// request. See scrape_requests.mjs's header for why the fetch is deferred to
// the GET rather than given a second contract.

test("a kickstarter pull round-trips through its job handle to the same URL", () => {
  for (const params of [
    { category_ids: ["22"] },
    { category_ids: ["22"], raised: "2" },
    { category_ids: ["334"], raised: "1", page: 7 },
  ]) {
    const req = kickstarter(params);
    assert.equal(urlFromUnlockerHandle(req.handle), req.url);
  }
});

test("the handle stays short and readable rather than an opaque blob", () => {
  assert.equal(encodeUnlockerHandle({ category: "22", raised: "2", page: 3 }), "c22-r2-p3");
  assert.equal(encodeUnlockerHandle({ category: "22" }), "c22");
});

// The handle must survive the job-id codec, whose charset is the real
// constraint on this encoding.
test("the handle survives the job id codec intact", () => {
  const req = kickstarter({ category_ids: ["334"], raised: "1", page: 7 });
  const jobId = formatJobId({ vendor: "bd", platform: "kickstarter", handle: req.handle });
  assert.equal(parseJobId(jobId).handle, req.handle);
  assert.equal(urlFromUnlockerHandle(parseJobId(jobId).handle), req.url);
});

// The handle arrives in a URL path from a caller and selects a URL to fetch,
// so it is re-validated rather than trusted.
test("a tampered handle cannot smuggle a URL through the GET", () => {
  for (const bad of [
    "c22-r9",                       // raised bucket outside 0-2
    "cdesign",                      // non-numeric category
    "c22-p0",                       // page below the floor
    "",
    "https://evil.example",
  ]) {
    assert.throws(() => urlFromUnlockerHandle(bad), InvalidRequestError, bad);
  }
});

test("a rebuilt URL still carries the non-negotiable state=live gate", () => {
  const url = new URL(urlFromUnlockerHandle("c22-r2"));
  assert.equal(url.searchParams.get("state"), "live");
  assert.equal(url.searchParams.get("format"), "json");
});
