// url_canon.mjs — canonical URL construction + HEAD-resolved canonicalization
// for STG_EXTERNAL_SIGNALS.URL (slice 4 of the LLM-prompt + signal-key plan).
//
// =====================================================================
// IMPORTANT: This file is the SOURCE OF TRUTH. The actual deployed copies
// live INLINED into each ingester workflow's entry.js — Pipedream
// GitHub-synced workflows do not bundle cross-file imports. When you
// change something here, search for the function names and update each
// inlined copy. Inlined sites added per-workflow as ingesters migrate.
// =====================================================================
//
// Two flavors of canonicalization:
//
//   1. constructAggregationUrl(source, payload)
//      Synchronous. Builds the canonical URL for aggregation sources
//      (amazon_trends, google_trends_explore, tiktok, pinterest) where
//      the URL doesn't exist on the public web until we construct it.
//
//   2. canonicalizeContentUrl(rawUrl, opts)
//      Async. HEAD-resolves the URL, follows redirects, strips tracking
//      params, normalizes host. Used by content sources (gdelt, bluesky,
//      wikimedia, amazon_movers, reddit) to dedupe syndicated articles
//      that appear via different aggregator URLs.
//
// Both ultimately produce the value that goes into STG_EXTERNAL_SIGNALS.URL.

// Tracking parameters stripped during canonicalization. Conservative list
// — only params that are universally analytics/attribution. Domain-specific
// session params live in PER_DOMAIN_STRIP below.
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "utm_name", "utm_brand", "utm_social", "utm_social-type",
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid",
  "ref", "ref_src", "ref_url", "referrer",
  "_ga", "_gl", "_gac",
  "yclid", "wbraid", "gbraid",
  "igshid", "twclid",
]);

// Per-domain extra params to strip beyond the universal list.
const PER_DOMAIN_STRIP = {
  "amazon.com": new Set(["psc", "th", "linkCode", "linkId", "tag", "ref_", "qid", "sr"]),
  "youtube.com": new Set(["si", "feature"]),
  "youtu.be":    new Set(["si"]),
};

/**
 * Build the canonical URL for an aggregation-style source. These sources
 * don't fetch a single piece of hosted content — they aggregate items
 * (Amazon search results, Google Trends queries, TikTok hashtag pages,
 * Pinterest trend pages). The URL points to the aggregator page that
 * produced the signal.
 *
 * @param {"amazon_trends"|"google_trends_explore"|"tiktok"|"pinterest"} source
 * @param {Object} payload  Source-specific shape:
 *   amazon_trends:        { theme, department }
 *   google_trends_explore:{ query, geo }
 *   tiktok:               { hashtag }                (hashtag without leading #)
 *   pinterest:            { category | trend_slug }  (one of the two)
 * @returns {string|null}   Canonical URL, or null if required fields missing.
 */
export function constructAggregationUrl(source, payload) {
  if (!payload) return null;
  switch (source) {
    case "amazon_trends": {
      const theme = String(payload.theme || "").trim();
      if (!theme) return null;
      const slug = slugify(theme);
      const dept = encodeURIComponent(String(payload.department || "all"));
      return `https://www.amazon.com/s?k=${slug}&i=${dept}`;
    }
    case "google_trends_explore": {
      const q = String(payload.query || "").trim();
      if (!q) return null;
      // Google Trends accepts + for spaces, no need to fully encodeURIComponent.
      const qEnc = q.replace(/\s+/g, "+").replace(/[^A-Za-z0-9+_-]/g, (c) => encodeURIComponent(c));
      const geo = encodeURIComponent(String(payload.geo || "US"));
      return `https://trends.google.com/trends/explore?q=${qEnc}&geo=${geo}`;
    }
    case "tiktok": {
      const tag = String(payload.hashtag || "").replace(/^#+/, "").trim();
      if (!tag) return null;
      return `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`;
    }
    case "pinterest": {
      const slug = String(payload.trend_slug || payload.category || "").trim();
      if (!slug) return null;
      return `https://trends.pinterest.com/${slugify(slug)}/`;
    }
    default:
      return null;
  }
}

/**
 * Convert a Bluesky AT-protocol URI (`at://did:plc:xxx/app.bsky.feed.post/yyy`)
 * to a public web URL (`https://bsky.app/profile/{did}/post/{rkey}`).
 *
 * @param {string} atUri
 * @returns {string|null}
 */
export function blueskyAtUriToWebUrl(atUri) {
  if (typeof atUri !== "string" || !atUri.startsWith("at://")) return null;
  const parts = atUri.slice("at://".length).split("/");
  // parts: [did, "app.bsky.feed.post", rkey]
  if (parts.length < 3 || parts[1] !== "app.bsky.feed.post") return null;
  const [did, , rkey] = parts;
  if (!did || !rkey) return null;
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

/**
 * HEAD-resolve a content URL and normalize it: follow redirects, strip
 * tracking params, lowercase host (modulo www stripping), strip trailing
 * slash. Returns { canonical, http_status, redirect_chain } so the caller
 * can drop 4xx URLs (LLM hallucinations, dead links).
 *
 * @param {string} rawUrl
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.maxRedirects=5]
 * @returns {Promise<{canonical: string|null, http_status: number, redirect_chain: string[], error?: string}>}
 */
export async function canonicalizeContentUrl(rawUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let resp;
    try {
      resp = await fetch(rawUrl, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    } catch (e) {
      // Some servers reject HEAD; fall back to GET with discarded body.
      resp = await fetch(rawUrl, { method: "GET", redirect: "follow", signal: ctrl.signal });
    }
    const finalUrl = resp.url || rawUrl;
    const canonical = stripAndNormalize(finalUrl);
    return { canonical, http_status: resp.status, redirect_chain: [] };
  } catch (e) {
    return { canonical: null, http_status: 0, redirect_chain: [], error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Synchronous URL normalization without HEAD resolve. Use when you already
 * trust the URL (already-canonical Wikipedia / Amazon links) but want to
 * strip stray tracking params.
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function stripAndNormalize(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // Lowercase host, strip leading www.
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");

  // Strip tracking params (universal + per-domain).
  const domainParams = PER_DOMAIN_STRIP[u.hostname] || PER_DOMAIN_STRIP[u.hostname.replace(/^[^.]+\./, "")];
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k) || (domainParams && domainParams.has(k))) u.searchParams.delete(k);
  }

  // Strip trailing slash unless it's the bare host root.
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  // URL.toString() may append "?" when all params were stripped — clean up.
  s = s.replace(/\?$/, "");
  return s;
}

/**
 * lowercase + replace non-alphanumerics with dashes + collapse, strip leading/trailing dashes.
 * Matches the SQL backfill for amazon_trends so a backfilled row stays
 * identical to a freshly-ingested one.
 */
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
