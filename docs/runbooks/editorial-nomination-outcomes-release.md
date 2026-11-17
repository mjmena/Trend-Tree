# Editorial nomination outcomes release

**Status:** Deployed 2026-11-17; see the [release record](editorial-nomination-outcomes-2026-11-17.md).
This runbook releases the
[CRMA-1719 outcome contract](../prd/editorial-nomination-outcomes.md).
Approval to merge the integration PR is separate from authorization to execute
this release, change production Snowflake objects, provision credentials or
submit live nominations. None of those actions follows automatically from merge.

The Cloud Run service is `trend-tree-editorial-ingest` in
`mcc-crm-automations` / `us-east4`. Its Cloud Tasks queue has the same name in
the same project and region. Configuration is in
[`deploy.env`](../../services/editorial-ingest/deploy.env); operational details
and local checks are in the [service README](../../services/editorial-ingest/README.md).

## 1. Prepare the release and stop old workers

Record the reviewed commit, current serving revision and traffic allocation,
current queue settings, and the deployed definition of
`MCC_RAW.MARKETING_DEV.PROC_PROMOTION_APPLY`. The promotion procedure is
shared with discovery, so include its non-editorial behavior in the release
checks. Preserve the old definition for investigation or a coordinated rollback.
Record its grants too; replacement uses `COPY GRANTS` to preserve existing callers.

Agree a short nomination maintenance window with ATLAS. Stop new production
submissions there and let in-flight acceptance requests finish. Pause the
editorial Cloud Tasks queue, preserving its existing tasks; do not purge it.
Then drain all handlers running on the old revision before changing SQL.
Confirm through request logs and Snowflake query/session activity that those
workers have finished. The task dispatch deadline and service request timeout
are 900 seconds, but elapsed time alone is not proof that all domain writes
have stopped.

Keep the queue paused and ATLAS admission closed through the candidate checks.
When ATLAS cannot be gated directly, temporarily remove the service's public
invoker binding and retain only authorized operator/runtime access. Verify an
unauthenticated request is rejected, and restore the recorded policy after cutover.
The candidate may be built at zero traffic before this window to shorten it;
do not invoke its database-dependent routes until the migrations are applied.
The new worker can adopt a queued legacy payload into a receipt and recover a
committed candidate. It cannot reconstruct dropped URLs absent from that old
payload. Completed historical nominations are not backfilled into receipts.

## 2. Apply state, guarded promotion and the presentation view

Apply the committed SQL in this order with the queue still paused and old
workers drained:

1. [`sql/stg_editorial_nominations.sql`](../../sql/stg_editorial_nominations.sql)
   creates the private receipt, singleton mutex and
   `MCC_RAW.MARKETING_DEV.PROC_EDITORIAL_NOMINATION`. Confirm exactly one mutex
   row with `LOCK_ID = 1`; standard-table primary keys do not enforce exclusivity.
2. [`sql/proc_promotion_apply.sql`](../../sql/proc_promotion_apply.sql) replaces
   the shared promotion procedure with the version that takes the same mutex
   and checks editorial ownership before domain writes. The existing
   `FCT_PROMOTION_LEDGER.NOMINATION` column remains a prerequisite. Do not run
   the new worker against an older, unguarded promotion procedure.
3. [`sql/v_editorial_nomination_signals.sql`](../../sql/v_editorial_nomination_signals.sql)
   creates the secure receipt projection. Its owner is `MARKETING_ENGINEER` and
   `TH_APIROLE` receives `SELECT` on the view. Verify the owner can read the
   private receipt and ATLAS can read the projection without receipt access.
   `ACCEPTED_AT` is the receipt's `TIMESTAMP_LTZ` creation time.

The state and promotion procedures form one ownership boundary. Do not deploy
only one of them, reinitialize the mutex while workers are active, or treat a
promotion-audit row alone as proof of a committed outcome. Candidate fields
establish promotion completion; a `resurgent` result also requires the
nomination's lifecycle event.

Run native Snowflake checks of the reviewed procedures, using the agreed
isolated fixtures and separate sessions: first-content acceptance under
contention, exclusive claims, rollback through nested `MERGE_EXTERNAL_SIGNALS`,
expired-owner rejection at promotion, candidate recovery without a successful
audit row, one revival event, and success preserved against late failure.
Check repeated URLs retain original signal metadata while receiving separate
nomination associations. The implementation's native fixture results are
pre-release evidence; record the SQL definitions exercised and verify the
deployed objects match them. They do not verify Cloud Tasks or a serving revision.

## 3. Provision credentials and dark-deploy Cloud Run

Before deploying the bindings in `deploy.env`:

- Create a distinct `atlas-trend-tree-preview-api-key` in Secret Manager and
  grant `crm-runtime@mcc-crm-automations.iam.gserviceaccount.com`
  `roles/secretmanager.secretAccessor` on it. Production and preview keys must
  be nonempty and different. Deliver only the preview credential to ATLAS dev
  through its normal secret-management process.
- Retain the runtime's existing Cloud Tasks enqueue and service-account `actAs`
  permissions. Grant task lookup (`cloudtasks.tasks.get`, provided by
  `roles/cloudtasks.viewer`) for the editorial queue so readback can distinguish
  a confirmed missing task from an unavailable queue. Check with the runtime
  identity; an operator's broader permissions do not establish runtime access.
- Confirm the runtime Snowflake role can use the receipt and guarded promotion
  procedures and their underlying objects. The private request, ownership and
  saved evaluation remain outside ATLAS's grants.

From the reviewed commit, use the explicit no-promotion option:

```sh
services/deploy.sh editorial-ingest --no-promote
```

Record the resulting revision and candidate URL. The existing service already
exists, so this creates a candidate with no normal traffic. The deploy script's
health probe only proves `/health` responds; it does not prove the outcome
contract. Confirm the old serving revision still has its prior traffic and the
queue remains paused.

`EDITORIAL_SERVICE_URL` stays the base service URL. It is both the Cloud Tasks
target host and the worker's expected OIDC audience. A POST to the candidate
accept route still queues a task addressed to the base URL; it does not pin that
task to the candidate revision.

## 4. Verify the candidate while the queue is paused

Use the candidate host for every HTTP check, including the relative
`status_url`. Save the revision, nomination IDs, HTTP statuses, response bodies,
timings and supporting row queries with the release record. Never include keys
or bearer tokens in that record.

First check authentication and validation: wrong keys return `401`, malformed
bodies `400`, and an all-dropped URL set `422`. Check that the preview key gets
`401` on production POST and GET, including an existing receipt ID. With both
permitted preview credentials, verify provisional results and existing target
IDs only; a would-create preview has no new ID. Compare the dedicated preview
ID and URLs against receipt, task, signal, candidate, promotion and lifecycle
records and dispatch logs to verify that preview produced no writes or work.

Live production-route checks require separately authorized nominations because
they write to production. Choose a real merge case and, where authorized, new
trend and retired-target cases before the window. Keep all resulting IDs as
audit evidence.

The safe paused-queue sequence is:

1. Submit the approved request to the **candidate** accept route. Since the
   queue is paused, expect a durable `pending` response with HTTP `202` within
   the 60-second request budget and `Retry-After: 5`. Confirm one receipt and
   the named task exist. GET returns HTTP `200`, `pending` and `Retry-After: 5`.
2. Execute that task against the **candidate** `/tasks/nominations` route
   directly. Use the exact normalized `REQUEST` stored in its receipt as the
   worker payload and an authorized Google OIDC token for the configured queue
   service account, with the **base service URL** as audience. An API key is
   insufficient. Keep the actual queue paused so no delivery reaches the old
   revision. This invokes the real handler with the accepted input; it is not a
   preview or a simulated outcome.
   If the operator cannot mint that runtime token, create a separate smoke task
   with the same stored payload, candidate URL and base-URL OIDC audience, then
   explicitly run only that task while the queue remains paused. Cloud Tasks
   signs the request. The original task stays queued for the cutover replay.
3. Read the candidate status route and replay the original POST. Both return
   the same terminal snapshot with HTTP `200`; dropped URLs stay unchanged.
   Confirm candidate `PROMOTED_AT` and target fields, corresponding domain rows,
   one candidate per nomination, and no duplicate trend. A merge preserves the
   target's origin; a revival has exactly one event for that nomination. A new
   trend's receipt must become successful before enrichment dispatch completes.
4. Measure the actual evaluation/application time, separately from the forced
   paused-queue wait. To check a first POST completing inside its wait window,
   start an approved submission and invoke its candidate handler after receipt
   acceptance while that POST is still open. Expect `200` if the commit is
   observed within the remaining minute, otherwise `202` followed by readback.
   Record the measured result; do not present a replay's fast `200` as evaluation
   latency. A timeout is never a terminal verdict.

Direct handler execution leaves the queued task in place. After release, its
normal delivery should read the terminal receipt and exit without repeating
domain writes. Keep that task for the post-cutover idempotency check. Do not
resume the queue before traffic moves simply to make a candidate smoke pass:
its configured target would still reach the old revision.

Reconciliation, overlap and failure injection also have local/native coverage.
Record any cases not exercised against the candidate as verification limits;
preview and `/health` cannot substitute for production-route checks. Supporting
links, full enrichment, naming and the dashboard refresh are later checks,
separate from the committed nomination outcome.

## 5. Move traffic, resume the queue and reopen ATLAS

After the checks pass, move service traffic to the verified candidate revision
using the explicit revision name recorded from deployment. Set
`EDITORIAL_CANDIDATE_REVISION` to that verified name first:

```sh
gcloud run services update-traffic trend-tree-editorial-ingest \
  --project mcc-crm-automations --region us-east4 \
  --to-revisions "${EDITORIAL_CANDIDATE_REVISION:?set the verified revision}=100"
```

Confirm the base URL now serves that revision and no old revision receives
ordinary requests. Only then resume the editorial queue. Watch its backlog and
handler results, including the already-completed smoke task: its delivery must
leave the same snapshot, candidate, trend and revival counts intact. Check
pending receipts progress and runtime task lookup works. Reopen ATLAS admission
after these checks, retaining the same ID on caller retries.

Verify later evidence links and dashboard visibility separately. Once the
serving revision, schema, grants and integration behavior are verified, record
the release and update the API/data documentation's deployment labels. The
workflow document remains a draft until Martin sends or publishes it; release
does not satisfy [CRMA-1721's human delivery requirement](https://mcclatchy.atlassian.net/browse/CRMA-1721).

## If the release must stop

Keep ATLAS admission closed and the queue paused while investigating a failed
candidate check. If failure occurs after cutover, pause new submissions and
queue delivery, then drain active handlers before changing either revision or
SQL. Preserve receipts, candidates and committed targets for reconciliation.

Moving traffic to an older revision alone is not a complete rollback: the
original worker does not honor the durable receipt boundary. It must not consume
accepted new-format work. Review the queued payloads and receipt state and
choose a compatible service/SQL repair before resuming. Do not drop receipts or
undo committed trends just to restore the old HTTP response. Keep the shared
promotion procedure's discovery callers accounted for in any SQL rollback.
