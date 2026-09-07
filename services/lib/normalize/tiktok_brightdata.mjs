// (tiktok, brightdata) normalizer — CRMA-986, keyed per CRMA-985.
//
// Level 1: vendor-neutral, but keeps TikTok's own vocabulary. The vendor's
// record is preserved whole under `raw`, so nothing is lost by mapping.
//
// FIELD NAMES ARE NOT FULLY SETTLED, and that is a known state rather than an
// oversight. Bright Data publishes two disagreeing field inventories for this
// dataset, verified 2026-09-07:
//
//   The API reference examples show 13 fields: post_id, description,
//   create_time, share_count, collect_count, comment_count, play_count,
//   video_duration, hashtags, video_url, profile_username, profile_url,
//   is_verified.
//
//   The product page shows a superset including `digg_count` (the like count),
//   `timestamp`, `url` and `db_source`.
//
// So the API-reference list is an abbreviated illustration, not a schema. That
// matters for one field in particular.
//
// THE SOUND FIELD IS CRMA-986'S GATE CHECK 4. CRMA-983 reopened TikTok on a
// data shape of description + SOUND + engagement + public URL, and no Bright
// Data page documents a sound or music field at all. Because the published
// lists are demonstrably incomplete, absence from the docs is not evidence of
// absence from the payload — only a live request settles it. This normalizer
// therefore probes the plausible names rather than betting on one, and if none
// is present the record is rejected as `missing:sound` by scrape_normalize.mjs.
// That rejection IS the gate check's answer: a run whose records all reject on
// `missing:sound` means TikTok reopens at CRMA-983.
const SOUND_KEYS = ["music", "sound", "music_name", "original_sound", "song", "music_info", "sound_name"];

// URL ORDER IS LOAD-BEARING — `url` FIRST, and never `video_url` first.
// Verified against a real payload on 2026-09-07: both fields exist and they
// are not interchangeable.
//
//   url       https://www.tiktok.com/@motherhoodmanaged/video/7243240490517318958
//   video_url https://v16-webapp-prime.us.tiktok.com/video/tos/...&expire=1788994296
//             &signature=7ce5761c...
//
// `video_url` is a SIGNED CDN LINK WITH AN EXPIRY. It plays today and 404s
// later. This map makes evidence purity — verifiable URLs — a hard
// requirement, and CRMA-983 reopened TikTok on a shape that includes a public
// URL, so an expiring link fails the requirement that justified the reopen.
// Preferring it would have shipped signals whose evidence rots silently.
const URL_KEYS = ["url", "video_url"];

const LIKE_KEYS = ["digg_count", "like_count", "likes"];

// `share_count` comes back as a STRING ("1391") while `num_share_count` is a
// number (verified 2026-09-07 on the same payload). Prefer the numeric one:
// the rest of the engagement fields are numbers, and a lone string would make
// any downstream comparison silently wrong rather than loudly broken.
const SHARE_KEYS = ["num_share_count", "share_count"];

function firstPresent(raw, keys) {
  for (const key of keys) {
    const v = raw[key];
    if (v === null || v === undefined) continue;
    // A nested object (e.g. `music_info: {title: ...}`) is flattened to its
    // most name-like member rather than stringified into "[object Object]".
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = v.title ?? v.name ?? v.music_name ?? null;
      if (nested != null && String(nested).trim() !== "") return String(nested);
      continue;
    }
    if (String(v).trim() !== "") return typeof v === "string" ? v : v;
  }
  return null;
}

/**
 * @param {object} raw a Bright Data TikTok posts record
 * @returns {object} the platform-shaped record
 */
export function normalizeTikTokBrightData(raw) {
  return {
    post_id: raw.post_id ?? null,
    url: firstPresent(raw, URL_KEYS),
    description: raw.description ?? null,
    sound: firstPresent(raw, SOUND_KEYS),

    // CRMA-983's ~7-day freshness guard runs on this, AFTER the pull: TikTok
    // discovery accepts no vendor-side recency filter in either keyword or URL
    // mode (verified 2026-09-07). The gateway does not drop on policy — it is
    // a normalizing proxy — so it surfaces the timestamp and the ingester
    // decides.
    create_time: raw.create_time ?? raw.timestamp ?? null,

    play_count: raw.play_count ?? null,
    share_count: firstPresent(raw, SHARE_KEYS),
    comment_count: raw.comment_count ?? null,
    collect_count: raw.collect_count ?? null,
    like_count: firstPresent(raw, LIKE_KEYS),

    hashtags: Array.isArray(raw.hashtags) ? raw.hashtags : null,
    video_duration: raw.video_duration ?? null,
    profile_username: raw.profile_username ?? null,
    profile_url: raw.profile_url ?? null,
    is_verified: raw.is_verified ?? null,

    raw,
  };
}
