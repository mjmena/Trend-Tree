# Editorial ingest development preview

**Awaiting deployment.** The preview route and credential described here are part
of [CRMA-1725](https://mcclatchy.atlassian.net/browse/CRMA-1725), within the
[nomination outcomes contract](../../docs/prd/editorial-nomination-outcomes.md).
Local tests do not establish that the live service supports this route.

`POST /nominations/preview` accepts the same four fields as a nomination:
`nomination_id`, `brief`, `urls`, and `nominated_by`. Send `X-Api-Key` using the
preview-only key or the production key. The request runs URL checking, topic
generation, and the production sameness judgment synchronously, then returns
HTTP 200, for example:

```json
{
  "nomination_id": "dev-preview-123",
  "provisional": true,
  "status": "would_merge",
  "trend_id": "existing-trend-id",
  "dropped_urls": []
}
```

The statuses are `would_create`, `would_merge`, and `would_revive`. `would_create`
has `trend_id: null`; the other statuses identify the existing matching trend.
`would_revive` means that target was retired when the neighbor pool was read.
Production evaluation can reach a different result later. No new trend ID is
reserved, and no result is stored for polling or idempotent replay. Each preview
request evaluates again, even if it repeats a nomination ID.

The route has no queue, receipt, provenance, signal, candidate, promotion,
revival, or enrichment-dispatch operation. URL fetches, Snowflake reads and
Cortex/model calls still run against the configured providers and incur normal
charges. Preview does not exercise production acceptance, Cloud Tasks retries,
commits, or the production 200/202 readback contract.

Authentication failures return 401 before input is processed. Malformed or
oversized bodies return 400. If every URL is rejected, 422 returns the same
`urls` list of rejection reasons as production submission. Network errors keep
URLs as unverified, following the existing URL policy. Evaluation/provider
failures return 503 with `{"detail":"preview unavailable; retry"}`; raw provider
exceptions and model replies are kept out of public responses.

## Preview credential and release

`EDITORIAL_PREVIEW_API_KEY` is a separate capability accepted only by preview.
It cannot submit production nominations, invoke the task handler, or read private
nomination history. `EDITORIAL_API_KEY` retains production privileges and can
also preview. The service refuses to start with an empty/whitespace production
key, an explicitly configured empty/whitespace preview key, or equal keys.
Omitting the preview setting permits an upgrade with production-key preview
only; it does not authorize an empty request key.

Before deploying the `deploy.env` secret binding:

1. Create `atlas-trend-tree-preview-api-key` in the service's GCP project,
   `mcc-crm-automations`, with an independently generated secret value. Do not
   reuse `atlas-trend-tree-api-key` or commit either value.
2. Grant the runtime service account,
   `crm-runtime@mcc-crm-automations.iam.gserviceaccount.com`,
   `roles/secretmanager.secretAccessor` on the new secret.
3. Arrange the preview credential in ATLAS dev (`insights-agent-dev-504817`)
   through its normal secret-management process. Its dev caller should hold
   only the preview credential. Coordinate rotations with ATLAS dev: add a new
   version, deploy its binding, switch the dev caller, then disable the old
   version after checking the serving revision.
4. Deploy the reviewed integration revision using the Cloud Run release process.
   `services/deploy.sh editorial-ingest --no-promote` binds the preview secret
   from `deploy.env` and leaves the existing service's traffic in place;
   this repository's merge does not deploy the Cloud Run service. The script's
   health probe alone does not verify preview isolation.
5. Before promoting traffic, verify the candidate revision accepts both keys on
   preview, returns provisional results with existing IDs only, and rejects the
   preview key on production submit and private readback. Use a dedicated
   nomination ID and verify no receipt, task, signal, candidate, promotion,
   revival or dispatch was produced. Record timing and the tested revision.
   A production submission smoke test is a separate, explicitly authorized
   write; preview cannot prove the production outcome contract.

Implementation work does not create secrets, grant IAM, deploy revisions, or
run live model calls. Carry these release steps into the integration PR.

## Local verification

From `services/editorial-ingest`, run `python -m pytest tests/test_preview_route.py`.
The HTTP route tests use recording Snowflake, task queue and dispatch dependencies,
plus fake URL/model providers, so they make no external requests. Run the full
service suite before release to cover interaction with production routes.
