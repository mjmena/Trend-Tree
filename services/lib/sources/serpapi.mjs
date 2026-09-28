// serpapi.mjs — the shared SerpApi client (CRMA-1337, spec
// docs/prd/serpapi-sources.md "Shared SerpApi client").
//
// The only code that knows SerpApi's URL, parameters and error shapes. The
// TikTok ingester (services/lib/tiktok_ingest.mjs) uses it, and the Reddit
// corroboration oracle (CRMA-1339) is to reuse it. The key comes from Secret
// Manager (`serpapi-api-key`) through the caller; it never appears in an
// error message.
//
// Every failure is a SerpApiError with a `kind`: http, api, timeout or
// network. One SerpApi answer is NOT a failure: "Google hasn't returned any
// results for this query." arrives as an `error` field on a 200, and a query
// with no results is normal for a fixed seed list (CRMA-1317: `kitchen gadget`
// returned 0). The client strips that field and returns the body.

export const SERPAPI_URL = "https://serpapi.com/search.json";
// Uncached searches are slow: google_short_videos reported total_time_taken
// of 34s and 66s on 2026-09-28, and a 30s timeout failed the first live run.
export const DEFAULT_TIMEOUT_MS = 120_000;

const NO_RESULTS = /hasn't returned any results/i;

export class SerpApiError extends Error {
  constructor(message, { kind, status = null } = {}) {
    super(message);
    this.name = "SerpApiError";
    this.kind = kind;
    this.status = status;
  }
}

export function createSerpApiClient({ apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error("createSerpApiClient: apiKey is required");

  async function search(params) {
    const url = new URL(SERPAPI_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("api_key", apiKey);
    const label = `SerpApi ${params.engine ?? "search"} q=${JSON.stringify(params.q ?? "")}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url.toString(), { headers: { Accept: "application/json" }, signal: controller.signal });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted || err?.name === "AbortError") {
        throw new SerpApiError(`${label}: timed out after ${timeoutMs}ms`, { kind: "timeout" });
      }
      throw new SerpApiError(`${label}: request failed: ${err.message}`, { kind: "network" });
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // handled below: a non-2xx reports its status, a 2xx reports the bad body
    }

    if (res.status < 200 || res.status >= 300) {
      const detail = body?.error ? `: ${body.error}` : "";
      throw new SerpApiError(`${label}: HTTP ${res.status}${detail}`, { kind: "http", status: res.status });
    }
    if (body === null || typeof body !== "object") {
      throw new SerpApiError(`${label}: response is not JSON: ${String(text).slice(0, 120)}`, { kind: "api" });
    }
    if (body.error) {
      if (NO_RESULTS.test(body.error)) {
        const { error: _noResults, ...rest } = body;
        return rest;
      }
      throw new SerpApiError(`${label}: ${body.error}`, { kind: "api" });
    }
    return body;
  }

  return { search };
}
