# Coverage-signal availability for the prediction feedback loop

**Ticket:** CRMA-484 (child of wayfinder map CRMA-481)
**Date:** 2026-08-08
**Status:** COMPLETE

**Question:** Does a usable "we published on this trend" signal exist today, and what would it take to attribute published McClatchy coverage back to a trend? Feeds the strategy decision on the prediction feedback loop: once the newsroom ships coverage on a trend, its prediction state should demote ("act now" → "watch") without circular reporting.

## TL;DR

**Partially — the signal does not exist as a ready-made "covered" flag, but every raw ingredient needed to build it already sits in this pipeline's own Snowflake account, fresh to the minute.**

- `MCC_RAW.STORY_DATA.CUE_CONTENT_PROCESSED` is a near-real-time CMS publish feed: 1.92M stories, 33 publication hostnames, event stream current to minutes ago, with headline, keyword arrays, IAB taxonomy, sections, and full plaintext.
- `MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS` holds a 768-dim embedding per story, also current through today.
- Attribution by embedding similarity was **empirically demonstrated in one SQL query**: embedding a trend's name+keywords with Cortex `snowflake-arctic-embed-m-v1.5` and cosine-matching against story vectors surfaced exactly the right stories (top sims 0.86/0.84/0.84 for "Longevity Weighted Vests" → three rucking-vest stories) with clean falloff below ~0.70.
- Verbatim trend-name matching is a dead end (0 hits across 281,530 stories in 90 days — trend names are coined phrases).
- The public content API is **not needed** for this signal, and is currently unreachable from this network anyway (edge tarpits the request after TLS; no keyword search exists on it regardless — it is section-feed + story-id only).
- What's missing is not data but **policy**: what counts as "coverage" (commerce/affiliate vs newsroom, wire vs staff, which markets), the similarity threshold, and the demotion rule.

---

## A. McClatchy content API

### Surface (from primary docs/config)

Per the `mcclatchy-endpoints` skill reference (`~/.claude/skills/mcclatchy-endpoints/reference/endpoints.md` §2), `webapi-public/v2` exposes exactly two read shapes, both behind the `X-Forwarded-For: 35.245.79.74` Akamai gate:

1. `GET https://www.<paper>.com/webapi-public/v2/content/{storyId}` — one story by id.
2. `GET https://www.<paper>.com/webapi-public/v2/sections/{sectionId}/content` — section feed; `{ items: [ { id, url, asset_type, state, title, publication, … } ] }`.

**No keyword/topic search endpoint is documented anywhere**, and no local consumer uses one:

- `mcc-newsletters/SPARQ/orchestrator-p_ZJCrNKG/reserve_tag_slots/webapiEnrich.mjs` — story-id enrichment only.
- `braze-templates/docs/topic-feeds/reference/affinity_feeds_by_market.items.json` — the Braze topic→feed catalog: 30 markets × ~60 topic columns, each a **hardcoded section-id feed URL** (e.g. Charlotte `CRIME_COURTS` → `https://www.charlotteobserver.com/webapi-public/v2/sections/8055/content?limit=20`). The existence of this hand-curated catalog is itself evidence the API cannot search — topic targeting is done by mapping topics to section ids per market by hand.

So even when reachable, the API answers "recent stories in section X", never "stories matching keyword K". Matching trend names against it would mean polling every section feed of every market and doing the text match yourself — strictly worse than the Snowflake path in section B.

### Live testing (2026-08-08): unreachable from this network

All attempts carried the documented XFF header:

```sh
curl -s --http1.1 -H "X-Forwarded-For: 35.245.79.74" \
  "https://www.charlotteobserver.com/webapi-public/v2/sections/8055/content?limit=2"
# TLS handshake completes, request fully sent, then 0 bytes until timeout
# (HTTP 000, curl exit 28)
```

- Same on `www.miamiherald.com`, `www.kansascity.com`, `www.idahostatesman.com`; with/without XFF; HTTP/1.1 and HTTP/2; curl and browser-like UA/headers; homepage as well as API paths.
- Not a machine/network outage: `www.google.com` → 200; raw TCP to the edge IP succeeds (`nc -z 23.213.186.205 443` → open).
- Verbose curl pins the stall **after** `Request completely sent off` → `0 bytes received`. That's an edge-side tarpit/blackhole — a different signature from the skill's documented 403/conn-reset that the XFF header fixes.

Interpretation: the Akamai behavior changed since the skill was written (silent swallow instead of 403), or this residential IP is tarpitted. **Hit-quality testing of the API against real trend names could not be performed.** Retest from a Pipedream/GCP egress IP if the API is ever actually needed — but per section B, it isn't.

---

## B. Snowflake-side coverage data

All queries via `snow sql -c claude` (role `MARKETING_ENGINEER`, account `AAB58547`), read-only.

### Visible databases

`SHOW DATABASES` → `DATA_SHARE_BRAZE`, `MCC_AMPLITUDE`, `MCC_CLEAN`, `MCC_EMAIL`, `MCC_MARKETING`, `MCC_PRESENTATION`, `MCC_RAW` (+ Snowflake system DBs).

Content/editorial/pageview-shaped schemas found:

| Schema | What it holds |
|---|---|
| **`MCC_RAW.STORY_DATA`** | **The CMS-side publish feed — the core finding.** Tables below. |
| `MCC_RAW.GOOGLE_SEARCH_CONSOLE` | `SEARCH_CONSOLE`, `DATAFORSEO`, `GOOGLE_TRENDING_SEARCHES`, `GSC_PROPERTIES`, `MARKET_MAPPING` — search-demand data per property. |
| `MCC_AMPLITUDE.AMPLITUDE` | `EVENTS_412949` (60.3B rows) — pageview-scale web analytics events. Post-publication *consumption*, not publication itself. |
| `MCC_CLEAN.NAVIGA_INSIGHT`, `MCC_PRESENTATION.NAVIGA` | Subscription/circulation system data. Not coverage. |
| `MCC_RAW.STORY_DATA.OMNITURE_DATA` | Legacy web-usage stats (pageviews/visits per business unit). |

### `MCC_RAW.STORY_DATA` — the published-coverage source

```sql
SHOW TABLES IN SCHEMA MCC_RAW.STORY_DATA;
-- CONTENT_API_RAW_EVENT_DATA, CUE_CONTENT_EVENT_DATA, CUE_CONTENT_PROCESSED,
-- CUE_CONTENT_VECTORS, CUE_SECTION_TRANSLATION, CUE_MARKET_TRANSLATION,
-- HOMEPAGE_MONITORING, OMNITURE_DATA, PUBLISHED_STORIES, PUBLISHED_STORIES_ALL, ...
```

Key tables, sized and freshness-checked:

| Table | Rows | Publish-date range | Notes |
|---|---|---|---|
| `CUE_CONTENT_PROCESSED` | 1,920,038 | 2007-07-13 → 2026-08-10 | CUE CMS event feed. `EVENT_TIME` max was **11:38 today** at query time — near-real-time. 33 distinct hostnames in the last 7 days (full market footprint). |
| `CUE_CONTENT_VECTORS` | 1,073,831 | 2007-07-13 → 2026-08-10 | One embedding per story, current through today. |
| `PUBLISHED_STORIES_ALL` | 113,310,198 | "1028-05-20" → "2078-09-08" | Bulk story index; **date column is dirty** (impossible min/max). Has `HEADLINE`, `CANONICAL_URL`, `SECTION`, `TOPICS`, `CATEGORIES`, `BUSINESS_UNIT`. Usable with care; prefer CUE_CONTENT_PROCESSED. |

`CUE_CONTENT_PROCESSED` columns (the attribution-relevant ones): `CONTENTID`, `HEADLINE`, `KEYWORDS ARRAY`, `CUSTOM_KEYWORDS ARRAY`, `IAB_TAXONOMY ARRAY`, `SECTIONNAMES ARRAY`, `TOPIC`, `PLAINTEXT` (full body text), `PUBLISHEDAT`, `MODIFIEDAT`, `HOSTNAME`, `PATH`, `BYLINE ARRAY`, `CONTENT_TYPE`, `ACCESSCATEGORY`, `SOURCEID`.

`CUE_CONTENT_VECTORS` columns: `CONTENTID`, `PUBLISHED_DATE`, `HEADLINE`, `KEYWORDS ARRAY`, `KEY_WORDS_VECTOR VECTOR(FLOAT, 768)`, `CLUSTER_ID`, `CLUSTER_DESCRIPTION` — someone upstream is already clustering published content.

### Empirical matching tests (real trend names from the live dashboard)

Trend names pulled live: `Dollar-Store Default` (78.0, GROWING, Emerging), `Prestige K-Beauty Retail`, `Targeted Supplement Stacking`, `DIY Parasite Cleanses`, `Polyester Purge`, `GLP-1 Companion Protocols`, `Vintage Pearl Manicures` (High Potential), `Scalp Skinification` (Emerging), `Longevity Weighted Vests`, `Savory-Sweet Fusions`, …

**Test 1 — verbatim name match, last 90 days (281,530 stories):**

| Test | Hits |
|---|---|
| headline ILIKE '%GLP-1 Companion Protocols%' | **0** |
| headline ILIKE '%Scalp Skinification%' | **0** |
| headline ILIKE '%DIY Parasite Cleanses%' | **0** |

Coined trend names never appear verbatim. Confirmed dead end.

**Test 2 — core-term match (headline OR keywords array), last 90 days:**

| Term | Hits |
|---|---|
| GLP-1 | 25 |
| weighted vest | 3 |
| K-beauty | 146 |
| parasite cleanse | 0 |

Real hits exist, but recall/precision swing wildly by term: "K-beauty" is too broad (which of 146 stories is coverage *of the retail trend*?), "parasite cleanse" gets zero despite an active trend.

**Test 3 — embedding similarity (the decisive one):**

```sql
WITH t AS (SELECT SNOWFLAKE.CORTEX.EMBED_TEXT_768('snowflake-arctic-embed-m-v1.5',
  'Longevity Weighted Vests weighted vest rucking fitness') AS v)
SELECT c.PUBLISHED_DATE, LEFT(c.HEADLINE,80), 
       ROUND(VECTOR_COSINE_SIMILARITY(c.KEY_WORDS_VECTOR, t.v),3) AS sim
FROM MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS c, t
WHERE c.PUBLISHED_DATE >= DATEADD(day,-60,CURRENT_DATE)
ORDER BY sim DESC LIMIT 8;
```

| Date | Headline | sim |
|---|---|---|
| 2026-07-02 | 5 best rucking vests on the market in 2026: What customers are saying about weig… | **0.855** |
| 2026-07-02 | Meet the rucking vest lineup winning over beginners and athletes alike, from TRX… | **0.841** |
| 2026-07-02 | Rucking vest designs are growing more varied in 2026… | **0.836** |
| 2026-07-01 | Why rucking is the ideal workout for men over 40… | 0.805 |
| 2026-07-01 | Rucking builds strength and burns calories: Stanford doctors… | 0.756 |
| 2026-07-01 | Does a weighted pack really improve posture while walking?… | 0.724 |
| 2026-07-01 | A 30-day rucking experiment revealed how a weighted pack… | 0.705 |
| 2026-06-12 | Why Your Skin Longevity Routine Should Be Way Simpler… | 0.666 |

Perfect topical hits at the top, clean falloff to off-topic below ~0.70. The high scores also **empirically confirm** `KEY_WORDS_VECTOR` was built with `snowflake-arctic-embed-m-v1.5` (or a compatible 768 model) — cross-model cosine would not produce this separation. Query ran in seconds on `MARKETING_WH`.

**Vector-model note:** the trend pipeline's canonical vectors are `DT_TREND_DASHBOARD.TREND_VECTOR_ARCTIC_EMBED_L_V2_0` = `VECTOR(FLOAT, 1024)` (`EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0')` per repo SQL). Content vectors are 768-dim — **not directly comparable**. The bridge demonstrated above (re-embed the trend's short text with the 768 model at query time) costs pennies; alternatively re-embed story headlines+keywords at 1024. Either way it's one Cortex call, in-warehouse, no new infra.

### Out of reach / not found

- No pre-built trend↔story link, obviously (that's the thing to build).
- No editorial-planning / assignment-desk data (what the newsroom *intends* to cover) — only post-publish facts.
- `STORY_DATA` is another team's schema: readable under `MARKETING_ENGINEER`, but ownership, SLA, and schema-stability guarantees are unknown. Nothing in this repo documents it.

---

## C. Attribution options (strategy-level, no recommendation)

**Option 1 — Exact trend-name match.** Infeasible. 0/3 verbatim hits; trend names are coined editorial phrases ("Polyester Purge", "Scalp Skinification") that newsrooms will essentially never print. Would produce a permanently-silent signal. No missing data — it just doesn't work.

**Option 2 — Keyword-term match (trend keyword set ∩ story HEADLINE/KEYWORDS/CUSTOM_KEYWORDS).** Partially feasible today. Failure modes: (a) needs a curated per-trend keyword list — today only `FCT_TRENDS.GTRENDS_KEYWORD` (a single term chosen for Google Trends polling) exists as a structured keyword; (b) precision collapses on broad terms (146 "K-beauty" stories ≠ 146 pieces of coverage of *Prestige K-Beauty Retail*); (c) recall collapses on niche phrasing ("parasite cleanse": 0 hits, active trend); (d) commerce/affiliate content matches as readily as newsroom journalism. Missing: the keyword lists themselves and a precision/recall calibration set.

**Option 3 — Embedding similarity (trend text vs `CUE_CONTENT_VECTORS`).** Empirically proven above, zero new infrastructure: Cortex embed of trend name+keywords, cosine against the story-vector table, threshold ~0.75–0.80 on this one probe. Failure modes: (a) threshold needs calibration across many trends, not one — near-miss adjacent topics (skin-longevity at 0.666) sit close under the cutoff; (b) `KEY_WORDS_VECTOR` embeds *keywords*, not full text — stories with sparse/poor CMS keywords will under-match; (c) syndication: the three rucking-vest stories are near-duplicates run across markets — one editorial decision, not three, so dedupe by cluster/similarity before counting "coverage volume"; (d) commerce/affiliate content ("5 best rucking vests" is a shopping story) scores highest of all — if "the newsroom covered it" is meant editorially, an `ACCESSCATEGORY`/section/content-type filter policy is required; (e) model mismatch with the pipeline's canonical 1024-dim trend vectors means maintaining a second, 768-dim trend embedding (trivial but a real moving part). Missing: threshold calibration, the coverage-definition policy, dedupe rule.

**Option 4 — Manual analyst tagging.** Always feasible; trend volume (~dozens active) and coverage volume are small enough for a human to link stories to trends in the dashboard. Failure modes: latency (defeats a same-day demote), silent decay when nobody tags, and it doesn't scale with markets. Could serve as the *calibration/override layer* for options 2–3 rather than the primary mechanism. Missing: a place to record the tag (the link table again) and a UI/ritual.

**Circularity note (for the grilling session, not a design):** discovery signals come from external sources (Bluesky, Amazon, Pinterest, Google Trends, LLM discovery) — none read McClatchy publications — so consuming own-coverage *only* to demote prediction state does not feed the discovery loop. The risk would appear only if coverage-derived rows ever landed in `FCT_SIGNALS` / the clustering corpus; whatever gets built should be structurally separate (its own ledger/link table), mirroring how `FCT_TREND_PREDICTION_LEDGER` is isolated from `HEAT_INDEX`.

---

## Gaps

1. **Content API unreachable from this network** (edge tarpit after TLS, even with the XFF header) — retest from a Pipedream/GCP egress IP if ever needed; not needed for this signal.
2. **No keyword search on the content API** — section feeds and story-ids only.
3. **No structured per-trend keyword set** beyond the single `GTRENDS_KEYWORD`; option 2 (and better prompts for option 3) would want one.
4. **`PUBLISHED_STORIES_ALL` has corrupt dates** (min 1028, max 2078); use `CUE_CONTENT_PROCESSED` as the publish-fact source.
5. **`CUE_CONTENT_VECTORS` embeds keywords, not body text** — under-matches keyword-poor stories; `PLAINTEXT` exists in `CUE_CONTENT_PROCESSED` if fuller embeddings are ever wanted.
6. **Vector model mismatch** — content 768 (`arctic-embed-m-v1.5`, empirically confirmed) vs trend 1024 (`arctic-embed-l-v2.0`); one side must be (re-)embedded.
7. **`MCC_RAW.STORY_DATA` ownership/SLA unknown** — readable today under `MARKETING_ENGINEER`, but no documented contract; confirm with the owning team before building a production dependency.
8. **"Coverage" is undefined** — commerce/affiliate vs newsroom, wire vs staff, one market vs many, story vs cluster of syndicated duplicates. This is the actual open decision, and it's a human one.
