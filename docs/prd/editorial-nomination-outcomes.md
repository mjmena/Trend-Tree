# Editorial nomination outcomes

Implementation of [CRMA-1719](https://mcclatchy.atlassian.net/browse/CRMA-1719),
extending `editorial-trend-ingest-endpoint.md`. On 2026-11-17 Martin requested
implementation and confirmed that one minute is an acceptable evaluation time.
This replaces the map's unquantified instant-verdict requirement. ATLAS owns its
form and display; this change supplies the backend contract.

## Behavior

An authenticated submission waits up to one minute for a committed outcome.
It reports whether the nomination created a trend, added evidence to an existing
trend, revived a retired trend, or failed. Full enrichment, naming and dashboard
refresh are later work and do not delay that result. If processing takes longer,
the response explicitly says it is pending and provides a status URL. A timeout
is never reported as a failed or successful nomination.

`POST /nominations` keeps the existing four request fields and validation rules.
Its response includes `nomination_id`, `status`, `trend_id` (nullable),
`dropped_urls`, `status_url`, and a safe `error` (nullable). Completed results use
HTTP 200. Pending results use HTTP 202 and `Retry-After`. Validation/authentication
retain 400/401/422; temporary infrastructure failure uses 503.

`GET /nominations/{nomination_id}` authenticates with the production key and
returns the same snapshot immediately. Unknown IDs return 404. ATLAS polls this
route after 202 or an uncertain network response. No callback is introduced.

| Status | Meaning |
| --- | --- |
| `pending` | Accepted, evaluating, applying, or retrying; no final result yet. |
| `created` | A new trend and its candidate promotion committed; `trend_id` identifies it. |
| `merged` | The nomination's candidate was committed to an existing trend. |
| `resurgent` | The merge and this nomination's revival event both committed. |
| `failed` | Processing has ended without completing the promised operation. The error is safe to show and never includes raw exception text. |

Record successful outcomes before dispatching enrichment so its synchronous
HTTP timeout cannot hold up evaluation feedback. Repeated reads keep the original
outcome, including revival, even if the trend's lifecycle later changes. A failure
after a partial commit retains the known target and explains incomplete processing;
it must not say that nothing was written.

## Persistence and retry invariants

A durable receipt exists independently of signals and candidates, because topic
evaluation may fail before either exists. Keep the original request, normalized
kept URLs, dropped URLs, timestamps, processing ownership, and result. No automatic
retention deletion is introduced in this change.

The Snowflake receipt is `MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATIONS`.
Its public integration columns are `NOMINATION_ID`, `REQUEST` (VARIANT containing
the worker payload including normalized `urls`), `DROPPED_URLS` (VARIANT),
`STATUS`, `RESULT` (VARIANT including `trend_id`), `CREATED_AT`, and `UPDATED_AT`.
The implementation may add internal ownership/retry fields. ATLAS does not get
direct access to the private request or to staging tables.

- First content wins for an ID. A repeat returns the stored request's result,
  including its dropped URLs, without revalidating new URLs or replacing input.
- Repair an interrupted receipt-to-queue handoff on retry. An enqueue timeout
  does not prove that Cloud Tasks failed to create the task.
- Use Cloud Tasks for background execution and retries. Persist safe attempt
  failures, but do not label a retrying task terminally failed.
- Reconcile a confirmed missing task after its active execution can no longer
  write. A queue outage is unknown, not failure. A crash on the last delivery
  must not leave a nomination falsely successful or permanently pending.
- Prevent overlapping deliveries from creating duplicate candidates or trends.
  Snowflake's ordinary primary-key declarations and `NOT EXISTS` alone are not
  locks. Ownership and stale-worker fencing must cover domain writes, not just
  status updates. Success wins over a late failure update.
- Recover committed candidate state after a crash. The promotion audit ledger
  is not proof of success: it can contain failed attempts and can miss a committed
  result. `PROC_PROMOTION_APPLY` remains the only creator of trends.
- A judgment need not be exposed before application. Do not promise a new trend
  ID until promotion creates it. Preview results are explicitly provisional.

## URL provenance

Keep `METADATA.nomination_id` for first ingestion and preserve existing signals'
source and metadata. A URL can be supplied by more than one nomination. Expose
each accepted nomination-to-canonical-URL association through
`MCC_PRESENTATION.TREND_AGENT.V_EDITORIAL_NOMINATION_SIGNALS`, projected from the
receipt's normalized URLs. Include nomination ID, signal ID, outcome, target
trend ID and acceptance time. This records supplied URLs even before a signal
is promoted into `FCT_SIGNALS`; it is not proof that processing completed.
Do not duplicate signals or retag discovered signals as editorial.

## Development preview

`POST /nominations/preview` accepts the existing nomination fields, checks URLs,
and runs the same topic and sameness evaluation. It returns an explicitly
provisional would-create/would-merge/would-revive result and an existing target
ID when applicable. It never fabricates a new ID or claims a trend was created.

A separate preview-only API key may call only this endpoint. The production key
may also preview. An empty key is never accepted and configured keys must differ.
The preview key cannot submit production work or read private nomination history.
The service enforces the no-write boundary: no queue, receipt, provenance,
signals, candidate, promotion, revival or enrichment dispatch. Evaluation reads
and model calls still incur normal provider charges. No `dry_run` field is needed.

## Verification and release

Use the existing service HTTP-route boundary with injected external dependencies
from the original PRD's testing contract. Verify observable submit/readback and
worker behavior, first-content retries, safe failures, recovery after commit,
overlap protection, one-minute pending fallback, and preview isolation. Tests at
the persistence adapter's public operations must exercise its concurrency and
transaction contract; do not rely solely on SQL-string matching.

The public persistence adapter is `SnowflakeNominationStore` in
`editorial_ingest/outcomes.py`. Its operations are `accept`, `get`, `mark_queued`,
`claim`, `save_plan`, `prepare`, `complete`, `attempt_failed`, and
`reconcile_missing`. `Receipt.snapshot()` exposes only the response contract;
the request, saved evaluation, owner, lease, and queue acknowledgement stay
private. These operations extend the agreed external-dependency test seam:
they verify first-content acceptance, ownership, recovery, and transaction
rollback. They do not prove Cloud Tasks delivery or model/provider behavior.

Each mutation runs in one scoped Snowflake procedure transaction and takes an
UPDATE lock on a preinitialized singleton mutex before reading the receipt.
The shared promotion procedure takes the same lock inside its own transaction
and checks the editorial owner before changing domain tables. A 960-second
lease bounds a delivery; an expired or replaced owner cannot write. Committed
candidate recovery happens under that lock. A retry retains its saved topic
and judgment. `reconcile_missing` must only be called after confirmed queue
absence; an active claim remains pending. Native Snowflake concurrency checks
remain necessary in addition to the local transactional procedure harness.

This follows Snowflake's documented transaction lock behavior; standard-table
PK constraints are not used as uniqueness enforcement. See
[Snowflake transactions](https://docs.snowflake.com/en/sql-reference/transactions).

Update the API contract, data contract and Jason's workflow document from this
behavior. Label the new contract as awaiting deployment until verified live.
The workflow document stays a draft for Martin to publish/send; sending and
Jason's reply are not simulated or marked complete by a code PR.

Changes land in one integration PR to `production`. A human merges it. Cloud Run,
Snowflake migrations, preview secret/IAM and a live smoke check are separate
release steps, documented in the PR/runbook. Do not deploy or write test nominations
to production during implementation. Before release, measure evaluation timing
and verify 200/202 status behavior plus committed rows against the candidate revision.

## Superseded boundaries and task graph

This extension supersedes the original PRD's immediate-202-only response,
no-status-route boundary, and lack of a development execution path. It preserves
evidence purity, first-content idempotency, unchanged trend origin on merge,
and ATLAS ownership of UI and notifications.

- CRMA-1722 implements durable outcomes and worker recovery.
- CRMA-1724 implements nomination-to-URL provenance.
- CRMA-1725 implements isolated development preview.
- CRMA-1723 follows the outcome foundation and implements bounded submission
  waiting, readback and task reconciliation.
- CRMA-1721 follows the response contract and updates the workflow draft;
  its human delivery requirement remains open.

The implementation request authorizes carrying these decision tickets into code.
Record decisions and validation in the PR; do not mark work deployed merely
because tests pass or the PR is ready.
