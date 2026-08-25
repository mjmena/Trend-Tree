// Ecomm Agent — request normalization (CRMA-776, epic CRMA-772).
//
// Ported from the removed Pipedream step ecomm-agent/normalize_event/entry.mjs.
// Coerces the POST /source body into a normalized run event. Validates
// trend_id is present and UUID-shaped: it is used as a bind-parameter value
// across three Snowflake queries, so a malformed value should fail fast and
// legibly (HTTP 400) rather than surface as a confusing empty pool or an
// opaque driver error deep in the run.
//
// TIER is a code constant ('shopify' — the only tier this build implements,
// see docs/prd/trend-to-product-sourcing.md) threaded through the run event
// rather than re-derived downstream, so there is exactly one place a future
// second tier's entrypoint would change.

import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TIER = "shopify";

// FCT_TREND_SOURCING_LEDGER.AGENT_SESSION_ID and STG_AGENT_RUN_COSTS'
// AGENT_SESSION_ID / CHAIN_ID are all VARCHAR(64). An over-long caller-
// supplied id would make PROC_SOURCING_APPLY('open')'s INSERT fail with
// "String ... too long" AND the cost-row insert fail the same way, so the run
// would leave no trace in either table. Reject it here for the same reason
// trend_id is validated here: a bind value that cannot land should fail fast
// and legibly, not deep inside the write path. Truncating instead would risk
// silently collapsing two callers' correlation ids into one.
const ID_MAX_CHARS = 64;

export class BadRequestError extends Error {}

export function normalizeEvent(body) {
  const b = body && typeof body === "object" ? body : {};
  const trend_id = b.trend_id;

  if (!trend_id || typeof trend_id !== "string" || !UUID_RE.test(trend_id.trim())) {
    throw new BadRequestError(
      `ecomm-agent requires {"trend_id": "<uuid>"} in the request body; got ${JSON.stringify(b).slice(0, 200)}`,
    );
  }

  // chain_id / agent_session_id are accepted from the caller so a future
  // Cloud Scheduler poller (CRMA-778) can correlate a whole tick's runs;
  // a bare manual curl gets fresh ids (47 chars — comfortably inside the cap).
  const chain_id = callerId(b.chain_id, "chain_id") ?? `ecomm-chain-${randomUUID()}`;
  const agent_session_id = callerId(b.agent_session_id, "agent_session_id") ?? `ecomm-sess-${randomUUID()}`;

  return {
    trend_id: trend_id.trim(),
    tier: TIER,
    chain_id,
    agent_session_id,
    received_at: new Date().toISOString(),
  };
}

// Returns the caller's id, or null to mean "generate one". Throws on a value
// that is present but cannot land in its VARCHAR(64) column.
function callerId(raw, field) {
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.length > ID_MAX_CHARS) {
    throw new BadRequestError(
      `${field} is ${raw.length} characters; the ledger column holds at most ${ID_MAX_CHARS}`,
    );
  }
  return raw;
}
