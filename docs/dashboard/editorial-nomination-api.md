<!-- Title: Trend Tree Editorial Nomination API -->
<!-- Parent: ATLAS Dashboard -->

**Audience:** The engineer connecting the ATLAS nomination form to Trend Tree. ATLAS calls these routes from its backend.

**Status:** The outcome/readback and preview extension is **live as of 2026-11-17**. See the [production release record](../runbooks/editorial-nomination-outcomes-2026-11-17.md) for the serving revision and verification. Submission waits up to one minute; longer processing returns `pending` and completes through readback. ATLAS dev still needs its preview-only credential installed by its operator.

**Source of truth:** [the outcome contract](../prd/editorial-nomination-outcomes.md), [service routes](../../services/editorial-ingest/editorial_ingest/app.py), [response snapshot](../../services/editorial-ingest/editorial_ingest/outcomes.py), and [URL validation](../../services/editorial-ingest/editorial_ingest/urls.py). The [workflow guide](editorial-nomination-workflow.md) explains the product behavior. **Last updated:** 2026-11-17.

## What submission means

A strategist or editor supplies a brief and one to ten URLs. Trend Tree checks the URLs, accepts the nomination durably, and uses Cloud Tasks to evaluate and apply it. It waits up to one minute for the committed result: a new trend, evidence added to an existing trend, a retired trend revived, or an explicit processing failure. If work is still running, it returns `pending` and ATLAS polls the status URL.

The judgment does not reject a valid nomination for its subject matter. Processing can still fail. A successful result confirms the nomination's promotion or merge; naming, full enrichment, signal-link tasks and the dashboard refresh happen later. Do not wait for a dashboard row to determine whether the nomination completed.

## Routes and authentication

Base URL: `https://trend-tree-editorial-ingest-tu6gxkvema-uk.a.run.app`

| Route | Credential | Response timing |
| --- | --- | --- |
| `POST /nominations` | Production `X-Api-Key` | Up to 60 seconds from request start; completed outcome or pending fallback. Allow transport headroom in the ATLAS backend timeout, for example 90 seconds. |
| `GET /nominations/{nomination_id}` | Production `X-Api-Key` | Current snapshot, without waiting for evaluation to finish. |
| `POST /nominations/preview` | Preview-only or production `X-Api-Key` | Synchronous provisional evaluation; no production submission or polling receipt. |

POST bodies use `Content-Type: application/json` and have a 64 KB cap. Keys stay in the ATLAS backend, never in a browser.

**One minute bounds the initial response, not completion.** In the 2026-11-17 production check with the queue running normally, POST returned `202 pending` in 60.149 seconds and readback observed `merged` at 96.852 seconds from submission. This is one measured run, not a completion guarantee. Keep polling after `202`; allow transport headroom beyond the 60-second server budget.

- The production key is stored as `atlas-trend-tree-api-key` in Secret Manager, project `mcc-crm-automations`. ATLAS prod (`insights-agent-504817`) holds its copy.
- ATLAS dev (`insights-agent-dev-504817`) receives only the separate `atlas-trend-tree-preview-api-key`. It cannot submit production work or read nomination history. Both production routes reject it with `401`.
- Missing or wrong keys return `401` before the body is processed. Empty keys are not accepted; configured production and preview keys must differ.
- Each capability accepts one configured key at a time. Coordinate rotation with the corresponding ATLAS caller and verify the serving revision before disabling the old secret version.
- `/tasks/nominations` is an internal worker route authenticated with the queue service account's Google OIDC token; neither API key grants worker access.

## Request body

Submit and preview accept exactly these four fields. Any other field makes the body malformed (`400`).

| Field | Type | Rule | Meaning |
| --- | --- | --- | --- |
| `nomination_id` | string | `^[A-Za-z0-9_-]{1,64}$` | ATLAS generates it once per form submission and keeps it across retries. A UUID fits. |
| `brief` | string | Not blank; no separate cap within the body limit | The person's description, in their own words. The pipeline writes the topic and name. |
| `urls` | array of strings | 1 to 10 items | Pages that show the trend. The URL check below decides which survive. |
| `nominated_by` | string | Not blank | A name or email supplied by ATLAS. Trend Tree stores ATLAS's claim without independently verifying it. |

Types are strict: for example, a numeric `brief` or a string in place of the `urls` array returns `400`. There is no `rationale`, `category` or `dry_run` field.

Illustrative request:

```json
{
  "nomination_id": "atlas-nomination-example",
  "brief": "Diners outside Japan are discovering yoshoku, the Japanese take on Western comfort food, including omurice and hayashi rice.",
  "urls": ["https://www.broadsheet.com.au/brisbane/food-and-drink/article/best-omurice"],
  "nominated_by": "ATLAS user"
}
```

## Production response snapshot

Both production routes use this shape:

```json
{
  "nomination_id": "atlas-nomination-example",
  "status": "pending",
  "trend_id": null,
  "dropped_urls": [],
  "status_url": "/nominations/atlas-nomination-example",
  "error": null
}
```

| Field | Meaning |
| --- | --- |
| `nomination_id` | The accepted submission's identity. |
| `status` | One of the five outcomes below. |
| `trend_id` | Committed target when known, otherwise `null`. A target alone does not prove success. |
| `dropped_urls` | Original acceptance-time `[{"url": "...", "reason": "..."}]`, preserved on replay and readback. |
| `status_url` | Relative path on this service. Resolve it against the configured base URL and send the production key. |
| `error` | `null`, or a safe `{"code": "...", "message": "..."}`. Raw exceptions and model replies are not exposed. |

| `status` | Terminal? | Meaning and ATLAS action |
| --- | --- | --- |
| `pending` | No | Accepted, evaluating, applying or retrying. Keep polling. A safe retry message and a known partial target may already be present. |
| `created` | Yes | A new trend and its candidate promotion committed. Use `trend_id`; enrichment and dashboard visibility follow later. |
| `merged` | Yes | The candidate merged into the existing target. No new trend was created. The target keeps its origin. |
| `resurgent` | Yes | The merge and this nomination's revival event committed. The target keeps its origin. |
| `failed` | Yes | Processing ended without completing the promised operation. Show the safe error and retain the nomination ID for support. |

Terminal outcomes describe this nomination permanently. A later lifecycle change does not turn a past `resurgent` result into `merged` or change a past `created` result.

A failure can follow partial writes. For example, `processing_incomplete` may retain `trend_id` with the message `The trend was updated, but nomination processing did not finish.` Do not translate `failed`, `503`, a timeout or a missing target into “nothing was written.” A `pending` error such as `processing_retry` is still retrying, not terminal failure.

## HTTP responses

| HTTP status | When | ATLAS action |
| --- | --- | --- |
| `200` on POST | Snapshot is terminal: `created`, `merged`, `resurgent` or `failed` | Inspect `status`; HTTP success alone does not mean the nomination succeeded. |
| `202` on POST | Accepted snapshot is still `pending` at the response deadline | Follow `status_url`; honor `Retry-After: 5` (seconds). |
| `200` on GET | Any known snapshot, including `pending` | Pending includes `Retry-After: 5`. Keep polling while pending; stop at a terminal status. |
| `400` | Malformed JSON, invalid/missing/extra fields, wrong types, invalid ID, invalid URL count or body over 64 KB | Fix the request. The `detail` is a developer diagnostic. |
| `401` | Missing, wrong or insufficient `X-Api-Key` | Fix the credential. Do not retry unchanged. |
| `404` on GET | No receipt for that ID | No outcome is available. After an uncertain submit, retry POST with the same ID and original body. |
| `422` | All submitted URLs were dropped | `{"urls": [{"url": "...", "reason": "..."}]}`; show the reasons so the person can correct them. |
| `429` | Cloud Run capacity response; the service is capped at two instances | Back off and retain the same ID. The response may not be JSON. |
| `503` | Temporary receipt, queue or readback infrastructure failure | The safe `detail` is not a terminal nomination result. Back off; read status or retry the original POST with the same ID. Work may already exist. |

`GET` does not run topic evaluation or create a new nomination. It reads the receipt, may repair an accepted receipt's interrupted queue handoff, and may reconcile the outcome when Cloud Tasks confirms that no task remains and no active worker can still write. Queue errors are not proof of failure. A known active worker remains pending. Readback has a five-second operation budget: if the receipt was read but reconciliation is slow or unavailable, it returns that snapshot; if no receipt could be read, it returns `503`.

## ATLAS submission and retry flow

1. Generate and retain one ID and the original request before the first POST.
2. For `200`, inspect the terminal status and show its outcome plus any dropped URLs.
3. For `202`, keep the ID and status URL, then GET after the indicated delay. Poll about every five seconds while pending, backing off on transient failures.
4. For a lost response, timeout or `503`, first GET by the same ID. If no receipt is available, retry POST with the same ID and original request. Never mint a new ID just because a response was lost.
5. A terminal `failed` snapshot needs support or an intentional new submission; replaying the ID does not reset it. A new ID represents a new nomination and can add evidence again.

**First content wins.** A valid repeat of an accepted ID reads the stored input and result, including its original dropped URLs. It does not recheck replacement URLs or overwrite the brief, person or URL list. Repeating a pending POST can repair an interrupted receipt-to-queue handoff. Receipt ownership and committed candidate recovery protect retries and overlapping worker deliveries; Cloud Tasks naming alone is not the durable record.

Receipt history starts with this extension. Completed nominations from the original service are not backfilled, so an old ID can return `404`. ATLAS should retain its own IDs; this extension does not add a list-history route or callback.

## The URL check

Each URL is fetched with an 8-second timeout; checks run in parallel. Only provably dead or malformed URLs drop. Slow, blocked or paywalled pages survive as unverified evidence.

| Result | Condition |
| --- | --- |
| Kept | HTTP 2xx or 3xx |
| Kept, unverified | HTTP 401, 403, 405, 406, 429 or 451; any 5xx; network error or timeout |
| Dropped, `malformed` | Not `http`/`https`, missing host, over 2,048 characters after normalization, or a Google Vertex grounding redirect. Not fetched. |
| Dropped, `url_too_long_or_redirect` | Redirect target is too long or unusable |
| Dropped, `dead_<status>` | HTTP 400, 404, 408, 410 or 414, or another unlisted 4xx; for example `dead_404` |

Recognized tracking parameters (`utm_source`, `fbclid`, `gclid` and others), `www.` and a trailing slash are normalized away. Duplicate canonical URLs within one request collapse to one kept URL without a dropped entry.

Example all-dropped response (`422`):

```json
{"urls": [
  {"url": "https://example.com/definitely-404", "reason": "dead_404"},
  {"url": "not a url", "reason": "malformed"}
]}
```

## Development preview

`POST /nominations/preview` checks the same request and URLs, generates a topic and runs the same sameness evaluation. With either permitted key, a successful evaluation returns `200`:

```json
{
  "nomination_id": "dev-preview-example",
  "provisional": true,
  "status": "would_merge",
  "trend_id": "existing-trend-id",
  "dropped_urls": []
}
```

Preview statuses are `would_create`, `would_merge` and `would_revive`. `would_create` has `trend_id: null`; the other two identify an existing target. `would_revive` means that target was retired when evaluation read it. The result is provisional: production can reach a different decision later, and no new ID is reserved.

Preview writes no receipt, provenance, signal, candidate, promotion or revival, enqueues no task and dispatches no enrichment. It has no status URL and no stored result to poll. Repeating a preview ID evaluates again. URL fetches, Snowflake reads and model calls still incur normal provider charges.

Preview preserves `400`/`401`/`422` validation behavior. Evaluation or provider failure returns `503` with `{"detail":"preview unavailable; retry"}`. It exercises authentication, URL validation and evaluation, but cannot prove production acceptance, retries, commits or the production `200`/`202` contract. See the [service README](../../services/editorial-ingest/README.md) for credential provisioning.

## Outcome, origin and later visibility

A new trend starts with origin `EDITORIAL`. A nomination that merges into an existing trend leaves that trend's origin unchanged, including when it revives a retired trend. `HEAT_INDEX`, `PREDICTION_SCORE` and the opportunity score use the same rules for either origin.

The supplied URLs become supporting evidence through normal signal ingestion and linking. A newly ingested URL uses source `editorial`; an existing signal keeps its original source and metadata. `METADATA.nomination_id` records first ingestion only. The [nomination provenance view](data-contract.md#v_editorial_nomination_signals) records each accepted nomination-to-canonical-URL association without duplicating or retagging signals. An association does not prove that the signal or link has finished processing.

Full enrichment and naming follow a new promotion; the success receipt is committed before enrichment dispatch. `DT_TREND_DASHBOARD` has a 15-minute target refresh lag, so ATLAS visibility follows the outcome and can take longer when downstream processing is delayed. Use the returned ID for the nomination result, and the [data contract](data-contract.md) for the eventual dashboard row. ATLAS owns the form, polling display, notifications and any “your nominations” view.
