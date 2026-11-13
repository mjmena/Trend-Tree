// Tests for the CRMA-1670 Cloud Run error prefetch.
// Run: node --test audit-agent-p_xMC9nm3/fetch_pipedream_errors/
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { fetchCloudRunErrors, buildFilter, signJwt } from "./cloud_run_errors.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const saKey = { client_email: "audit@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
const REG = [{ service: "trend-tree-editorial-ingest", name: "editorial-ingest" }];
const NOW = Date.parse("2026-11-13T13:00:00Z");

function fakeFetch(entriesResp) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("oauth2")) return { ok: true, data: { access_token: "tok" } };
    return entriesResp;
  };
  return { fn, calls };
}

test("JWT is RS256-signed by the service-account key and scoped to logging.read", () => {
  const [h, c, sig] = signJwt(saKey, NOW).split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, sig, "base64url"));
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(claims.iss, saKey.client_email);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/logging.read");
});

test("filter scopes to the service and window, and catches unstructured ERROR lines", () => {
  const f = buildFilter("trend-tree-editorial-ingest", NOW - 24 * 3600_000);
  assert.match(f, /resource.labels.service_name="trend-tree-editorial-ingest"/);
  assert.match(f, /timestamp>="2026-11-12T13:00:00.000Z"/);
  assert.match(f, /severity>=ERROR OR textPayload=~"\^\(ERROR\|CRITICAL\):"/);
});

test("entries become a pool row shaped like a Pipedream workflow", async () => {
  const { fn, calls } = fakeFetch({ ok: true, data: { entries: [
    { insertId: "a", timestamp: "2026-11-13T12:00:00Z", severity: "ERROR", httpRequest: { requestMethod: "POST", requestUrl: "https://x/nominations", status: 500 } },
    { insertId: "b", timestamp: "2026-11-13T11:00:00Z", textPayload: "ERROR:editorial_ingest.handler:judge failed" },
  ] } });
  const [row] = await fetchCloudRunErrors(REG, { project: "mcc-crm-automations", saKeyJson: JSON.stringify(saKey), fetchJson: fn, nowMs: NOW, limit: 10 });
  assert.equal(row.workflow_id, "cloud_run:trend-tree-editorial-ingest");
  assert.equal(row.workflow_name, "editorial-ingest");
  assert.equal(row.errors_24h_count, 2);
  assert.equal(row.fetch_error, null);
  assert.equal(row.errors_24h[0].code, "HTTP_500");
  assert.equal(row.errors_24h[0].msg, "POST https://x/nominations -> 500");
  assert.equal(row.errors_24h[1].msg, "ERROR:editorial_ingest.handler:judge failed");
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body.resourceNames, ["projects/mcc-crm-automations"]);
  assert.equal(calls[1].init.headers.Authorization, "Bearer tok");
});

test("zero entries is a clean zero-error row", async () => {
  const { fn } = fakeFetch({ ok: true, data: {} });
  const [row] = await fetchCloudRunErrors(REG, { project: "p", saKeyJson: JSON.stringify(saKey), fetchJson: fn, nowMs: NOW, limit: 10 });
  assert.equal(row.errors_24h_count, 0);
  assert.equal(row.fetch_error, null);
});

test("missing key, bad token, or a Logging error surface as fetch_error, never a throw", async () => {
  const opts = { project: "p", fetchJson: async () => ({ ok: false, status: 403, error: "denied" }), nowMs: NOW, limit: 10 };
  assert.match((await fetchCloudRunErrors(REG, { ...opts, saKeyJson: undefined }))[0].fetch_error, /GCP_AUDIT_SA_KEY env var missing/);
  assert.match((await fetchCloudRunErrors(REG, { ...opts, saKeyJson: "{" }))[0].fetch_error, /not JSON/);
  assert.match((await fetchCloudRunErrors(REG, { ...opts, saKeyJson: JSON.stringify(saKey) }))[0].fetch_error, /token exchange failed: denied/);
  const { fn } = fakeFetch({ ok: false, status: 403, error: "PERMISSION_DENIED" });
  const [row] = await fetchCloudRunErrors(REG, { ...opts, saKeyJson: JSON.stringify(saKey), fetchJson: fn });
  assert.equal(row.fetch_error, "PERMISSION_DENIED");
  assert.equal(row.errors_24h_count, 0);
});
