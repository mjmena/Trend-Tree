// Request validation for the scrape-gateway's `POST /pull {source, params}`
// (CRMA-986). Pure functions: no HTTP, no vendor calls, no clock.
//
// Each platform's accepted params come straight from its route decision, and
// the vendor's input schema was verified against Bright Data's API reference
// on 2026-09-07. Where the two disagree the route decision wins and the
// mismatch is flagged here, because a mismatch is a finding for the map rather
// than something to paper over in code.
//
// TWO PLATFORM FAMILIES, ONE CONTRACT.
//
// TikTok and Reddit are dataset-backed: the vendor runs a job, hands back a
// snapshot id, and the gateway polls it. Kickstarter is not — CRMA-984 routed
// it through Web Unlocker against Kickstarter's own discover/advanced JSON
// surface, which is a single synchronous fetch with no vendor-side job.
//
// CRMA-985 did not resolve that difference; it described one job-and-poll
// contract and assumed all three platforms were vendor-job-backed. Rather than
// give Kickstarter a second contract, the gateway DEFERS its fetch: `POST
// /pull` validates the params and encodes them into the job id, and the `GET`
// performs the unlocker fetch. The caller sees the same two-step for all three
// platforms, and the service stays stateless — the job id carries the request,
// exactly as it carries a snapshot handle for the other two.
//
// The cost of that choice, stated plainly: for Kickstarter the work happens on
// the GET, so a caller that retries a GET pays for a second fetch. At Web
// Unlocker's 1 credit per request that is a rounding error, and validation
// still happens at POST time so bad params fail fast rather than at poll time.

export class InvalidRequestError extends Error {}

export const SOURCES = ["tiktok", "reddit", "kickstarter"];

// Which vendor product serves each platform. "dataset" polls a snapshot;
// "unlocker" defers a fetch into the job id. See the header.
export const SOURCE_KIND = {
  tiktok: "dataset",
  reddit: "dataset",
  kickstarter: "unlocker",
};

function str(params, name, { required = false } = {}) {
  const v = params?.[name];
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new InvalidRequestError(`params.${name} is required`);
    return null;
  }
  if (typeof v !== "string") throw new InvalidRequestError(`params.${name} must be a string`);
  return v.trim();
}

function strArray(params, name, { max = 50 } = {}) {
  const v = params?.[name];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new InvalidRequestError(`params.${name} must be an array`);
  const out = v.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new InvalidRequestError(`params.${name} must contain non-empty strings`);
    }
    return item.trim();
  });
  if (out.length === 0) throw new InvalidRequestError(`params.${name} must not be empty`);
  if (out.length > max) throw new InvalidRequestError(`params.${name} accepts at most ${max} entries`);
  return out;
}

function posInt(params, name, { max = 1000 } = {}) {
  const v = params?.[name];
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 1 || v > max) {
    throw new InvalidRequestError(`params.${name} must be an integer between 1 and ${max}`);
  }
  return v;
}

/**
 * Validate `{source, params}` and describe the vendor call it implies.
 *
 * @returns {{source: string, kind: string, discoverBy?: string,
 *            input?: object[], limitPerInput?: number|null, url?: string}}
 */
export function buildRequest(body) {
  const source = str(body, "source", { required: true })?.toLowerCase();
  if (!SOURCES.includes(source)) {
    throw new InvalidRequestError(`unknown source: ${JSON.stringify(source)} (expected one of ${SOURCES.join(", ")})`);
  }
  const params = body?.params ?? {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new InvalidRequestError("params must be an object");
  }

  if (source === "tiktok") return buildTikTok(params);
  if (source === "reddit") return buildReddit(params);
  return buildKickstarter(params);
}

// CRMA-983: curated, repo-maintained keyword and hashtag lists, hashtag-funnel
// first. Both arrive as `keywords` here — Bright Data's TikTok discovery takes
// `search_keyword` and treats a "#tag" string as a hashtag search, so the
// gateway does not need two modes.
//
// NO VENDOR-SIDE RECENCY FILTER IN THIS MODE. `discover_by=keyword` accepts
// only `search_keyword`, `num_of_posts` and `country`, so CRMA-1021's 90-day
// freshness guard must run after the pull, on `create_time`. That is the
// ingester's job, not the gateway's: the gateway is a normalizing proxy and
// does not drop records on policy.
//
// BUT THE DATASET HAS A THIRD MODE THIS FUNCTION DOES NOT USE, and an earlier
// version of this comment asserted no recency filter existed anywhere, which
// stopped the next reader looking. `discover_by` accepts `keyword`, `url` and
// `profile_url`. Only `profile_url` takes `start_date` / `end_date` /
// `sort_by`. `url` is dead: 13 inputs across tag pages and video permalinks
// returned 0 records on two separate days, including Bright Data's own
// documented example (CRMA-1021). CRMA-1023 measures whether `profile_url`
// should become the ambient base — if it does, the guard moves to the vendor
// and stops costing an ~85% discard on every pull.
function buildTikTok(params) {
  const keywords = strArray(params, "keywords", { max: 20 });
  if (!keywords) throw new InvalidRequestError("params.keywords is required for tiktok");
  const limit = posInt(params, "limit_per_input", { max: 500 });
  return {
    source: "tiktok",
    kind: "dataset",
    discoverBy: "keyword",
    input: keywords.map((k) => ({ search_keyword: k })),
    limitPerInput: limit,
  };
}

// CRMA-982: post-level records from curated subreddits, `new` + `top?t=day`.
//
// `top?t=day` IS EXPRESSIBLE, THROUGH AN UNDOCUMENTED FIELD. Bright Data's
// docs describe only `url` and `sort_by` for this mode and no time filter at
// all. But its validation errors echo the NORMALIZED input, which leaked three
// undocumented fields — `sort_by_time`, `keyword`, `start_date`. Enumerated on
// 2026-09-07 (CRMA-986 gate check 1) by pairing each candidate with a
// deliberately invalid `sort_by`, so validation failed before any job ran:
//
//   sort_by       Top | New | Hot | Rising
//   sort_by_time  Now | Today | This Week | This Month | This Year | All Time
//
// Both are CASE-SENSITIVE and capitalized; lowercase `top` is a 400. The API
// reference's own example passing `"sort_by": "top"` is simply wrong.
//
// SORT_BY_TIME IS NOT OPTIONAL IN PRACTICE for a Top pull. Verified end-to-end:
// `Top` alone returns ALL-TIME top posts (r/Cooking gave 2020, 2021 and 2024
// posts at 25k-35k upvotes), which is useless for trend detection because every
// pull returns the same canonical posts. `Top` + `Today` returned three posts
// all inside 24 hours. A caller asking for Top without a time window is almost
// certainly making that mistake, so this warns rather than silently obeying.
//
// Values are still passed through rather than validated against the enum above:
// it was recovered by probing an undocumented surface, so the vendor — not this
// file — stays the authority on what it accepts.
export const REDDIT_SORTS_NEEDING_TIME = new Set(["Top", "Rising"]);

function buildReddit(params) {
  const subreddits = strArray(params, "subreddit_urls", { max: 50 });
  if (!subreddits) throw new InvalidRequestError("params.subreddit_urls is required for reddit");
  for (const url of subreddits) {
    if (!/^https:\/\/(www\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/?$/.test(url)) {
      throw new InvalidRequestError(`not a subreddit URL: ${JSON.stringify(url)}`);
    }
  }
  const sortBy = str(params, "sort_by");
  const sortByTime = str(params, "sort_by_time");
  const limit = posInt(params, "limit_per_input", { max: 500 });

  const warnings = [];
  if (sortBy && REDDIT_SORTS_NEEDING_TIME.has(sortBy) && !sortByTime) {
    warnings.push(
      `sort_by=${sortBy} without sort_by_time returns ALL-TIME results, which repeat on every ` +
        `pull — pass sort_by_time (e.g. "Today") for CRMA-982's top?t=day route`,
    );
  }

  return {
    source: "reddit",
    kind: "dataset",
    discoverBy: "subreddit_url",
    input: subreddits.map((url) => ({
      url,
      ...(sortBy ? { sort_by: sortBy } : {}),
      ...(sortByTime ? { sort_by_time: sortByTime } : {}),
    })),
    limitPerInput: limit,
    warnings,
  };
}

// CRMA-984: traction-gated — state=live plus a funded/raised bucket over
// curated category_ids, daily, first sighting of a project id being the
// signal. The gateway builds the Kickstarter query string; Web Unlocker
// fetches it.
//
// `raised` is Kickstarter's own bucket parameter, not a free number. Gate
// check 2 must confirm the filter survives the vendor route — CRMA-984 says
// that if it does not, the design falls back to re-poll diffing and that
// decision reopens.
export const KICKSTARTER_DISCOVER = "https://www.kickstarter.com/discover/advanced";

function buildKickstarter(params) {
  const categories = strArray(params, "category_ids", { max: 30 });
  if (!categories) throw new InvalidRequestError("params.category_ids is required for kickstarter");
  for (const id of categories) {
    if (!/^[0-9]+$/.test(id)) {
      throw new InvalidRequestError(`category_ids must be numeric ids, got ${JSON.stringify(id)}`);
    }
  }
  const raised = str(params, "raised");
  if (raised !== null && !/^[0-2]$/.test(raised)) {
    // Kickstarter's buckets: 0 = <75% funded, 1 = 75-100%, 2 = >100%.
    throw new InvalidRequestError("params.raised must be Kickstarter's bucket 0, 1 or 2");
  }
  const page = posInt(params, "page", { max: 200 });

  const qs = new URLSearchParams();
  // One request per category would be cleaner, but Kickstarter's discover
  // endpoint takes a single category_id, so a multi-category pull is several
  // job ids. Keeping one category per request makes that explicit rather than
  // silently collapsing the list.
  if (categories.length > 1) {
    throw new InvalidRequestError(
      "kickstarter accepts one category_id per pull — Kickstarter's discover endpoint takes a single category",
    );
  }
  qs.set("category_id", categories[0]);
  qs.set("state", "live");
  qs.set("sort", "newest");
  if (raised !== null) qs.set("raised", raised);
  if (page !== null) qs.set("page", String(page));
  qs.set("format", "json");

  return {
    source: "kickstarter",
    kind: "unlocker",
    url: `${KICKSTARTER_DISCOVER}?${qs}`,
    handle: encodeUnlockerHandle({ category: categories[0], raised, page }),
  };
}

// The deferred-fetch handle. Because the gateway stores nothing, a Kickstarter
// job id must carry its own request — see this file's header. The handle is
// the three variable parts of the discover query, in a form that fits
// scrape_job_id.mjs's `[A-Za-z0-9_-]{1,128}` charset:
//
//   c22            category 22, no traction filter, first page
//   c22-r2-p3      category 22, raised bucket 2, page 3
//
// Base64 was the obvious alternative and is worse here: the full URL exceeds
// the 128-character handle cap once encoded, and an opaque blob would make a
// job id impossible to read in a log line. This form is short, debuggable, and
// round-trips exactly.
export function encodeUnlockerHandle({ category, raised = null, page = null }) {
  let handle = `c${category}`;
  if (raised !== null && raised !== undefined) handle += `-r${raised}`;
  if (page !== null && page !== undefined) handle += `-p${page}`;
  return handle;
}

/**
 * Rebuild the Kickstarter URL a deferred job id stands for.
 *
 * This runs on the GET, against a handle that arrived in a URL path, so it
 * re-validates rather than trusting: the handle is re-parsed into params and
 * pushed back through buildKickstarter, which applies exactly the same checks
 * the POST applied. A tampered handle therefore fails the same way a bad POST
 * body would, and cannot reach Web Unlocker with a URL the gateway would not
 * have built itself.
 */
export function urlFromUnlockerHandle(handle) {
  const m = /^c(\d+)(?:-r([0-2]))?(?:-p(\d+))?$/.exec(handle ?? "");
  if (!m) throw new InvalidRequestError(`malformed kickstarter job handle: ${JSON.stringify(handle)}`);
  const [, category, raised, page] = m;
  const params = { category_ids: [category] };
  if (raised !== undefined) params.raised = raised;
  if (page !== undefined) params.page = Number(page);
  return buildKickstarter(params).url;
}
