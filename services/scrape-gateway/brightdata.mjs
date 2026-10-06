// The Bright Data client (CRMA-986). Every endpoint and parameter here was
// verified against Bright Data's own API reference on 2026-09-07; the doc page
// is cited at each call. Two of those pages contradict the vendor's summary
// documentation, so the citations are load-bearing rather than decorative.
//
// The gateway talks to two different Bright Data products, because CRMA-984
// routed Kickstarter differently from the other two:
//
//   Web Scraper API (TikTok, Reddit) — dataset-backed. Trigger a collection,
//     get a snapshot_id, poll it, download it.
//   Web Unlocker (Kickstarter)       — a single unblocked fetch of
//     Kickstarter's own discover/advanced JSON surface, addressed by zone.
//
// ASYNC IS THE ONLY PATH THIS CLIENT USES for the dataset products, even
// though the vendor also offers a synchronous endpoint. CRMA-985's reason for
// that stands after correction: a synchronous call caps at ~1 minute and
// degrades to a 202 the caller must then poll anyway, so a gateway built on it
// would carry two code paths for one contract. (CRMA-985's *stated* reason —
// that discovery is async-only — was wrong, and is corrected on CRMA-986 and
// CRMA-1005. The conclusion survives the correction; the premise did not.)

const BASE = "https://api.brightdata.com";

export class BrightDataError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function readError(res) {
  // Bright Data returns errors as JSON in some paths and bare text in others.
  // The body is capped because it lands in a log line, and an HTML error page
  // from an intermediary proxy can be arbitrarily large.
  const text = await res.text().catch(() => "");
  return text.slice(0, 500);
}

/**
 * Start a dataset collection. Returns the vendor's snapshot handle.
 *
 * Source: docs.brightdata.com/api-reference/web-scraper-api/asynchronous-requests
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.datasetId    e.g. gd_lu702nij2f790tmv9h
 * @param {string} args.discoverBy   e.g. "keyword", "subreddit_url"
 * @param {object[]} args.input      the vendor's input objects
 * @param {number} [args.limitPerInput]
 * @returns {Promise<string>} snapshot_id
 */
export async function triggerCollection({ apiKey, datasetId, discoverBy, input, limitPerInput, fetchImpl = fetch }) {
  const qs = new URLSearchParams({
    dataset_id: datasetId,
    type: "discover_new",
    discover_by: discoverBy,
    // Errors come back as records rather than vanishing. A pull that silently
    // returned fewer records than it should is exactly the failure mode
    // scrape_normalize.mjs's reject counting exists to make loud, and it can
    // only count what the vendor actually hands over.
    include_errors: "true",
    format: "json",
  });
  // NOTE: limit_per_input goes in the QUERY STRING on /trigger but is SILENTLY
  // IGNORED as a query parameter on the synchronous /scrape endpoint, where it
  // must ride in an object-form body instead. This client only uses /trigger,
  // so the query form is correct here — but the asymmetry is a documented trap
  // worth keeping visible for anyone who later adds a sync path.
  if (limitPerInput != null) qs.set("limit_per_input", String(limitPerInput));

  const res = await fetchImpl(`${BASE}/datasets/v3/trigger?${qs}`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    throw new BrightDataError(`trigger failed: HTTP ${res.status}`, {
      status: res.status,
      body: await readError(res),
    });
  }

  const payload = await res.json();
  const snapshotId = payload?.snapshot_id;
  if (!snapshotId) {
    throw new BrightDataError("trigger returned no snapshot_id", { body: JSON.stringify(payload).slice(0, 500) });
  }
  return snapshotId;
}

// The vendor's snapshot lifecycle. `ready` is the only state whose records can
// be downloaded; `failed` and `canceled` are terminal and must not be polled
// forever. Source: docs.brightdata.com/api-reference/web-scraper-api/management-apis/monitor-progress
export const TERMINAL_STATUSES = new Set(["ready", "failed", "canceled"]);

/**
 * Ask the vendor how a snapshot is doing.
 *
 * @returns {Promise<{status: string, snapshot_id?: string, dataset_id?: string}>}
 */
export async function getProgress({ apiKey, snapshotId, fetchImpl = fetch }) {
  const res = await fetchImpl(`${BASE}/datasets/v3/progress/${encodeURIComponent(snapshotId)}`, {
    headers: authHeaders(apiKey),
  });

  // A 404 here is a real answer, not a transport failure: the snapshot never
  // existed, or it aged out. Bright Data retains results for 16 days, so a
  // job id held by a caller across a long outage can legitimately 404.
  if (res.status === 404) {
    throw new BrightDataError("snapshot not found — it never existed or aged out (16-day retention)", {
      status: 404,
    });
  }
  if (!res.ok) {
    throw new BrightDataError(`progress failed: HTTP ${res.status}`, {
      status: res.status,
      body: await readError(res),
    });
  }
  return res.json();
}

/**
 * Download a ready snapshot's records.
 *
 * Source: docs.brightdata.com/api-reference/scrapers/delivery-apis/download-snapshot
 *
 * @returns {Promise<object[]>} the vendor's raw records, unnormalized
 */
export async function downloadSnapshot({ apiKey, snapshotId, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `${BASE}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`,
    { headers: authHeaders(apiKey) },
  );
  if (!res.ok) {
    throw new BrightDataError(`download failed: HTTP ${res.status}`, {
      status: res.status,
      body: await readError(res),
    });
  }
  const payload = await res.json();
  // The endpoint answers with an array. A single object comes back when a job
  // produced exactly one record, and an empty job can answer with neither.
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

/**
 * Fetch one URL through Web Unlocker, returning the target's body unmodified.
 *
 * Source: docs.brightdata.com/products/web-unlocker/send-your-first-request
 *
 * `format: "raw"` is what makes CRMA-984's route possible at all: it returns
 * the target's response body untouched, so a JSON endpoint stays JSON rather
 * than being wrapped or rendered. Whether Turnstile is actually defeated on
 * Kickstarter's `?format=json` surface is CRMA-986's gate check 2.
 *
 * @returns {Promise<string>} the raw response body
 */
export async function unlockerFetch({ apiKey, zone, url, fetchImpl = fetch }) {
  if (!zone) {
    throw new BrightDataError("no Web Unlocker zone configured — set BD_WEB_UNLOCKER_ZONE");
  }
  const res = await fetchImpl(`${BASE}/request`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ zone, url, format: "raw" }),
  });
  if (!res.ok) {
    throw new BrightDataError(`web unlocker failed: HTTP ${res.status}`, {
      status: res.status,
      body: await readError(res),
    });
  }
  return res.text();
}
