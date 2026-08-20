<!-- map: CRMA-745 -->

# Map: resolve a trend to purchasable products — Shopify first-pass sourcing

## Destination

A locked, handoff-ready **spec** for resolving a trend to purchasable products, handed to
`/to-spec` → `/to-tickets`. Vectors retrieve candidates; a Gemini 3.7 Flash selector picks.
Results append to their own ledger, written by a cron-driven **ecomm agent** that polls for
trends carrying a real enrichment row and no sourcing row. Shopify is the only implemented
tier; the multi-tier contract is specified, not built.

The map ends at the spec. It does not carry execution.

## Notes

- **Origin**: Marcelo's handoff of 2026-07-28, *Shopify Trend → Product Matching*, repo
  `insights-agent`. It asks for two things — move first-pass product querying into the
  enrichment pipeline, and replace substring matching with semantic matching. Several of its
  stated premises do not survive contact with this pipeline; see **Established facts**.
- **Direction of travel**: this pipeline already pulls Amazon product data *in* as trend
  evidence. This map is the opposite direction — a trend resolving *out* to products someone
  can buy. Nothing trend↔product exists today.
- **Skills to consult**: `/grilling` + `/domain-modeling` for the decision tickets,
  `/research` for the research tickets, `/prototype` for the calibration and selector tickets,
  `pipedream-synced-project` for how the dispatcher chain is wired.
- **Watch for collision with `CRMA-726`** (Gemini 3.7 Flash per-lane model allocation across
  the fleet). The selector is a new Flash pin. Coordinate rather than decide it twice.
- **Settled during charting** (no tickets behind these): the destination is a spec, not a
  build; scope is trend→product sourcing with Shopify the only implemented tier; trend-tree
  owns the match and `insights-agent` reads the result; the Decision Page is the only
  consumer surface; retrieval is vectors and selection is an agent; sourcing is its own pass
  with its own ledger, not a field on the enrichment record; selection runs on Gemini 3.7
  Flash in the ecomm agent, not on Cortex inside Snowflake. *The charting-time clause "the
  pass is fired synchronously off promotion and recalled by re-enrichment" was amended at
  CRMA-750 — see Standing constraints.*
- **Vocabulary**: the new step is **sourcing**; the workflow that performs it is the **ecomm
  agent**. `CONTEXT.md` calls the consumer surface the **Decision Page**, not "Decision panel"
  — the earlier spelling survives only in CRMA-749's ticket title.

## Established facts

Measured state of the world. Falsified by re-measurement, never by a decision.

- **The canonical internal embedding space is `snowflake-arctic-embed-l-v2.0`, 1024-dim**, via
  `SNOWFLAKE.CORTEX.EMBED_TEXT_1024`. `FCT_TRENDS.TREND_VECTOR` and
  `FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR` are both `VECTOR(FLOAT, 1024)`, produced through
  the shared `FN_TREND_EMBED_DOC` recipe (`sql/fn_trend_embed_doc.sql:3,32`). Verified
  2026-08-20.
- **A second, isolated 768-dim space exists** — `snowflake-arctic-embed-m-v1.5` via
  `EMBED_TEXT_768` — used by content matching and GSC terms. The two dimensionalities are
  never compared (`sql/fct_trend_content_matches_ledger.sql:20-25`). Verified 2026-08-20.
- **Cosine thresholds are per-space and per-corpus, empirically calibrated.** Trend↔trend uses
  0.62 same-category / 0.45 cross-category for arctic-l/1024, with an explicit warning against
  carrying over Atlas's MiniLM-384 constants of 0.55/0.38
  (`sql/task_recompute_connections.sql:25-30`). Trend↔content uses 0.60 for arctic-m/768
  (`sql/task_recompute_content_matches.sql:91-95`). **A product corpus needs its own
  calibration; no existing constant transfers.** Verified 2026-08-20.
- **`CRMA-452` is the closest precedent, and it does not embed its corpus.** It reuses
  `MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS.KEY_WORDS_VECTOR`, maintained by the data team. The
  trend-side companion vector is computed fresh each run and deliberately never persisted
  (`sql/task_recompute_content_matches.sql:23-27,126-134`). **No equivalent vector column
  exists for Shopify products, so this map owns product embedding outright.** Verified
  2026-08-20.
- **`CRMA-452` runs as a pure Snowflake task**, `USING CRON 0 17 * * * UTC`, recomputing the
  full trend × corpus matrix per fire and appending one generation to
  `FCT_TREND_CONTENT_MATCHES_LEDGER`. That ledger records `SCORE`, `MATCH_RANK`,
  `MATCH_THRESHOLD`, `WINDOW_DAYS`, `COMPUTATION_VERSION` per row, so past generations stay
  auditable. Rows below threshold are simply not written — an under-covered trend gets zero
  rows, not five weak ones (`sql/fct_trend_content_matches_ledger.sql:27-34`). Measured ~45s
  over a 40-trend sample. Verified 2026-08-20.
- **Snowflake cannot reach *any* external endpoint, Shopify or otherwise.** Reaching an
  external API needs an external access integration, which requires `ACCOUNTADMIN`; this
  pipeline's role is `MARKETING_ENGINEER` — the same grant wall `CRMA-534` hit. Re-measured at
  CRMA-750: `SHOW INTEGRATIONS` returns exactly one, `PYPI_ACCESS_INTEGRATION` (created
  2026-06-12), whose `ALLOWED_NETWORK_RULES` is Snowflake's built-in PyPI rule; `CURRENT_ROLE()`
  is `MARKETING_ENGINEER`. **A Snowflake task can compute work but cannot push it** — so a
  proc/task cannot call a workflow endpoint, only leave a condition for a poller to find.
  Verified 2026-08-20.
- **No dispatcher hop throws.** Every hop in `dispatcher-p_8rCBgnl` catches, returns an
  `error_message`, and short-circuits the chain; `respond` returns HTTP 500 while the run
  itself succeeds (`orchestrate/entry.js:114-165`). Nothing persists that `error_message` —
  the `mark_failed` step it was written for died with `STG_ENRICHMENT_QUEUE` on 2026-04-27,
  though the comment at `orchestrate/entry.js:14-18` still describes it. **No hop failure
  reaches `$errors`.** This falsifies the premise stated on CRMA-750. Verified 2026-08-20.
- **There is no re-enrichment path.** `WRITTEN_BY='lifecycle_request'` derives from
  `KIND='refinement'` (`sql/proc_enrichment_apply.sql:142`), and nothing in the repo passes
  that kind — the sole caller hard-codes `'initial'` (`write-p_o7CWa2K/workflow.yaml:48`). The
  lifecycle subagent's `request_re_enrichment` flag is persisted and never acted on;
  `commit_decision` is a pure SQL step with no HTTP fire. **Promotion is the only automated
  firer of the chain; everything else is a human `curl`.** Verified 2026-08-20.
- **The trend vector is created by the write hop, not before it.** `PROC_ENRICHMENT_APPLY`
  computes `TREND_VECTOR` server-side over `FN_TREND_EMBED_DOC` when the workflow passes NULL,
  which is the normal path (`sql/proc_enrichment_apply.sql:6-9`). `FCT_TRENDS.TREND_VECTOR` is
  retired — `sql/proc_promotion_apply.sql:261` states it outright. **Every trend also receives a
  `promotion_seed` ledger row at promotion carrying a topic-only vector**
  (`sql/proc_promotion_apply.sql:257-281`), so "has an enrichment row" is not the same
  condition as "has been enriched". Verified 2026-08-20. **Not yet measured:** how many of the
  ~484 trends hold a *non-seed* enrichment row. That number is the true size of the first poll
  tick, and it is ≤ 484. Queries against `FCT_TREND_ENRICHMENT_LEDGER` timed out repeatedly on
  2026-08-20; re-run before sizing the backfill.
- **The taxonomy Marcelo asks for does not exist.** He specifies a "tertiary URL taxonomy
  subcategory". There is no URL taxonomy anywhere in this pipeline and no third level. What
  exists, both frozen at first enrichment on `FCT_TRENDS`: `CATEGORY`, a closed 14-value enum
  (`food_beverage` 96, `wellness` 93, `beauty` 91, `home_living` 62, `fashion` 45 …), and
  `SUBCATEGORY`, **free text — 345 distinct values across 484 trends, ~71% cardinality**. His
  examples do appear (`functional_beverages` is the most common subcategory value), but at
  that cardinality it will not behave as a join key
  (`docs/dashboard/fields/category.md:9-14`). Measured over 484 trends, 2026-08-20.
- **There is no Amazon Associates table, anywhere.** Every accessible database was searched for
  Associates / affiliate / ASIN / SKU / commerce tables — zero hits. Every Amazon datum in this
  system is a `STG_EXTERNAL_SIGNALS` row with `SOURCE_NAME='amazon_movers'`, carrying ASIN,
  title, department, price, rank delta and URL — **and no image URL**. Verified 2026-08-20.
- **Both Amazon lanes are dormant.** `amazon_movers` last wrote 2026-05-15 (5,251 rows);
  `amazon_trends` last wrote 2026-05-04 (334 rows). About three months stale, while
  `CLAUDE.md` still lists the workflow as active. The scraper is regex-over-HTML and
  self-describes as "brittle by design"; a zero-product department emits only a
  `console.warn` (`ingestion/amazon-p_rvC71gN/fetch_source/entry.js:5-6,111-113`). Verified
  2026-08-20.
- **The pipeline deliberately severs the trend↔SKU link today.** `amazon_movers` is excluded
  from `FCT_SIGNALS` by design as "too granular — individual SKUs" (`sql/fct_signals.sql:47`),
  and `PROC_AGGREGATE_AMAZON` LISTAGGs product titles into themes that carry no ASIN, price or
  URL back, because "individual product signals embed poorly against LLM trend signals"
  (`sql/proc_aggregate_amazon.sql:4-7`). Verified 2026-08-20.
- **Shopify REST `products.json` still works at 2026-04, but it is a frozen surface.** Legacy
  since 2024-10-01; list/create/update/delete "deprecated as of REST API 2024-04"; in
  maintenance mode taking only critical updates. **Version 2026-04 is accessible until
  2027-04-16.** One hard functional limit from the 2024-04 release notes: only custom apps that
  do **not** need more than 100 variants may keep using the deprecated REST product APIs.
  Verified 2026-08-20.
- **The current field whitelist leaves four useful fields on the table, at zero extra cost.**
  `products.json` accepts `product_type`, `vendor`, `body_html` and `status` in the same
  `fields` parameter Marcelo already uses — all candidates for the embed doc. **Collection
  membership is not on the product record.** Two shape gotchas: `body_html` is HTML and needs
  stripping, and `tags` is a **comma-separated string**, not an array. Verified 2026-08-20.
- **A full catalog sweep is cheap; metafields are not.** Pagination is cursor-based via the
  `Link` header at `limit=250` max, and a `page_info` request may carry only `limit` and
  `fields` — every filter goes on the first request. Rate limit is 40 requests per app per
  store per minute, restoring at 2/s. So 10,000 products is 40 requests, roughly 20 seconds.
  **Metafields have no inline form on REST — one request per product**, a 250× multiplier that
  turns the same 10,000-product catalog into about 83 minutes. Verified 2026-08-20.
- **Delta sync is achievable, but not on the obvious endpoint.** `updated_at_min` is **not
  documented** on `products.json` at 2026-04, though that parameter table is provably
  non-exhaustive (`since_id` is absent yet appears in Shopify's own example) and the sibling
  count endpoint does document it — so it likely works, pending one live call. Two documented
  alternatives need no gamble: **`product_listings.json`**, which documents `updated_at_min`,
  allows `limit` up to **1000**, runs on the `read_product_listings` scope already held, and
  carries `body_html` / `product_type` / `vendor`; or GraphQL `products(query:
  "updated_at:>…")`. Verified 2026-08-20.
- **`insights-agent` reads Snowflake directly, and already holds a privileged credential.**
  Service user `TH_APIUSER` holds `TH_APIROLE`, which carries
  `MCC_PRESENTATION_TREND_AGENT_SFULL` — ownership tier, not read-only — with a login as
  recent as 2026-08-20 05:12 EDT. Its Postgres holds only its own app state. Corroborated by
  `prediction-scoring-handoff-martin.md` in this repo, whose switchover step is "add the
  columns to the `SELECT` in `snowflake_service.py`". Verified 2026-08-20.
- **A new ledger is readable by `insights-agent` the moment it is created.** Future grants on
  `MCC_PRESENTATION.TREND_AGENT` give `..._SR` SELECT on all new TABLEs and DYNAMIC_TABLEs,
  and the role chain runs `SR → SRW → SFULL → TH_APIROLE`. Confirmed against
  `DT_TREND_DASHBOARD` (created 2026-08-18), which carries exactly those auto-applied grants.
  **No grant ticket is needed, and a sourcing ledger does not have to be surfaced through
  `DT_TREND_DASHBOARD` to be reachable** — dashboard exposure is a product decision, not an
  access one. Verified 2026-08-20.
- **`insights-agent` runs in a different GCP project.** `mcc-crm-automations` owns zero
  forwarding rules and zero reserved addresses, while the staging host sits behind GCLB
  `34.117.216.29`; a load-balancer IP the project does not own cannot front a service in it.
  Its Secret Manager holds only `curacity_coda_api` and `snowflake-private-key` — **no Shopify
  token**. Consequence: Secret Manager cannot be shared between the two sides, and **Snowflake
  is the sole shared substrate**. Verified 2026-08-20.
- **The `insights-agent` repo is not on this machine**, and its staging API is unreachable from
  here (TLS reset, likely VPN-gated). Anything about its frontend shape must come from Marcelo,
  not from inspection. Verified 2026-08-20.
- **Vector cost is not a factor in this design.** A `VECTOR(FLOAT, 1024)` is 4 KB per row, so
  a 250-product catalog is ~1 MB and a 50,000-product catalog ~200 MB. Embedding 250 products
  costs roughly 12,500 tokens, paid once per catalog change. For scale, `FCT_SIGNALS` holds
  **110,439 signals** at an average 221-character embed doc — about 6.1M tokens embedded to
  date, growing every 5 minutes. The catalog is ~0.2% of that. Cortex *credit* history could
  not be read directly: `SNOWFLAKE.ACCOUNT_USAGE` is closed to `MARKETING_ENGINEER`. Measured
  2026-08-20.
- **The store's real product count is unknown.** Marcelo's implementation pulls `limit=250`,
  which is Shopify's **page maximum**, not a measurement. If the store stocks more than 250
  products, the current substring match has only ever searched the first page. Nobody can
  settle this without the token — which is why token provisioning is the keystone of this map.
  Noted 2026-08-20.
- **`FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD` is a VARIANT and accepts unknown keys** — the write
  path serializes the whole dict (`sql/proc_enrichment_apply.sql:114,147`). Recorded because
  it was the obvious place to put products, and this map deliberately chose not to. Consuming
  any payload key still needs an explicit change to `DT_TREND_DASHBOARD`
  (`sql/dt_trend_dashboard.sql:94-110`). Verified 2026-08-20.

## Standing constraints

Settled decisions in binding present tense.

- Sourced products live in **their own append-only ledger**, not on the enrichment record.
- Retrieval is **vector cosine similarity**; selection is a **Gemini 3.7 Flash** agent reading
  a pre-ranked candidate list. An LLM never computes similarity.
- **Retrieval is vectors for auditability, not for cost or scale.** Putting the whole catalog
  in the model's context was considered and rejected: at 250 products it is affordable and
  needs no calibration, but it yields no stored score. A reproducible `SCORE` that can be
  thresholded and replayed is the property the pipeline's ledgers already depend on.
  **Revisit trigger**: if calibration shows the vector ranking adds nothing the selector could
  not get from the raw catalog, collapse the retrieval stage.
- Sourcing is **driven by the presence of an enrichment row**, on a poll. A cron asks Snowflake
  which trends hold an enrichment ledger row and no sourcing row, then fires the ecomm agent
  once per answer. Sourcing is **not** a hop in the dispatcher chain, and nothing in the chain
  fires it. *Amended 2026-08-20 at CRMA-750.* The original constraint read "fired synchronously
  off promotion and recalled by re-enrichment"; it rested on a re-enrichment path that was
  designed and never built (`KIND='refinement'` is passed by nothing). **A catalog restock does
  not re-source anything** — products refresh only when a trend moves, which means when it is
  re-enriched. A periodic re-sweep on catalog change is additive and deliberately deferred.
- Fall-through between tiers is a **similarity floor**, never a match count. A trend the store
  does not stock returns nothing rather than the five least-irrelevant items in the catalog.
- **"Processed, nothing matched" is a distinct state** from "not yet sourced", and must stay
  distinguishable downstream.
- Category adjacency anchors on **`CATEGORY`** (the 14-value enum). `SUBCATEGORY` is signal for
  the selector, never a filter.
- Product **vectors are persisted in Snowflake**; presentation fields (price, availability,
  image) are hydrated live from Shopify for the few products actually selected.
- The **multi-tier contract is in scope; building the second tier is not.** The contract exists
  to stop the matching design over-fitting to one 250-product catalog.

## Decisions so far

<!-- `resolve` appends here. Do not hand-edit while a session is running. -->

- [Research: how the Decision panel will read sourced products](https://mcclatchy.atlassian.net/browse/CRMA-749) — **Decided:** insights-agent reads Snowflake directly as TH_APIUSER/TH_APIROLE (SFULL tier); future grants make any new ledger readable on creation; it runs in a different GCP project so Secret Manager cannot be shared.
  **Binds:** CRMA-751 needs no grant ticket and need not route through DT_TREND_DASHBOARD for access. CRMA-747 must provision the token on the trend-tree side only — Snowflake is the sole shared substrate. Two frontend-shape questions remain for Marcelo, chiefly whether the panel hydrates price/image live, which decides if the ledger row must be self-sufficient.

- [Research: the Shopify Admin product payload at API version 2026-04](https://mcclatchy.atlassian.net/browse/CRMA-748) — **Decided:** REST products.json is live at 2026-04 but frozen (expires 2027-04-16, >100-variant apps excluded); product_type/vendor/body_html/status are free to add; a full sweep is 40 requests but metafields are 1-per-product; delta sync should use product_listings.json, not an undocumented updated_at_min.
  **Binds:** CRMA-753's embed doc may draw on product_type/vendor/body_html at no request cost, but must strip HTML and split the comma-separated tags string; collection membership is unavailable on REST. CRMA-752 should sync via product_listings.json (documented updated_at_min, limit 1000, existing scope). If metafields or collections ever enter the embed doc, REST's N+1 breaks the budget and GraphQL must be costed first.

- [Decide: where the sourcing step sits in the chain, and what a failure does](https://mcclatchy.atlassian.net/browse/CRMA-750) — **Decided:** Sourcing is not a chain hop at all — a cron 'ecomm agent' polls Snowflake for trends holding a real enrichment row and no sourcing row, and fires once per answer; the dispatcher is unchanged.
  **Binds:** CRMA-751's ledger must carry three states (not sourced / processed-nothing-matched / sourcing failed) and should be written by a PROC_SOURCING_APPLY mirroring PROC_ENRICHMENT_APPLY. The poll condition must exclude promotion_seed rows and needs an in-flight guard. Backfill is solved — the ~484 existing trends match the poll on tick one. The ecomm agent needs custom_response ON at creation (write-once) plus both an hi_ HTTP trigger and a dc_ cron.

## Not yet specified

- **Prompt versioning for the selector** — whether its prompt lands in `DIM_LLM_PROMPT` like
  the rest of the fleet, and what lane name it takes. Sharpens once the selector's contract
  lands.
- **Cost and telemetry** — sourcing can no longer ride enrichment's cost line, because
  CRMA-750 put it outside the chain entirely; it owns its own. What remains open is the shape
  of that record. Sharpens with the ledger schema. Note that only about half of
  `FCT_TREND_ENRICHMENT_LEDGER` rows carry a cost value at all (`CRMA-442`), so the existing
  pattern is not a clean model.
- **Where the Shopify token is held** — Secret Manager in `mcc-crm-automations`, a Pipedream
  connected account, or wherever `insights-agent` already keeps it. Sharpens with the
  provisioning task, which will surface where the token actually ends up.
- **Whether the sourcing path should be built on GraphQL rather than REST.** REST
  `products.json` is in maintenance mode and version 2026-04 expires 2027-04-16, so anything
  built on it inherits a migration. REST is adequate while the embed doc draws only on the
  product record, and collapses on cost the moment metafields or collection membership enter
  it — both are inline on the GraphQL `Product` object. Sharpens once the embed doc is settled
  at the calibration ticket; cost the migration before the doc grows, not after.
- **Whether the selector's judgement is worth its latency** — a measurable question once the
  calibration ticket produces real candidate lists. If the vector ranking is already good
  enough, the selection stage may reduce to a threshold.

## Out of scope

- **The KDML / Gary Kirwan external discovery API** — Marcelo's separate track; he scoped it
  out explicitly in the handoff.
- **Reviving `ingestion/amazon-p_rvC71gN`** — dormant since 2026-05-15, brittle regex-over-HTML
  scrape, and it carries no product image. Building the Amazon tier is a separate effort.
- **The published collection-page surface** — the Decision Page is the only consumer this map
  designs for. Sourced rows can be reused later without this map guessing at that surface's
  needs.
- **Reusing `all-MiniLM-L6-v2` from `insights-agent`'s `correlation_service.py`**, as the
  handoff proposes. This pipeline migrated off that model at `CRMA-462`; adopting it would
  stand up a second, weaker embedding space beside the one already owned.
