<!-- Title: Trend Tree Editorial Nomination API -->
<!-- Parent: ATLAS Dashboard -->

**Audience:** The engineer who connects the ATLAS nomination form to Trend Tree. ATLAS calls this endpoint from its backend.

**Purpose:** The complete request and response contract of the endpoint that turns a person's nomination into an editorial trend.

**Source of truth:** the deployed service code in the Trend-Tree repo, `services/editorial-ingest/editorial_ingest/app.py` (the routes and validation) and `urls.py` (the URL check). The design is in `docs/prd/editorial-trend-ingest-endpoint.md`. **Live since:** 2026-10-26. **Last updated:** 2026-10-26.

## What the endpoint does

A strategist or an editor nominates a trend with a short brief and one to ten URLs. ATLAS sends the nomination to Trend Tree. Trend Tree accepts it at once with `202` and does the work in the background, in about one to three minutes:

- If the nomination describes a trend that already exists, its URLs attach to that trend as new evidence. No second trend appears.
- If not, a new trend appears on `DT_TREND_DASHBOARD`. The pipeline names and enriches it like any other trend and marks it `TREND_ORIGIN = 'EDITORIAL'`.

No judgment rejects a valid nomination. A nomination fails only when the request is invalid.

## Endpoint

| | |
| --- | --- |
| Method and URL | `POST https://trend-tree-editorial-ingest-tu6gxkvema-uk.a.run.app/nominations` |
| Content type | `application/json` |
| Auth | Header `X-Api-Key: <key>` |
| Body cap | 64 KB |
| Response time | Usually under 10 seconds. The endpoint checks each URL with an 8-second timeout, in parallel. Set the client timeout to at least 30 seconds. |

## Authentication

- One key exists. Trend Tree stores it in Secret Manager as `atlas-trend-tree-api-key` in project `mcc-crm-automations`.
- Only ATLAS prod (`insights-agent-504817`) holds a copy. Dev ATLAS gets no key, because every nomination writes to production.
- The key must stay in the ATLAS backend. Never send it to a browser.
- The endpoint checks the key before it reads the body. A missing or wrong key always gets `401`.
- To rotate the key, the two teams coordinate a swap: Trend Tree adds a new version, ATLAS switches, and Trend Tree disables the old version. The endpoint accepts one key at a time.

## Request body

Send exactly these four fields. Any other field makes the body malformed (`400`).

| Field | Type | Rule | Meaning |
| --- | --- | --- | --- |
| `nomination_id` | string | Must match `^[A-Za-z0-9_-]{1,64}$` | ATLAS generates it **once per form submission**. It is the idempotency key. A UUID (36 characters) fits. |
| `brief` | string | Not blank. No length cap of its own, inside the 64 KB body cap. | The person's free-text description of the trend, in their own words. It is not a name: the pipeline writes the topic and the name. |
| `urls` | array of strings | 1 to 10 items | Pages that show the trend. `http` and `https` only, at most 2,048 characters each. |
| `nominated_by` | string | Not blank | Who nominated, as ATLAS knows them, for example a name or an email. Trend Tree stores it as ATLAS's claim and does not check it. |

The types are strict. For example, `urls` must be a JSON array of strings, and a number in place of a string makes the body malformed.

Example:

```json
{
  "nomination_id": "crma1660-smoke-yoshoku-1",
  "brief": "Diners outside Japan are discovering yoshoku, the Japanese take on Western comfort food. Omurice, hayashi rice, katsu and shio pan salt-butter rolls are showing up on cafe and bakery menus and in viral omurice and konbini videos.",
  "urls": [
    "https://www.broadsheet.com.au/brisbane/food-and-drink/article/best-omurice",
    "https://forbes.com/sites/claudiaalarcon/2026/10/22/whole-foods-markets-food-and-beverage-trend-predictions-for-2027"
  ],
  "nominated_by": "Martin Mena"
}
```

## Responses

| Status | When | Body | ATLAS action |
| --- | --- | --- | --- |
| `202` | Accepted, or a repeat of an accepted `nomination_id` | `{"nomination_id": "...", "dropped_urls": [{"url", "reason"}]}` | Done. Tell the person the trend appears later. If `dropped_urls` is not empty, show those URLs and their reasons. |
| `400` | Malformed body: invalid JSON, a missing or extra field, a wrong type, a bad `nomination_id`, 0 or more than 10 URLs, or a body over 64 KB | `{"detail": "..."}` | Fix the request. The `detail` text is for the developer, not the person. |
| `401` | Missing or wrong `X-Api-Key` | `{"detail": "missing or wrong X-Api-Key"}` | Fix the key. Do not retry. |
| `422` | Every URL was dropped | `{"urls": [{"url", "reason"}]}` | Show the reasons to the person, so they can fix the URLs and submit again. |
| `429` | Cloud Run is at capacity (the service runs at most 2 instances) | Cloud Run's own response, not JSON | Retry with the **same** `nomination_id`, with backoff. |
| `503` | The endpoint could not queue the work. Nothing was written. | `{"detail": "enqueue failed; retry"}` | Retry with the **same** `nomination_id`, with backoff. |

The endpoint has no status route and no callback. The `202` is the last response ATLAS gets for a nomination.

Example `202`, from the nomination above:

```json
{"nomination_id": "crma1660-smoke-yoshoku-1", "dropped_urls": []}
```

Example `422`:

```json
{"urls": [
  {"url": "https://example.com/definitely-404", "reason": "dead_404"},
  {"url": "not a url", "reason": "malformed"}
]}
```

## The URL check

The endpoint fetches each URL once. It drops a URL only when the URL is provably dead or malformed. A URL that is only blocked or slow is kept.

| Outcome | When | Result |
| --- | --- | --- |
| Kept | The page answers 2xx or 3xx | Kept |
| Kept, unverified | The page answers 401, 403, 405, 406, 429 or 451, any 5xx, or does not answer in 8 seconds | Kept. Paywalled and rate-limited sources still count as evidence. |
| Dropped, `malformed` | Not an `http`/`https` URL, no host, or longer than 2,048 characters. The endpoint does not fetch it. | Dropped |
| Dropped, `url_too_long_or_redirect` | A redirect leads to a URL that is too long or not usable | Dropped |
| Dropped, `dead_<status>` | The page answers 400, 404, 408, 410 or 414, or another 4xx not listed above. Example: `dead_404`. | Dropped |

Two URLs that differ only by tracking parameters (`utm_*`, `fbclid`, `gclid` and similar), `www.`, or a trailing slash are the same URL. The endpoint keeps one and does not report the other.

## Idempotency and retries

- One form submission is one `nomination_id`. Generate it before the first send and reuse it on every retry.
- A repeat of an accepted `nomination_id` gets `202`, and nothing new happens. A network failure followed by a retry therefore never creates two trends.
- **The first content wins.** If ATLAS sends a different brief or different URLs under an accepted `nomination_id`, the endpoint answers `202` and keeps the first content. Use a new `nomination_id` for a new submission.
- Retry only `429`, `503` and network errors. Do not retry `400`, `401` or `422` unchanged.

## What happens after the 202

1. The pipeline writes a topic from the brief and the page titles.
2. It compares the topic with every live trend, including retired ones.
3. It records the URLs as evidence. Each URL becomes a supporting signal of the trend, under the source name `editorial`.
4. It applies one of three outcomes:
   - **No match:** a new trend. Enrichment names it within a few minutes. On `DT_TREND_DASHBOARD` it reads `TREND_ORIGIN = 'EDITORIAL'` and `LIFECYCLE_STATUS = 'NEW'`.
   - **Match:** the URLs attach to the matching trend. That trend keeps its own origin, usually `DISCOVERED`.
   - **Match to a retired trend:** the URLs attach, and the trend returns as `RESURGENT`.

`DT_TREND_DASHBOARD` refreshes about every 15 minutes, so a new trend can take up to about 20 minutes to appear there. An editorial trend is scored like every other trend. `HEAT_INDEX`, `PREDICTION_SCORE` and the opportunity score do not read the origin. See the [Data Contract](data-contract.md) for `TREND_ORIGIN`.

The dashboard has no link from a `nomination_id` to a `TREND_ID`. A "your nominations" view needs that link, and it is not built.

## Not in this endpoint

- No bulk import: one trend per request.
- No `rationale`, `category` or `dry_run` field.
- No status route, no callback, and no test environment. Every accepted nomination writes to production, so test against the contract above with a stub.
