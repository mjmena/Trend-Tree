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
  // a bare manual curl gets fresh ids.
  return {
    trend_id: trend_id.trim(),
    tier: TIER,
    chain_id: typeof b.chain_id === "string" && b.chain_id ? b.chain_id : `ecomm-chain-${randomUUID()}`,
    agent_session_id:
      typeof b.agent_session_id === "string" && b.agent_session_id
        ? b.agent_session_id
        : `ecomm-sess-${randomUUID()}`,
    received_at: new Date().toISOString(),
  };
}
