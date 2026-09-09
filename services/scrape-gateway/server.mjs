// trend-tree-scrape-gateway — Cloud Run HTTP service (CRMA-986, decided shape
// in CRMA-985, map CRMA-977).
//
// A thin normalizing proxy in front of one commercial scraping vendor. It owns
// "what the vendor said, in our words". It does NOT own "what that means as a
// signal" — that is the ingester's job, and CRMA-1006's charter.
//
// Three routes:
//   GET  /health          -> 200. What the CRMA-440 dark-deploy smoke test
//                            hits at the `candidate` tag URL before traffic is
//                            promoted. NOT `/healthz`: Google's edge swallows
//                            that exact path on *.run.app and returns its own
//                            404 before Cloud Run sees the request, so a
//                            healthy revision fails its own smoke test
//                            (diagnosed on CRMA-762).
//   POST /pull            -> {"source", "params"} in, 202 {"job_id"} out.
//   GET  /pull/{job_id}   -> the normalized records, or still-running.
//
// WHY ALWAYS ASYNC. Bright Data's dataset collections run as vendor-side jobs
// that routinely outlast any sane request timeout, and the sync alternative
// caps at ~1 minute and degrades to a 202 the caller must poll anyway. One
// contract with no timeout to fight serves a Pipedream caller and a future
// Cloud Run ingester identically.
//
// WHY THE SERVICE IS STATELESS. It runs at MIN_INSTANCES=0 / MAX_INSTANCES=3,
// so a GET is not guaranteed to reach the instance that served its POST, and
// that instance may not exist by then. Nothing is stored: the job id encodes
// everything the GET needs. See services/lib/scrape_job_id.mjs.
//
// WHAT IT DELIBERATELY DOES NOT DO (CRMA-985, all four re-litigated and
// declined):
//   * No dedupe. That lives in the STG_EXTERNAL_SIGNALS MERGE on SIGNAL_ID.
//   * No diffing against previous pulls. Same reason.
//   * No Snowflake writes. It is a proxy, not an ingester.
//   * No quota enforcement. The spend cap sits at the vendor, where it is
//     authoritative and cannot be bypassed by a caller that skips the gateway.
//
// AUTHENTICATION IS THE PLATFORM'S. Deployed --no-allow-unauthenticated per
// CRMA-441: Cloud Run validates the caller's Google OIDC token against the
// run.invoker binding and rejects anonymous requests before the container sees
// them. This process does no token parsing of its own — a second, weaker check
// here is the thing most likely to drift out of sync with the real grant. It
// follows that the process must never be exposed outside Cloud Run.

import http from "node:http";
import { pathToFileURL } from "node:url";

import { InvalidJobIdError, formatJobId, parseJobId } from "../lib/scrape_job_id.mjs";
import { normalizeRecords } from "../lib/scrape_normalize.mjs";
import {
  InvalidRequestError,
  buildRequest,
  urlFromUnlockerHandle,
} from "../lib/scrape_requests.mjs";
import { normalizeTikTokBrightData } from "../lib/normalize/tiktok_brightdata.mjs";
import { normalizeRedditBrightData } from "../lib/normalize/reddit_brightdata.mjs";
import { normalizeKickstarterBrightData } from "../lib/normalize/kickstarter_brightdata.mjs";
import {
  BrightDataError,
  downloadSnapshot,
  getProgress,
  triggerCollection,
  unlockerFetch,
} from "./brightdata.mjs";
import { loadConfig } from "./config.mjs";

// The (platform, vendor) normalizer registry CRMA-985 specified. An Apify
// fallback for one platform lands as another entry here, not as an edit to an
// existing normalizer — which is what makes the gate's per-platform fallback
// cheap rather than a rewrite.
const NORMALIZERS = {
  "bd:tiktok": normalizeTikTokBrightData,
  "bd:reddit": normalizeRedditBrightData,
  "bd:kickstarter": normalizeKickstarterBrightData,
};

// A pull body is a source name and a short params object. Anything near this
// cap is not a request this service should read into memory.
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        // Reject, then DRAIN. Destroying the socket here would tear it down
        // before the 400 could be written, and the caller would see a
        // connection reset — indistinguishable from a transport failure, and
        // therefore something a scheduled caller retries forever.
        reject(new HttpError(400, `request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function parseJson(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, `request body is not valid JSON: ${e.message}`);
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * POST /pull — validate, start the vendor's work, hand back a job id.
 *
 * For a dataset source this triggers a real vendor job. For Kickstarter there
 * is no vendor job to trigger, so the validated request is encoded into the
 * job id and the fetch happens on the GET. Validation still happens HERE for
 * both, so a bad request fails immediately rather than at poll time.
 */
export async function handlePull({ config, body, deps = {} }) {
  const req = buildRequest(body);

  if (!config.isEnabled(req.source)) {
    // The kill switch, not an error in the request. This is the lever for the
    // TikTok precedent — a scraped surface that vanishes while the scraper
    // keeps reporting success.
    throw new HttpError(
      403,
      `source ${req.source} is disabled — SOURCES_ENABLED lists ${config.enabledSources.join(", ")}`,
    );
  }

  // A warning is not a rejection: the request is valid and will run. It flags
  // a param combination that returns something other than what the caller
  // almost certainly wants — sort_by=Top with no time window being the one
  // that matters, since it silently returns all-time posts. Dropping these
  // would leave the mistake invisible until someone noticed the same posts
  // arriving on every pull.
  const warnings = req.warnings?.length ? { warnings: req.warnings } : {};
  if (warnings.warnings) {
    for (const w of req.warnings) console.warn(`scrape-gateway: warning source=${req.source}: ${w}`);
  }

  if (req.kind === "unlocker") {
    if (!config.webUnlockerZone) {
      throw new HttpError(503, "kickstarter is enabled but BD_WEB_UNLOCKER_ZONE is not configured");
    }
    return {
      status: 202,
      body: {
        job_id: formatJobId({ vendor: "bd", platform: req.source, handle: req.handle }),
        source: req.source,
        ...warnings,
      },
    };
  }

  const trigger = deps.triggerCollection ?? triggerCollection;
  const snapshotId = await trigger({
    apiKey: config.brightDataApiKey,
    datasetId: config.datasets[req.source],
    discoverBy: req.discoverBy,
    input: req.input,
    limitPerInput: req.limitPerInput,
  });

  return {
    status: 202,
    body: {
      job_id: formatJobId({ vendor: "bd", platform: req.source, handle: snapshotId }),
      source: req.source,
      ...warnings,
    },
  };
}

/**
 * GET /pull/{job_id} — report on the job, and normalize it once it is done.
 *
 * Answers 200 in both the running and the ready case: "not finished yet" is a
 * successful answer to the question asked, and a 4xx/5xx would make a
 * scheduled caller treat ordinary progress as a failure to retry.
 */
export async function handleJob({ config, jobId, deps = {} }) {
  const { vendor, platform, handle } = parseJobId(jobId);

  const map = NORMALIZERS[`${vendor}:${platform}`];
  if (!map) throw new HttpError(400, `no normalizer for (${vendor}, ${platform})`);

  if (platform === "kickstarter") {
    // The deferred fetch. urlFromUnlockerHandle re-validates the handle and
    // rebuilds the URL through the same builder the POST used, so a tampered
    // job id cannot reach Web Unlocker with a URL the gateway would not have
    // built itself.
    const url = urlFromUnlockerHandle(handle);
    const fetchUnlocked = deps.unlockerFetch ?? unlockerFetch;
    const rawBody = await fetchUnlocked({
      apiKey: config.brightDataApiKey,
      zone: config.webUnlockerZone,
      url,
    });

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // The single most likely failure of CRMA-984's route, and worth its own
      // message: `?format=json` may not be a stable Kickstarter surface, and
      // some scrapers read project JSON out of an HTML data attribute instead.
      // HTML coming back here means the ROUTE is wrong, not that Turnstile won.
      throw new HttpError(
        502,
        "kickstarter returned a non-JSON body — ?format=json may not be serving JSON (see CRMA-984)",
      );
    }

    const projects = Array.isArray(payload?.projects) ? payload.projects : [];
    return {
      status: 200,
      body: {
        job_id: jobId,
        source: platform,
        status: "ready",
        total_hits: payload?.total_hits ?? null,
        ...normalizeRecords({ platform, rawRecords: projects, map }),
      },
    };
  }

  const progress = await (deps.getProgress ?? getProgress)({
    apiKey: config.brightDataApiKey,
    snapshotId: handle,
  });

  if (progress.status !== "ready") {
    // `failed` and `canceled` are terminal and reported as such, so a caller
    // polling a dead job stops instead of looping until its own timeout.
    return {
      status: 200,
      body: { job_id: jobId, source: platform, status: progress.status ?? "unknown" },
    };
  }

  const rawRecords = await (deps.downloadSnapshot ?? downloadSnapshot)({
    apiKey: config.brightDataApiKey,
    snapshotId: handle,
  });

  return {
    status: 200,
    body: {
      job_id: jobId,
      source: platform,
      status: "ready",
      ...normalizeRecords({ platform, rawRecords, map }),
    },
  };
}

export function createServer(config, deps = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (route === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { error: "method not allowed", allow: "GET" });
          return;
        }
        sendJson(res, 200, {
          status: "ok",
          service: "trend-tree-scrape-gateway",
          sources: config.enabledSources,
        });
        return;
      }

      if (route === "/pull") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed", allow: "POST" });
          return;
        }
        const body = parseJson(await readBody(req));
        const out = await handlePull({ config, body, deps });
        console.log(`scrape-gateway: pull source=${out.body.source} job=${out.body.job_id}`);
        sendJson(res, out.status, out.body);
        return;
      }

      const jobMatch = /^\/pull\/(.+)$/.exec(route);
      if (jobMatch) {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method not allowed", allow: "GET" });
          return;
        }
        const out = await handleJob({ config, jobId: decodeURIComponent(jobMatch[1]), deps });
        const { status, records, rejected } = out.body;
        console.log(
          `scrape-gateway: job=${out.body.job_id} status=${status}` +
            (records ? ` records=${records.length} rejected=${rejected}` : ""),
        );
        sendJson(res, out.status, out.body);
        return;
      }

      sendJson(res, 404, { error: "not found", routes: ["/health", "POST /pull", "GET /pull/{job_id}"] });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      // A malformed request and a malformed job id are both the caller's to
      // fix; retrying either unchanged cannot help.
      if (err instanceof InvalidRequestError || err instanceof InvalidJobIdError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      // A vendor failure is upstream, not ours. 502 says so, and says the
      // request itself was fine — which is what tells a caller to retry rather
      // than to change what it sent.
      if (err instanceof BrightDataError) {
        console.error(`scrape-gateway: vendor error: ${err.message} ${err.body ?? ""}`);
        sendJson(res, err.status === 404 ? 404 : 502, { error: err.message, vendor_status: err.status });
        return;
      }
      console.error(`scrape-gateway: unhandled: ${err?.stack ?? err}`);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}

// Only start listening when run as the entrypoint, so the handlers above stay
// importable by the unit tests without binding a port.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = loadConfig();
  createServer(config).listen(config.port, () => {
    console.log(
      `scrape-gateway: listening on ${config.port}, sources=${config.enabledSources.join(",")}`,
    );
  });
}
