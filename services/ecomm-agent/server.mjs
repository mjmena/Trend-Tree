// Ecomm Agent — Cloud Run HTTP service (CRMA-776, epic CRMA-772
// "Trend-to-product sourcing"). The walking skeleton: source one trend
// end-to-end (retrieval -> Gemini 3.7 Flash selector -> PROC_SOURCING_APPLY
// ledger rows) from a single authenticated HTTP call.
//
// Two routes, and deliberately only two:
//   GET  /health   -> 200. What the CRMA-440 dark-deploy smoke test hits at
//                     the `candidate` tag URL before traffic is promoted.
//                     NOT `/healthz`: Google's edge swallows that exact path
//                     on *.run.app and returns its own 404 before Cloud Run
//                     sees the request, so a healthy service fails its own
//                     smoke test. Diagnosed on CRMA-762; `/health`, `/livez`
//                     and `/readyz` all route through normally.
//   POST /source   -> {"trend_id": "<uuid>"} in, a synchronous JSON receipt
//                     out. The SAME endpoint the CRMA-778 Cloud Scheduler
//                     poller will call per trend (Google OIDC token) and a
//                     human curls for a manual fire or repair. Cloud Run
//                     answers synchronously, so the Pipedream hi_/dc_ trigger
//                     split — and its write-once custom_response toggle — are
//                     gone; there is one endpoint with one caller contract.
//
// AUTHENTICATION IS THE PLATFORM'S, NOT THIS PROCESS'S. The service is
// deployed --no-allow-unauthenticated per CRMA-441: Cloud Run's front end
// validates the caller's Google OIDC token against the run.invoker binding and
// rejects anonymous requests before the container ever sees them. This code
// therefore does no token parsing of its own — adding a second, weaker check
// here would be the thing most likely to drift out of sync with the real
// grant. It follows that the process must never be exposed directly to the
// internet outside Cloud Run.
//
// HTTP status mapping (a choice the platform switch forces — Pipedream's
// $.respond() always returned 200):
//   200 — the run reached a recorded terminal state, INCLUDING outcome
//         'failed' and a freshness 'declined'. A failed header is a real,
//         self-healing outcome (the next poll tick retries it), not a
//         transport error, and a retry storm from the caller would only
//         multiply headers.
//   400 — malformed body (missing / non-UUID trend_id). The caller must fix
//         the request; retrying it unchanged cannot help.
//   500 — the run could not be recorded at all (no header reached
//         FCT_TREND_SOURCING_LEDGER, or the process threw outside the run's
//         own error handling). This is the only genuinely retryable failure.

import http from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { fetchContext } from "./fetch_context.mjs";
import { BadRequestError, normalizeEvent } from "./normalize_event.mjs";
import { runSourcing } from "./run_sourcing.mjs";

// A /source body is a single uuid; anything approaching this cap is not a
// request this service should be reading into memory.
const MAX_BODY_BYTES = 64 * 1024;

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
        // Reject, then DRAIN the rest — `req.destroy()` here would tear the
        // socket down before the handler could write the 400 this file
        // promises, and the caller would see a connection reset, which is
        // indistinguishable from a transport failure and therefore something
        // a Cloud Scheduler caller would retry forever.
        reject(new BadRequestError(`request body exceeds ${MAX_BODY_BYTES} bytes`));
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

function parseBody(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new BadRequestError(`request body is not valid JSON: ${e.message}`);
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

// The run receipt as the caller sees it. Ported from the removed Pipedream
// step ecomm-agent/respond/entry.mjs: every path (declined, completed, failed)
// must render, and outcome==='failed' on a decision==='completed' run (e.g. no
// sourceable vector) must surface its real error_message rather than hide
// behind an uninformative "0 picked".
export function buildReceipt(evt, r) {
  const result = r || {};
  return {
    trend_id: evt.trend_id,
    tier: evt.tier,
    chain_id: evt.chain_id,
    agent_session_id: evt.agent_session_id,
    decision: result.decision || "unknown",
    sourcing_run_id: result.sourcing_run_id || null,
    outcome: result.outcome || (result.decision === "declined" ? "not_sourced" : null),
    selector_note: result.selector_note ?? null,
    error_message: result.error_message ?? result.reason ?? null,
    candidate_count: Array.isArray(result.candidates) ? result.candidates.length : null,
    selected_count: Array.isArray(result.candidates) ? result.candidates.filter((c) => c.selected).length : null,
    candidates: result.candidates ?? [],
    warnings: result.warnings ?? [],
    selector_telemetry: result.selector_telemetry ?? null,
    catalog_age_days: result.catalog_age_days ?? null,
    cost_row_error: result.cost_row_error ?? null,
  };
}

export function summarize(receipt, result) {
  if (result.decision === "declined") return `declined: ${receipt.error_message}`;
  if (result.decision === "failed" || result.outcome === "failed") return `failed: ${receipt.error_message}`;
  return `${receipt.outcome}: ${receipt.selected_count ?? 0} picked`;
}

export async function handleSource({ config, body }) {
  const evt = normalizeEvent(body);
  console.log(`ecomm-agent: trend=${evt.trend_id} tier=${evt.tier} chain=${evt.chain_id} session=${evt.agent_session_id}`);

  const ctx = await fetchContext({ connOpts: config.snowflake, trend_id: evt.trend_id, tier: evt.tier });
  const result = await runSourcing({ connOpts: config.snowflake, apiKey: config.geminiApiKey, evt, ctx });

  const receipt = buildReceipt(evt, result);
  console.log(`ecomm-agent: trend=${evt.trend_id} ${summarize(receipt, result)}`);

  // A run that never got a header into the ledger is the one case the caller
  // can usefully retry.
  const status = result.decision === "failed" && !result.header_recorded ? 500 : 200;
  return { status, receipt };
}

export function createServer(config) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (route === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { error: "method not allowed", allow: "GET" });
          return;
        }
        sendJson(res, 200, { status: "ok", service: "trend-tree-ecomm-agent" });
        return;
      }

      if (route === "/source") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed", allow: "POST" });
          return;
        }
        const body = parseBody(await readBody(req));
        const { status, receipt } = await handleSource({ config, body });
        sendJson(res, status, receipt);
        return;
      }

      sendJson(res, 404, { error: `no such route: ${req.method} ${route}`, routes: ["GET /health", "POST /source"] });
    } catch (err) {
      if (err instanceof BadRequestError) {
        console.log(`ecomm-agent: bad request — ${err.message}`);
        sendJson(res, 400, { error: err.message });
        return;
      }
      // runSourcing() handles its own failures and still returns a receipt, so
      // reaching here means something outside the run broke (Snowflake
      // unreachable before the header, a bug in this file).
      console.error(`ecomm-agent: unhandled error on ${req.method} ${route}: ${err.stack || err.message}`);
      sendJson(res, 500, { error: String(err.message || err) });
    }
  });
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Die loudly at boot rather than serving a revision that 500s on its first
    // real call — Cloud Run's health probe then fails the deploy.
    console.error(`ecomm-agent: ${err.message}`);
    process.exit(1);
  }

  const server = createServer(config);

  // Keep idle connections alive longer than the Google front end's own idle
  // window, so the front end never reuses a connection this process is closing
  // at the same instant — that race surfaces to callers as an intermittent
  // 5xx that no application log explains. headersTimeout must exceed
  // keepAliveTimeout or Node closes the socket while headers are still
  // arriving. (Node's requestTimeout is NOT a hazard for a long sourcing run:
  // its timer is cleared once the request body is fully received.)
  server.keepAliveTimeout = 620_000;
  server.headersTimeout = 630_000;

  server.listen(config.port, () => {
    console.log(`ecomm-agent listening on :${config.port}`);
  });

  // Cloud Run sends SIGTERM before reclaiming an instance; finish in-flight
  // sourcing runs instead of severing them mid-ledger-write.
  process.on("SIGTERM", () => {
    console.log("ecomm-agent: SIGTERM received, draining");
    server.close(() => process.exit(0));
  });
}

// Only start listening when run as the entrypoint, so the module can be
// imported by a test or a local harness without binding a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
