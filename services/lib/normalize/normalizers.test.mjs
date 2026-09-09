import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeTikTokBrightData } from "./tiktok_brightdata.mjs";
import { normalizeRedditBrightData } from "./reddit_brightdata.mjs";
import { normalizeKickstarterBrightData } from "./kickstarter_brightdata.mjs";
import { normalizeRecords } from "../scrape_normalize.mjs";

// --- TikTok -----------------------------------------------------------------

// The 13 fields Bright Data's API reference example publishes, plus the
// `digg_count` its product page publishes and the reference omits.
const bdTikTok = (over = {}) => ({
  post_id: "7123456789",
  description: "brown butter chocolate chip cookies #baking",
  create_time: "2026-09-01T10:00:00Z",
  share_count: 12,
  collect_count: 30,
  comment_count: 8,
  play_count: 90210,
  digg_count: 578,
  video_duration: 31,
  hashtags: ["baking"],
  video_url: "https://www.tiktok.com/@cook/video/7123456789",
  profile_username: "cook",
  profile_url: "https://www.tiktok.com/@cook",
  is_verified: false,
  ...over,
});

test("tiktok: the documented fields map to platform vocabulary", () => {
  const r = normalizeTikTokBrightData(bdTikTok({ music: "original sound - cook" }));
  assert.equal(r.post_id, "7123456789");
  assert.equal(r.url, "https://www.tiktok.com/@cook/video/7123456789");
  assert.equal(r.sound, "original sound - cook");
  assert.equal(r.like_count, 578);
  assert.equal(r.play_count, 90210);
  assert.deepEqual(r.hashtags, ["baking"]);
});

// The vendor's two field inventories disagree and neither documents a sound
// field, so the normalizer probes plausible names rather than betting on one.
test("tiktok: any plausible sound field name is found", () => {
  for (const key of ["music", "sound", "music_name", "original_sound", "song", "sound_name"]) {
    const r = normalizeTikTokBrightData(bdTikTok({ [key]: "a catchy sound" }));
    assert.equal(r.sound, "a catchy sound", `did not find sound under ${key}`);
  }
});

test("tiktok: a nested sound object is flattened to its title, not stringified", () => {
  const r = normalizeTikTokBrightData(bdTikTok({ music_info: { title: "Espresso", id: "9" } }));
  assert.equal(r.sound, "Espresso");
});

// This is gate check 4's answer in code: no sound field anywhere means the
// record rejects, and a run of all-rejects means CRMA-983 reopens.
test("tiktok: no sound field anywhere leaves sound null, which rejects the record", () => {
  const r = normalizeTikTokBrightData(bdTikTok());
  assert.equal(r.sound, null);

  const out = normalizeRecords({
    platform: "tiktok",
    rawRecords: [bdTikTok()],
    map: normalizeTikTokBrightData,
  });
  assert.equal(out.records.length, 0);
  assert.deepEqual(out.reject_reasons, { "missing:sound": 1 });
});

// Verified against a real payload on 2026-09-07: BOTH fields are present and
// they are not interchangeable. `video_url` is a signed CDN link carrying an
// `expire` timestamp — it plays today and 404s later. This map makes
// verifiable URLs a hard requirement, so picking it would ship signals whose
// evidence rots silently.
test("tiktok: the stable permalink wins over the expiring CDN link", () => {
  const raw = bdTikTok({
    url: "https://www.tiktok.com/@cook/video/7123456789",
    video_url: "https://v16-webapp-prime.us.tiktok.com/video/tos/x/?expire=1788994296&signature=abc",
  });
  assert.equal(normalizeTikTokBrightData(raw).url, "https://www.tiktok.com/@cook/video/7123456789");
  assert.doesNotMatch(normalizeTikTokBrightData(raw).url, /expire=/);
});

test("tiktok: video_url is still used when no permalink is present", () => {
  const raw = bdTikTok({ url: undefined, video_url: "https://cdn.example/v.mp4" });
  assert.equal(normalizeTikTokBrightData(raw).url, "https://cdn.example/v.mp4");
});

// The vendor returns `share_count` as a string and `num_share_count` as a
// number on the same record. A lone string among numeric engagement fields
// makes downstream comparisons silently wrong rather than loudly broken.
test("tiktok: the numeric share count wins over the string one", () => {
  const raw = bdTikTok({ share_count: "1391", num_share_count: 1391 });
  assert.equal(normalizeTikTokBrightData(raw).share_count, 1391);
});

test("tiktok: a string share count is still used when it is all the vendor sends", () => {
  const raw = bdTikTok({ share_count: "1391", num_share_count: undefined });
  assert.equal(normalizeTikTokBrightData(raw).share_count, "1391");
});

test("tiktok: create_time falls back to the product page's `timestamp`", () => {
  const raw = bdTikTok({ create_time: undefined, timestamp: "2026-09-02T00:00:00Z" });
  assert.equal(normalizeTikTokBrightData(raw).create_time, "2026-09-02T00:00:00Z");
});

test("tiktok: the vendor record survives whole under raw", () => {
  const raw = bdTikTok({ music: "s", db_source: "tiktok" });
  assert.equal(normalizeTikTokBrightData(raw).raw.db_source, "tiktok");
});

// --- Reddit -----------------------------------------------------------------

const bdReddit = (over = {}) => ({
  post_id: "t3_abc123",
  url: "https://www.reddit.com/r/cooking/comments/abc123/x/",
  user_posted: "someone",
  title: "What is everyone making this week?",
  description: "I have been on a braising kick.",
  num_upvotes: 412,
  num_comments: 57,
  date_posted: "2026-09-01T14:05:00Z",
  tag: "Discussion",
  community_name: "cooking",
  community_url: "https://www.reddit.com/r/cooking/",
  community_members_num: 4100000,
  ...over,
});

// Each of these four vendor names is the non-obvious one. A regression here
// means every Reddit signal downstream loses a field silently.
test("reddit: the four trap field names map correctly", () => {
  const r = normalizeRedditBrightData(bdReddit());
  assert.equal(r.body, "I have been on a braising kick.", "body comes from `description`");
  assert.equal(r.score, 412, "score comes from `num_upvotes`");
  assert.equal(r.subreddit, "cooking", "subreddit comes from `community_name`");
  assert.equal(r.created_at, "2026-09-01T14:05:00Z", "created_at comes from `date_posted`");
});

test("reddit: the subreddit keeps the vendor's bare name, with no r/ invented", () => {
  assert.equal(normalizeRedditBrightData(bdReddit()).subreddit, "cooking");
});

test("reddit: a well-formed record passes validation", () => {
  const out = normalizeRecords({
    platform: "reddit",
    rawRecords: [bdReddit()],
    map: normalizeRedditBrightData,
  });
  assert.equal(out.records.length, 1);
  assert.equal(out.rejected, 0);
});

// The same schema serves all three Reddit modes, which is what makes gate
// check 1's possible move to keyword discovery a request-layer change only.
test("reddit: a keyword-mode record normalizes identically", () => {
  const r = normalizeRedditBrightData(bdReddit({ community_name: "food" }));
  assert.equal(r.subreddit, "food");
  assert.equal(r.post_id, "t3_abc123");
});

// --- Kickstarter ------------------------------------------------------------

const ksProject = (over = {}) => ({
  id: 987654321,
  name: "A Very Good Thermos",
  blurb: "Keeps coffee hot for 18 hours.",
  pledged: 48210,
  goal: 25000,
  percent_funded: 192,
  backers_count: 812,
  state: "live",
  category: { name: "Product Design", id: 22 },
  launched_at: 1756684800,
  deadline: 1759276800,
  urls: { web: { project: "https://www.kickstarter.com/projects/x/a-very-good-thermos" } },
  ...over,
});

test("kickstarter: the community-described shape maps as expected", () => {
  const r = normalizeKickstarterBrightData(ksProject());
  assert.equal(r.project_id, "987654321");
  assert.equal(r.title, "A Very Good Thermos");
  assert.equal(r.url, "https://www.kickstarter.com/projects/x/a-very-good-thermos");
  assert.equal(r.percent_funded, 192);
  assert.equal(r.category, "Product Design");
});

// The id is the signal itself under CRMA-984 ("first sighting of a project
// id"), and SIGNAL_ID derives from it, so it is normalized to a string rather
// than left as whatever JSON type the endpoint happens to use.
test("kickstarter: a numeric project id becomes a stable string", () => {
  assert.equal(normalizeKickstarterBrightData(ksProject({ id: 5 })).project_id, "5");
  assert.equal(typeof normalizeKickstarterBrightData(ksProject()).project_id, "string");
});

test("kickstarter: the nested project URL is read without throwing when absent", () => {
  const r = normalizeKickstarterBrightData(ksProject({ urls: undefined }));
  assert.equal(r.url, null);
  assert.doesNotThrow(() => normalizeKickstarterBrightData({ id: 1 }));
});

test("kickstarter: a flat category string is kept as-is", () => {
  assert.equal(normalizeKickstarterBrightData(ksProject({ category: "Food" })).category, "Food");
});

// The whole shape is community-reverse-engineered, so being wrong is a live
// possibility. Being wrong must reject loudly rather than emit a half record.
test("kickstarter: a payload with different field names rejects rather than half-maps", () => {
  const out = normalizeRecords({
    platform: "kickstarter",
    rawRecords: [{ project_slug: "x", headline: "y" }],
    map: normalizeKickstarterBrightData,
  });
  assert.equal(out.records.length, 0);
  assert.equal(out.rejected, 1);
  assert.deepEqual(out.reject_reasons, { "missing:project_id,url,title": 1 });
});
