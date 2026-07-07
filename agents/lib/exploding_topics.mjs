// exploding_topics.mjs — canonical Exploding Topics (Semrush) adapter.
//
// The corroboration oracle at promotion (ADR-0004): a pure response
// normalizer + a /database-search request builder. ET is queried by the
// [candidate query] (STG_TREND_CANDIDATES.QUERY, ADR-0004 slice 1); a
// positive verdict earns a single-family candidate its missing second
// source family. ET is NOT a [Source] — it never writes FCT_SIGNALS /
// SOURCE_BREAKDOWN.
//
// =====================================================================
// IMPORTANT: This file is the SOURCE OF TRUTH. Pipedream GitHub-synced
// workflows do not bundle cross-file imports, so the deployed copy is
// INLINED at the top of the promotion subagent step:
//   - promotion-agent-p_yKCmm9r/run_subagent/entry.js
// When you change something here, update that inlined copy.
//
// API reference: docs/exploding-topics-api.md (spec v1.7.1, verified live
// 2026-06-29). Base URL, auth-as-query-param, the Cloudflare UA gotcha, and
// the two HTTP-200 miss sentinels all come from there.
// =====================================================================

export const ET_BASE_URL = "https://api.explodingtopics.com/api/v1";

// ET is behind Cloudflare and SILENTLY 403s default library User-Agents
// (Python-urllib, etc.). A browser-style UA is mandatory. Same class of
// gotcha as GDELT.
export const ET_BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Both are returned with HTTP 200 (not 404). "No meta trends found." is the
// wording ET uses for /database-search; "No topic found." is /topic's. We
// query /database-search, but accept both so the normalizer is endpoint-safe.
export const ET_MISS_MESSAGES = ["No meta trends found.", "No topic found."];

// A small absolute-volume floor below which an ET match is too thin to count
// as real independent demand. The agent additionally judges concept-sameness;
// this is the mechanical half of the corroboration rubric (ADR-0004).
export const ET_MIN_ABSOLUTE_VOLUME = 1000;

// Build a GET /database-search request. Returns { url, headers, log_target }.
// The api_key rides in the query string, so `url` is SECRET — never log it.
// Log `log_target` instead (same endpoint + keyword, no key).
export function buildEtSearchRequest({ keyword, apiKey, responseTimeframe = "last_12_months" }) {
  if (!keyword || !String(keyword).trim()) throw new Error("buildEtSearchRequest: keyword required");
  if (!apiKey) throw new Error("buildEtSearchRequest: apiKey required");
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("keyword", String(keyword).trim());
  if (responseTimeframe) params.set("response_timeframe", responseTimeframe);
  const safe = new URLSearchParams();
  safe.set("keyword", String(keyword).trim());
  if (responseTimeframe) safe.set("response_timeframe", responseTimeframe);
  return {
    url: `${ET_BASE_URL}/database-search?${params.toString()}`,
    headers: { "User-Agent": ET_BROWSER_UA },
    log_target: `${ET_BASE_URL}/database-search?${safe.toString()}`,
  };
}

// Pure. Normalize a raw /database-search response into a stable verdict shape.
// Input:  { status, body } — HTTP status code + parsed JSON body (or null).
// Output: {
//   matched,            // boolean — did ET return ANY result (total > 0)?
//   total,              // number of fuzzy results
//   keyword,            // top result's keyword (null on miss)
//   path,               // top result's stable path id (null on miss)
//   absolute_volume,    // top result's last-month searches (null on miss)
//   classifications,    // per-timeframe verdicts — RECORDED, non-gating
//   growth,             // per-timeframe % growth   — RECORDED, non-gating
//   candidates,         // up to 5 fuzzy matches for agent concept-judging
//   error,              // set on transport/auth failure (e.g. 'http_403')
//   miss_message,       // set when a miss sentinel was returned
// }
// `matched` is the transport-level hit (total > 0). It is deliberately NOT a
// corroboration verdict: /database-search is fuzzy and returns near-matches,
// so the promotion agent must still judge concept-sameness + the volume floor.
export function normalizeEtResponse({ status, body } = {}) {
  const miss = (extra) => ({
    matched: false, total: 0,
    keyword: null, path: null, absolute_volume: null,
    classifications: null, growth: null, candidates: [], ...extra,
  });

  // Transport / auth failure. Cloudflare 403 (bad UA) is the classic case.
  if (typeof status === "number" && status !== 200) {
    return miss({ error: `http_${status}` });
  }

  const b = body || {};

  // Miss sentinels — HTTP 200 with a message field.
  if (typeof b.message === "string" && ET_MISS_MESSAGES.includes(b.message.trim())) {
    return miss({ miss_message: b.message.trim() });
  }

  const results = Array.isArray(b.result) ? b.result : [];
  const total = Number(b.total ?? results.length) || 0;
  if (total <= 0 || results.length === 0) return miss({});

  const top = results[0] || {};
  const num = (v) => (typeof v === "number" ? v : v != null && v !== "" ? Number(v) : null);
  return {
    matched: true,
    total,
    keyword: top.keyword ?? null,
    path: top.path ?? null,
    absolute_volume: num(top.absolute_volume),
    classifications: top.classifications ?? null,
    growth: top.growth ?? null,
    candidates: results.slice(0, 5).map((r) => ({
      keyword: r.keyword ?? null,
      path: r.path ?? null,
      absolute_volume: num(r.absolute_volume),
      categories: r.categories ?? null,
    })),
  };
}
