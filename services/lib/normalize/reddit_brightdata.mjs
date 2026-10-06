// (reddit, brightdata) normalizer — CRMA-986, keyed per CRMA-985.
//
// Field names verified 2026-09-07 against Bright Data's Reddit posts API
// reference. The discover-by-subreddit-url, discover-by-keyword and
// collect-by-url pages publish an IDENTICAL schema, so this one normalizer
// covers all three modes — which matters, because CRMA-986's gate check 1 may
// move CRMA-982's Reddit route from subreddit discovery to keyword discovery.
// If it does, only services/lib/scrape_requests.mjs changes; this file does not.
//
// Documented fields: post_id, url, user_posted, title, description,
// num_upvotes, num_comments, date_posted, tag, community_name, community_url,
// community_description, community_members_num, community_rank, related_posts,
// comments, photos, videos.
//
// FOUR VENDOR NAMES ARE TRAPS, because the obvious guess is wrong in each case:
//   the post body is `description`, NOT `selftext` or `body`
//   the score is `num_upvotes`, NOT `score` or `ups`
//   the subreddit is `community_name`, NOT `subreddit`
//   the timestamp is `date_posted`, NOT `created_at` or `created_utc`
// This is exactly what Level 1 normalization buys: the vendor's names stop at
// this file, and every ingester downstream reads Reddit's own vocabulary.
//
// The published list comes from an EXAMPLE RESPONSE, not a schema table —
// there is no schema table on either page. Treat it as "fields seen in the
// example" rather than an exhaustive contract, and expect the live payload to
// be a superset (the TikTok dataset demonstrably is).

/**
 * @param {object} raw a Bright Data Reddit posts record
 * @returns {object} the platform-shaped record
 */
export function normalizeRedditBrightData(raw) {
  return {
    post_id: raw.post_id ?? null,
    url: raw.url ?? null,
    title: raw.title ?? null,

    // Reddit's own word for the post body is "selftext"; the vendor calls it
    // `description`. `body` is the word the rest of this codebase uses for
    // evidence text, and CRMA-1006 owns what becomes SIGNAL_TEXT.
    body: raw.description ?? null,

    // Bare name, no `r/` prefix — that is how the vendor returns it, and
    // adding a prefix here would be inventing data.
    subreddit: raw.community_name ?? null,
    subreddit_url: raw.community_url ?? null,
    subreddit_members: raw.community_members_num ?? null,

    author: raw.user_posted ?? null,
    score: raw.num_upvotes ?? null,
    comment_count: raw.num_comments ?? null,

    // ISO 8601 string, e.g. "2026-04-05T14:05:00Z" — not an epoch integer.
    // CRMA-982's velocity-by-re-poll-delta reads this.
    created_at: raw.date_posted ?? null,

    // Reddit flair ("Help", "Tutorial").
    flair: raw.tag ?? null,

    raw,
  };
}
