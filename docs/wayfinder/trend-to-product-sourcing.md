<!-- map: CRMA-745 -->

# Map: resolve a trend to purchasable products — Shopify first-pass sourcing

## Destination

A locked, handoff-ready **spec** for resolving a trend to purchasable products, handed to
`/to-spec` → `/to-tickets`. Vectors retrieve candidates; a Gemini 3.7 Flash selector picks.
Results append to their own ledger, written by a chain step fired off promotion and recalled
by re-enrichment. Shopify is the only implemented tier; the multi-tier contract is specified,
not built.

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
  owns the match and `insights-agent` reads the result; the Decision panel is the only
  consumer surface; retrieval is vectors and selection is an agent; sourcing is its own pass
  with its own ledger, not a field on the enrichment record; the pass is fired synchronously
  off promotion and recalled by re-enrichment; selection runs on Gemini 3.7 Flash in the
  chain, not on Cortex inside Snowflake.

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
- **Snowflake cannot query Shopify mid-statement.** Reaching an external API needs an external
  access integration, which requires `ACCOUNTADMIN`; this pipeline's role is
  `MARKETING_ENGINEER` — the same grant wall `CRMA-534` hit. Verified 2026-08-20.
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
- The pass is fired **synchronously off promotion** and recalled by re-enrichment. **A catalog
  restock does not re-source anything** — products refresh only when a trend moves. A periodic
  re-sweep is additive and deliberately deferred.
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

## Not yet specified

- **Prompt versioning for the selector** — whether its prompt lands in `DIM_LLM_PROMPT` like
  the rest of the fleet, and what lane name it takes. Sharpens once the selector's contract
  lands.
- **Cost and telemetry** — whether sourcing carries its own cost line or rides enrichment's.
  Sharpens with the ledger schema. Note that only about half of `FCT_TREND_ENRICHMENT_LEDGER`
  rows carry a cost value at all (`CRMA-442`), so the existing pattern is not a clean model.
- **Backfill** — roughly 484 trends already exist and will not re-enrich soon. Firing off
  promotion sources none of them. Sharpens once chain placement and the ledger land.
- **Where the Shopify token is held** — Secret Manager in `mcc-crm-automations`, a Pipedream
  connected account, or wherever `insights-agent` already keeps it. Sharpens with the
  provisioning task, which will surface where the token actually ends up.
- **Whether the selector's judgement is worth its latency** — a measurable question once the
  calibration ticket produces real candidate lists. If the vector ranking is already good
  enough, the selection stage may reduce to a threshold.

## Out of scope

- **The KDML / Gary Kirwan external discovery API** — Marcelo's separate track; he scoped it
  out explicitly in the handoff.
- **Reviving `ingestion/amazon-p_rvC71gN`** — dormant since 2026-05-15, brittle regex-over-HTML
  scrape, and it carries no product image. Building the Amazon tier is a separate effort.
- **The published collection-page surface** — the Decision panel is the only consumer this map
  designs for. Sourced rows can be reused later without this map guessing at that surface's
  needs.
- **Reusing `all-MiniLM-L6-v2` from `insights-agent`'s `correlation_service.py`**, as the
  handoff proposes. This pipeline migrated off that model at `CRMA-462`; adopting it would
  stand up a second, weaker embedding space beside the one already owned.
