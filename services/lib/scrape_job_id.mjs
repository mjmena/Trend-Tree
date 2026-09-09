// The scrape-gateway's job id (CRMA-986, decided shape in CRMA-985).
//
// CRMA-985 specifies an always-async contract — `POST /pull` returns a
// `job_id`, `GET /pull/{job_id}` returns the records — AND a stateless
// service running at MIN_INSTANCES=0 / MAX_INSTANCES=3. Those two facts
// together rule out the obvious implementation: an in-process map from job id
// to job state. The GET is not guaranteed to reach the instance that served
// the POST, and at MIN_INSTANCES=0 the instance that served the POST may not
// exist by the time the GET arrives.
//
// So the gateway holds no job state at all. The vendor already does — Bright
// Data's trigger returns a `snapshot_id` it will happily report on later — and
// the job id is simply that vendor handle plus the two things the GET needs in
// order to normalize what comes back:
//
//   <vendor>.<platform>.<vendor handle>      e.g. bd.tiktok.s_m1a2b3c4
//
// The (vendor, platform) pair is exactly the normalizer key CRMA-985 defined,
// so a GET can pick the right normalizer without consulting any stored record
// of the POST. A job id is therefore a capability, not a lookup key: it names
// everything needed to service it.
//
// This is why the id is parsed rather than trusted. It arrives in a URL path
// from a caller, and it selects a code path and is interpolated into a vendor
// API request — so both segments are checked against a strict allowlist
// pattern, and the vendor handle against a conservative character class.

// Deliberately short and opaque. These are wire values that appear in job ids
// held by callers across a deploy, so they are renamed only with a migration.
export const VENDORS = new Set(["bd", "apify"]);

// CRMA-982 / CRMA-983 / CRMA-984's three platforms. A fourth arrives with its
// route decision, not before.
export const PLATFORMS = new Set(["tiktok", "reddit", "kickstarter"]);

// Vendor snapshot handles are vendor-controlled, so this is a conservative
// shape check rather than a format claim: no dots (the field separator), no
// slashes or whitespace (path and header injection), bounded length.
const HANDLE = /^[A-Za-z0-9_-]{1,128}$/;

export class InvalidJobIdError extends Error {}

/**
 * Build the opaque job id a `POST /pull` hands back.
 *
 * @param {{vendor: string, platform: string, handle: string}} parts
 * @returns {string}
 */
export function formatJobId({ vendor, platform, handle }) {
  assertParts(vendor, platform, handle);
  return `${vendor}.${platform}.${handle}`;
}

/**
 * Recover the routing facts from a job id supplied by a caller.
 *
 * @param {unknown} jobId
 * @returns {{vendor: string, platform: string, handle: string}}
 * @throws {InvalidJobIdError} on anything this service did not issue.
 */
export function parseJobId(jobId) {
  if (typeof jobId !== "string" || jobId === "") {
    throw new InvalidJobIdError("job_id must be a non-empty string");
  }
  // Split on the FIRST two dots only. The handle is vendor-controlled and the
  // check below forbids dots in it today, but splitting greedily here would
  // turn a future vendor handle containing a dot into a confusing "unknown
  // vendor" error instead of a clear handle error.
  const first = jobId.indexOf(".");
  const second = jobId.indexOf(".", first + 1);
  if (first === -1 || second === -1) {
    throw new InvalidJobIdError("job_id must have the form <vendor>.<platform>.<handle>");
  }
  const vendor = jobId.slice(0, first);
  const platform = jobId.slice(first + 1, second);
  const handle = jobId.slice(second + 1);
  assertParts(vendor, platform, handle);
  return { vendor, platform, handle };
}

function assertParts(vendor, platform, handle) {
  if (!VENDORS.has(vendor)) {
    throw new InvalidJobIdError(`unknown vendor: ${JSON.stringify(vendor)}`);
  }
  if (!PLATFORMS.has(platform)) {
    throw new InvalidJobIdError(`unknown platform: ${JSON.stringify(platform)}`);
  }
  if (typeof handle !== "string" || !HANDLE.test(handle)) {
    throw new InvalidJobIdError(`malformed vendor handle: ${JSON.stringify(handle)}`);
  }
}
