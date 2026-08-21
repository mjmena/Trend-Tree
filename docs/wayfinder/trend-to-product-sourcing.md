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
- **The store stocks 187 products — all active, all published.** Measured from a Shopify
  admin CSV export received 2026-08-20, kept at
  `~/dev/trend-tree-data/products_export_2026-08-20.csv` and **out of git** — it carries
  wholesale `Cost per item`. Under the 250-per-page maximum, so Marcelo's `limit=250` pull
  has been seeing the whole catalog. Field coverage across all 187: `Title`, `Body (HTML)`,
  `Tags`, `Vendor` and `Image Src` are 100% populated (body median ~1.8K chars, max ~84K);
  `Type` is unreliable in this store (56 empty, 28 hold the literal string `0`);
  `Product Category` (Google taxonomy paths, 51 distinct) is present on 119 of 187. It is a
  multi-vendor Shopify Collective storefront; median price $35, range $5–603. **The export is
  a usable calibration corpus for the vector-space prototype** — the token remains necessary
  only for the live sync path, not for calibration. Measured 2026-08-20.
- **No ledger in this repo records a computed-but-empty result.** `FCT_TREND_CONTENT_MATCHES_LEDGER`
  and `FCT_TREND_CONNECTIONS_LEDGER` both write nothing below threshold, and both say so outright
  (`sql/fct_trend_content_matches_ledger.sql:42-45`, `sql/dt_trend_dashboard.sql:299-302`). The
  richest outcome encoding is `FCT_PROMOTION_AUDIT.DECISION` — one row per candidate evaluated
  regardless of outcome, coarse enum plus a finer category. The only `STATUS` + `ERROR_MESSAGE`
  pair in `sql/` is `STG_AGENT_RUN_COSTS`, and it sits in `MCC_RAW.MARKETING_DEV`, out of
  `insights-agent`'s reach. **The three-state sourcing header establishes this precedent rather
  than following one.** Verified 2026-08-20.
- **"Source" is already taken as a word in this pipeline.** `FCT_SIGNALS.SOURCE_NAME` means a
  signal's platform of origin, `FCT_TREND_SOURCE_METRICS` builds on that meaning, and `CONTEXT.md`
  carries a **Source** glossary entry plus a flagged ambiguity about it. Product columns therefore
  take `CATALOG_*`. Separately, "semantic" is already the repo's word for vector matching — across
  `sql/`, `agents/` and `docs/`: `VECTOR_COSINE_SIMILARITY` 19, "cosine similarity" 15, "nearest
  neighbor" 8, "semantic match(ing)" 8, "vector search" 2. Verified 2026-08-20.
- **`FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD` is a VARIANT and accepts unknown keys** — the write
  path serializes the whole dict (`sql/proc_enrichment_apply.sql:114,147`). Recorded because
  it was the obvious place to put products, and this map deliberately chose not to. Consuming
  any payload key still needs an explicit change to `DT_TREND_DASHBOARD`
  (`sql/dt_trend_dashboard.sql:94-110`). Verified 2026-08-20.

## Standing constraints

Settled decisions in binding present tense.

- Sourced products live in **their own append-only ledger**, not on the enrichment record. That
  ledger is **two tables**: a run header, `FCT_TREND_SOURCING_LEDGER`, one row per (trend, tier,
  run), and its candidate rows, `FCT_TREND_SOURCING_CANDIDATES`. *Settled 2026-08-20 at CRMA-751.*
- **One header row is one trend, one tier, one run.** The three states live on the header — no
  header is "not sourced", `STATUS='no_match'` with zero candidates is "processed, nothing
  matched", `STATUS='failed'` carries the error. A miss writes no candidate rows, so the header is
  the only place a miss can ever be recorded.
- The ledger keeps **every candidate the selector was shown**, not only its picks. The rejects are
  the calibration evidence and the only way to judge whether the selector earns its latency.
- **A model-authored verdict is an enum, never a numeric score**, and a retrieval score is never
  blended with a model verdict into one column. `SEMANTIC_SCORE` is geometry and reproducible;
  `REASONED_FIT` (`strong`/`partial`/`weak`) is judgement and is not.
- Product identity columns are **catalog-neutral** — `CATALOG_PRODUCT_ID`, `CATALOG_PAYLOAD`.
  `SOURCE_*` is reserved for signal provenance and must not be reused for products.
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
- Tiers compose by **top-up in commercial-preference order**: while total selector picks are
  under `MAX_SOURCED_PRODUCTS` (5) and a live lower tier exists, that tier is consulted — one
  retrieval and **one selector call per consulted tier**, never one call over a mixed pool.
  The per-tier similarity floor is **never relaxed to fill the quota**: the count triggers
  consultation, the floor gates entry, and a trend no catalog stocks returns nothing rather
  than the least-irrelevant items. Cross-tier `SEMANTIC_SCORE`s are never compared — order is
  tier block first, then score within a tier. *Amended 2026-08-20 at CRMA-755.* The original
  constraint consulted a lower tier only when the tier above yielded nothing above its floor.
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

- [Decide: the sourced-products ledger — schema, the no-match state, and dashboard exposure](https://mcclatchy.atlassian.net/browse/CRMA-751) — **Decided:** Two tables — FCT_TREND_SOURCING_LEDGER (header: one row per trend, tier and run, carrying the three states) and FCT_TREND_SOURCING_CANDIDATES (every candidate the selector saw, not just its picks); SEMANTIC_SCORE (cosine, reproducible) and REASONED_FIT (strong/partial/weak enum) live in separate columns and are never blended.
  **Binds:** CRMA-753 calibrates SEMANTIC_THRESHOLD against the stored rejects and owns EMBED_DOC_VERSION. CRMA-754 must present the candidate list in SEMANTIC_SCORE-descending order within a tier (tier-block ordering settled at CRMA-755) — otherwise a stored rank column has to come back — and must define what strong/partial/weak mean. The DDL establishes this repo's first computed-but-empty row and needs a staleness rule for headers stuck in 'running'; PROC_SOURCING_APPLY mirrors PROC_ENRICHMENT_APPLY; DT_TREND_DASHBOARD gains SOURCING_STATUS, SOURCED_PRODUCTS and SOURCED_AT.

- [Decide: the multi-tier contract — how a second product source plugs in](https://mcclatchy.atlassian.net/browse/CRMA-755) — **Decided:** A tier participates with a stable CATALOG_PRODUCT_ID, title + one descriptive text field (matchable — each tier authors its own embed doc and owns its EMBED_DOC_VERSION) and title + URL (renderable — image and price optional, so Amazon qualifies), plus its own calibrated floor and a declared hydration mode (live/static); tiers top up selector picks to MAX_SOURCED_PRODUCTS (5) in preference order, one selector call per consulted tier, floors never relaxed; the tier registry is a TIERS constant in ecomm-agent code, the tier stored as lowercase text on the header.
  **Binds:** CRMA-754's ordering is tier block first, then SEMANTIC_SCORE within a tier, and its selector call takes a slots-remaining input. Reads take the latest completed run outright, concatenating its matched tiers in preference order — a run can hold several matched headers, and an older run's products never linger. The spec must carry the Decision Page's text-only-card obligation, the per-tier calibration onboarding step, and the note that a live second tier is hot path, not fallback.

## Not yet specified

- **Prompt versioning for the selector** — whether its prompt lands in `DIM_LLM_PROMPT` like
  the rest of the fleet, and what lane name it takes. Sharpens once the selector's contract
  lands.
- **Cost telemetry that actually lands.** CRMA-751 settled *where* it goes — `STG_AGENT_RUN_COSTS`
  already takes one row per Pipedream run, correlated by the header's `AGENT_SESSION_ID`. What is
  still open is whether the ecomm agent will write it reliably: only about half of
  `FCT_TREND_ENRICHMENT_LEDGER` rows carry a cost value at all (`CRMA-442`), so the fleet's
  existing habit is not a clean model to copy.
- **Where the Shopify token is held** — Secret Manager in `mcc-crm-automations`, a Pipedream
  connected account, or wherever `insights-agent` already keeps it. Sharpens with the
  provisioning task, which will surface where the token actually ends up.
- **Whether the sourcing path should be built on GraphQL rather than REST.** REST
  `products.json` is in maintenance mode and version 2026-04 expires 2027-04-16, so anything
  built on it inherits a migration. REST is adequate while the embed doc draws only on the
  product record, and collapses on cost the moment metafields or collection membership enter
  it — both are inline on the GraphQL `Product` object. Sharpens once the embed doc is settled
  at the calibration ticket; cost the migration before the doc grows, not after.
- **Whether the selector's judgement is worth its latency** — still open, but CRMA-751 built the
  apparatus to answer it: every candidate the selector saw is kept, carrying both `SEMANTIC_SCORE`
  and `REASONED_FIT`. The measurement is to group by `REASONED_FIT` and inspect the score
  distribution inside each group; a `strong` ranked below a `weak` is the inversion that justifies
  the stage. If no such inversions appear, the selection stage may reduce to a threshold.

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
