# Exploding Topics API — reference

Full surface of the Exploding Topics (Semrush) REST API, extracted from the
live OpenAPI spec (`api.explodingtopics.com/docs/`, spec v1.7.1) and verified
against live calls on 2026-06-29. ET is **purchased and live** for this
workspace.

For *why* we use it and the design that consumes it, see
[`docs/adr/0003-trend-descriptor-machine-facing-canonical-artifact.md`](adr/0003-trend-descriptor-machine-facing-canonical-artifact.md)
and the `exploding-topics-feasibility.md` (superseded) doc.

## Basics

- **Base URL:** `https://api.explodingtopics.com/api/v1`
- **Auth:** `api_key` as a **query parameter** (scheme `ApiKeyAuth`, `in: query`,
  name `api_key`). Not a header. The key rides in the URL — **do not log full
  request URLs.** Key lives in `.envrc.local` as `EXPLODING_TOPICS_API_KEY`.
- **Rate limit:** 60 requests/minute. No stated monthly request cap on the owned
  tier.
- **Support:** `app-center@semrush.com`.

### ⚠️ Cloudflare User-Agent gotcha

ET is behind Cloudflare and **silently returns `403 Forbidden` to clients with a
default library User-Agent** (e.g. `Python-urllib/*`). Set a browser-style UA.
`curl` works out of the box. Same class of gotcha as GDELT (memory
`gdelt_user_agent_required`).

```python
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
```

## Endpoints

All are `GET`. Six total.

### `GET /topic` — single topic (strict lookup)

Retrieve one specific ET topic by keyword or path.

| param | in | type | notes |
|---|---|---|---|
| `path` | query | string | Find by URL path, i.e. `explodingtopics.com/topic/${path}`. |
| `keyword` | query | string | Find by the topic's keyword. |
| `response_timeframe` | query | string enum (see below) | default `all`. Time window of `search_history` to return. |

- **Hit:** `{"result": { …Topic… }}` (a single object).
- **Miss:** `{"message": "No topic found."}` — returned with **HTTP 200**, not 404.

### `GET /database-search` — topic search (fuzzy)

Find topics by keyword, i.e. `explodingtopics.com/database-search?keyword=${kw}`.

| param | in | type | notes |
|---|---|---|---|
| `keyword` | query | string | Search term. |
| `response_timeframe` | query | string enum | default `all`. |

- **Hit:** `{"result": [ …Topic, … ], "total": N}` — a **ranked array** of candidate topics.
- **Miss:** `{"message": "No meta trends found."}` (wording is ET's, not a typo on our side). Detect a hit via `total > 0` (or non-empty `result`).
- This is the endpoint to use for *"does ET know this concept?"* matching — it's
  fuzzier than `/topic`. (Empirically, querying it with an **atomic
  consumer-vernacular** term matches ~67% of our trends vs. ~6% for compound
  topic/name strings — see ADR-0003.)

### `GET /topics` — list/browse topics

| param | in | type | default | notes |
|---|---|---|---|---|
| `type` | query | enum `regular`/`exploding`/`peaked`/`all` | `all` | Classification filter. |
| `brand` | query | enum `true`/`false`/`all` | `false` | Branded vs non-branded. |
| `categories` | query | array | `all` | Filter by category. |
| `sort` | query | enum `growth`/`keyword`/`gradient`/`exponent`/`absolute_volume`/`date_added` | `growth` | Ordering. |
| `order` | query | enum `asc`/`desc` | `asc` | |
| `timeframe` | query | enum `3`/`6`/`12`/`24`/`60`/`120`/`180` (months) | `60` | Window used for sort/filter. |
| `offset` | query | integer | `0` | Pagination skip. |
| `limit` | query | integer | `10` | Page size, **max 100**. |
| `response_timeframe` | query | string enum | `all` | `search_history` window per item. |

### `GET /startups` — list startups

Same filter family as `/topics`: `type`, `categories`, `sort`, `order`,
`timeframe`, `offset`, `limit`, `response_timeframe` (same enums/defaults).

### `GET /products` — list products

Same filter family as `/topics`. Product items additionally populate
`tiktokInsights` (see schema).

### `GET /meta-trends` — all meta-trends

Returns ET's meta-trends (broad groupings of related topics).

### `response_timeframe` enum (all lookup endpoints)

`all`, `next_12_months_forecast`, `next_12_months_forecast_monthly`,
`last_3_months`, `last_6_months`, `last_12_months`, `last_2_years`,
`last_5_years`, `last_15_years`.

## Response schema — `Topic`

The object returned in `result` (single for `/topic`, array elements for
`/database-search` and `/topics`).

| field | type | meaning |
|---|---|---|
| `path` | string | URL path; the topic's **unique identifier**. |
| `keyword` | string | The topic's keyword. |
| `description` | string | Short description. |
| `date_added` | number | Unix epoch when first detected. |
| `categories` | array | Category classes. |
| `absolute_volume` | integer | Absolute searches for the keyword **last month**. |
| `classifications` | object | Trend class **per timeframe**: keys `3`,`6`,`12`,`24`,`60`,`120`,`180`,`forecast_12` → string verdict (`regular` / `exploding` / `peaked`). |
| `search_history` | object | Search volume **time series**. Keys: `last_15_years`, `last_5_years`, `last_2_years`, `last_12_months`, `last_6_months`, `last_3_months`, `next_12_months_forecast`, `next_12_months_forecast_monthly`. Each is an array of `{ value: integer, time: string }` (time is a **Unix epoch string**, ~weekly cadence). |
| `growth` | object | % increase in global searches over each timeframe. |
| `regressions` | object | Regression fits over the series. |
| `tiktokInsights` | object | **Products only** — engagement summaries, growth, time-series activity, top hashtags, preview videos. |
| `channelBreakdown` | object | The topic's activity per social channel. |
| `related_trends` | array | Related/"meta" topics. |
| `key_indicators` | object | Summary indicators. |

The schema also defines `Product`, `Startup`, and `Meta Trend` objects (returned
by their respective list endpoints); they share the growth/`search_history`
shape.

## Quick examples

```sh
# strict single lookup
curl -sS -G 'https://api.explodingtopics.com/api/v1/topic' \
  --data-urlencode "api_key=$EXPLODING_TOPICS_API_KEY" \
  --data-urlencode 'keyword=magnesium glycinate' \
  --data-urlencode 'response_timeframe=last_12_months' | jq

# fuzzy search (hit = .total > 0)
curl -sS -G 'https://api.explodingtopics.com/api/v1/database-search' \
  --data-urlencode "api_key=$EXPLODING_TOPICS_API_KEY" \
  --data-urlencode 'keyword=snail mucin' | jq '{total, top: .result[0].keyword}'
```

## How we consume it

- **`descriptor.query`** (ADR-0003) is the canonical key we look ET up by — a
  single **atomic, consumer-vernacular** term. Compound trend topics/names match
  poorly; atomic terms match well.
- **First consumer = validation oracle** (issue #56): compare ET's
  `classifications` / `growth` to our `PREDICTION_SCORE` / `LIFECYCLE_STATUS` to
  measure whether the trends we flag as emerging are independently growing.
- **ET-as-promotion-source** (querying ET to gate candidate promotion) is a
  separate, higher-leverage use, deferred to its own design. The validation
  oracle de-risks it: confirm ET's growth signal tracks reality for our trends
  before wiring it into the promotion decision.
