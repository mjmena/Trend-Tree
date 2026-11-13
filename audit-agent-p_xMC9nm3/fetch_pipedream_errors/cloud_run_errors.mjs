// CRMA-1670: prefetch a Cloud Run service's recent errors from Cloud Logging,
// shaped like one fetch_pipedream_errors workflow entry so run_audit_agent's
// pipedream_health block and query_workflow_errors tool need no change.
//
// Auth: a GCP service-account JSON key (roles/logging.viewer on
// mcc-crm-automations) in the GCP_AUDIT_SA_KEY workspace env var, exchanged
// for an access token with a self-signed JWT (node:crypto, no dependency).
//
// "Error" = a request log with severity>=ERROR (5xx) OR a plain stderr line
// starting "ERROR:"/"CRITICAL:". Python's logging.basicConfig and uvicorn
// write unstructured text, which Cloud Run stores with no severity, so a
// severity filter alone misses log.exception() lines.

import { createSign } from "node:crypto";

const LOGGING_SCOPE = "https://www.googleapis.com/auth/logging.read";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENTRIES_URL = "https://logging.googleapis.com/v2/entries:list";

const b64url = (s) => Buffer.from(s).toString("base64url");

export function signJwt(saKey, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: saKey.client_email, scope: LOGGING_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600,
  }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(saKey.private_key, "base64url");
  return `${head}.${claims}.${sig}`;
}

export function buildFilter(service, sinceMs) {
  return [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${service}"`,
    `timestamp>="${new Date(sinceMs).toISOString()}"`,
    `(severity>=ERROR OR textPayload=~"^(ERROR|CRITICAL):")`,
  ].join(" AND ");
}

function toError(e) {
  const ts = Date.parse(e.timestamp);
  const http = e.httpRequest;
  const msg = e.textPayload || e.jsonPayload?.message ||
    (http ? `${http.requestMethod || ""} ${http.requestUrl || ""} -> ${http.status}`.trim() : null);
  return {
    event_id: e.insertId || null,
    ts_ms: Number.isNaN(ts) ? null : ts,
    ts_iso: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
    recent_24h: true,
    cell_id: null,
    code: http?.status ? `HTTP_${http.status}` : (e.severity || null),
    msg: typeof msg === "string" ? msg.slice(0, 400) : null,
  };
}

// fetchJson(url, init) -> { ok, data } | { ok:false, status?, error }.
export async function fetchCloudRunErrors(registry, { project, saKeyJson, fetchJson, nowMs, limit }) {
  const base = (s) => ({ workflow_id: `cloud_run:${s.service}`, workflow_name: s.name, errors_24h_count: 0, errors_24h: [] });
  const fail = (error) => registry.map((s) => ({ ...base(s), fetch_error: error }));

  if (!saKeyJson) return fail("GCP_AUDIT_SA_KEY env var missing — Cloud Run errors not fetched");
  let saKey;
  try { saKey = JSON.parse(saKeyJson); } catch (e) { return fail(`GCP_AUDIT_SA_KEY is not JSON: ${e.message}`); }

  const tok = await fetchJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signJwt(saKey, nowMs),
    }).toString(),
  });
  if (!tok.ok || !tok.data?.access_token) return fail(`token exchange failed: ${tok.error || `status ${tok.status || "?"}`}`);

  const sinceMs = nowMs - 24 * 3600_000;
  return Promise.all(registry.map(async (s) => {
    const r = await fetchJson(ENTRIES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.data.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceNames: [`projects/${project}`],
        filter: buildFilter(s.service, sinceMs),
        orderBy: "timestamp desc",
        pageSize: limit,
      }),
    });
    const errs = r.ok ? (r.data?.entries || []).map(toError) : [];
    return {
      ...base(s),
      errors_24h_count: errs.length,
      errors_24h: errs,
      fetch_error: r.ok ? null : (r.error || `status ${r.status || "?"}`),
    };
  }));
}
