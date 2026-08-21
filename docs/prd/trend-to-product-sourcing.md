<!-- prd: trend-to-product-sourcing · epic: see JIRA remote link · map: CRMA-745 -->

# PRD: Trend-to-product sourcing — Shopify first pass

Produced 2026-08-21 from wayfinder map [CRMA-745](https://mcclatchy.atlassian.net/browse/CRMA-745)
(`docs/wayfinder/trend-to-product-sourcing.md` on branch `wayfinder/trend-to-product-sourcing`).
Every decision below was settled on that map's tickets; this document assembles them into one
buildable spec. Origin: Marcelo's 2026-07-28 handoff *Shopify Trend → Product Matching*.

## Problem Statement

Trend Tree verifies emerging consumer trends, but a trend ends at insight — nothing connects
a trend to products someone can buy. The Decision Page (in `insights-agent`) wants to show
purchasable products next to each trend. Its current implementation substring-matches trend
names against a single `limit=250` Shopify pull, inside `insights-agent`:

- Substring matching misses everything semantic — a "Bedtime Magnesium Sprays" trend never
  finds a magnesium balm.
- Nothing records what was searched, what was rejected, or at what score — no audit trail,
  no calibration data.
- "Nothing matched" and "never ran" are indistinguishable, so an empty panel is unexplainable.
- The matching lives outside the pipeline that owns trend semantics and the canonical
  embedding space.

## Solution

Trend Tree owns a new **sourcing** pass. After a trend is enriched, a cron-driven **ecomm
agent** resolves it to at most 5 purchasable products: vector **retrieval** ranks the store
catalog against the trend's persisted embedding, and a Gemini 3.7 Flash **selector** — a
filter, never a ranker — picks only products a shopper following the trend would recognize,
with permission to return nothing. Every run writes an append-only **sourcing ledger**: a
header row recording the outcome (including "processed, nothing matched" and "failed") and
one row per candidate the selector was shown, picks and rejects alike.

The catalog is synced daily from Shopify into a product dimension holding persisted vectors —
and is seeded immediately from the 2026-08-20 admin CSV export, so the build proceeds before
the Shopify token lands. `insights-agent` reads the results directly from Snowflake with the
credential and grants it already has; Snowflake is the only interface between the two systems.

Shopify is the only implemented tier. The multi-tier contract is specified so the design
does not overfit to one 187-product catalog, but no second tier is built.

## User Stories

1. As a Decision Page operator, I want each trend to show up to 5 purchasable products, so
   that I can act on a trend commercially without searching the store myself.
2. As a Decision Page operator, I want each shown product to carry a one-sentence rationale
   and a fit grade (strong / partial / weak), so that I can judge the match without
   re-deriving it.
3. As a Decision Page operator, I want a trend with no matching products to say "processed,
   nothing matched" — with the selector's note on why — rather than showing an empty space,
   so that I can tell a genuine gap from a pipeline failure.
4. As a Decision Page operator, I want never to be shown quota-filling picks, so that a
   product list I see is always defensible.
5. As a Decision Page operator, I want product links built on the store handle, so that
   every product click lands on the live product page.
6. As the `insights-agent` developer, I want to read sourcing results with a plain
   `SELECT` on tables my existing role already reaches, so that no new credential, grant
   ticket, or API integration is needed.
7. As the `insights-agent` developer, I want each candidate row to carry frozen
   `*_AT_MATCH` price, image, and availability snapshots, so that the panel renders even if
   it cannot call Shopify live.
8. As the `insights-agent` developer, I want the three sourcing states (not sourced /
   no match / failed) distinguishable in one query, so that the panel can render each
   honestly.
9. As the pipeline operator, I want sourcing to run outside the dispatcher chain, so that a
   sourcing failure can never break or slow promotion → enrichment → write.
10. As the pipeline operator, I want a failed sourcing run recorded as a distinct header
    state and retried by the next poll tick, so that failures self-heal instead of parking
    a trend silently forever.
11. As the pipeline operator, I want the ~443 already-enriched live trends sourced
    automatically by the same poll condition, so that backfill needs no bespoke machinery.
12. As the pipeline operator, I want any future path that writes a real enrichment row to
    get sourcing for free, so that new enrichment kinds need not know sourcing exists.
13. As the pipeline operator, I want an HTTP trigger beside the cron, so that I can fire a
    single trend manually for testing or repair.
14. As the pipeline operator, I want the catalog seeded from the admin CSV export today, so
    that the build and first sourcing runs do not wait on the Shopify token.
15. As the pipeline operator, I want the ecomm agent to decline to source against a catalog
    older than 7 days, so that stale products are never matched silently.
16. As the pipeline operator, I want one `STG_AGENT_RUN_COSTS` row per ecomm-agent run —
    written on failure too — so that sourcing cost is visible per run, not estimated.
17. As a merchandiser, I want "which trends does our own store fail to stock?" to be one
    query on Shopify-tier `no_match` headers, so that the sourcing ledger doubles as a buy
    list.
18. As a merchandiser, I want tiers consulted in commercial-preference order with our own
    store first, so that house inventory always outranks a marketplace item.
19. As a data analyst, I want every candidate the selector was shown persisted with its
    `SEMANTIC_SCORE`, so that retrieval can be replayed and re-thresholded from stored data.
20. As a data analyst, I want the geometric score and the model verdict in separate,
    never-blended columns, so that I can compare their orderings and judge whether the
    selector earns its latency.
21. As the audit agent, I want a catalog-freshness row (YELLOW past 3 days, RED past 7), so
    that a dead sync job surfaces in the daily report.
22. As a future tier implementer, I want to add a product source by writing a sync job, a
    tier config, and rows into the same dimension and ledger, so that no schema change and
    no redesign of the ecomm agent is needed.
23. As the fleet maintainer, I want the selector born on ungrounded `gemini-3.7-flash` with
    the current call-shape rules, so that the CRMA-726 model migration has nothing to
    migrate here.

## Implementation Decisions

### Ownership and the consumer interface

- Trend Tree owns the match; `insights-agent` reads the result. **Snowflake is the sole
  shared substrate** — the two systems run in different GCP projects and cannot share
  Secret Manager.
- All new tables live in the presentation schema the pipeline already writes. Existing
  future grants make them readable by `insights-agent`'s role chain the moment they are
  created; no grant ticket.
- The Decision Page is the only consumer surface this spec designs for.

### Data model

Three new tables. Naming rules: product identity columns are **`CATALOG_*`** (`SOURCE_*`
is reserved for signal provenance); the vector score is **`SEMANTIC_SCORE`** (names the
category, survives a metric change); the model verdict is **`REASONED_FIT`** (grammatically
unlike a score, so nobody averages them).

**`DIM_CATALOG_PRODUCT`** — one mutable dimension for all tiers, upserted by
`(TIER, CATALOG_PRODUCT_ID)`. Holds identity, the embed doc plus its hash and version, the
1024-dim product vector, `CATALOG_STATUS`, and `LAST_SEEN_AT` — never presentation fields.
**The Shopify tier's `CATALOG_PRODUCT_ID` is the product handle** (the CSV export carries
no numeric id; the handle is the URL identity; the numeric id rides in the payload once the
live sync observes it). A product missing from a sweep is **soft-delisted, never deleted**;
retrieval filters to `active`; a renamed handle behaves as delist + add.

**`FCT_TREND_SOURCING_LEDGER`** — the run header, one row per **(trend, tier, run)**:
`SOURCING_RUN_ID` (PK) · `TREND_ID` · `TIER` · `STARTED_AT` · `COMPLETED_AT` · `STATUS`
(`running | matched | no_match | failed`) · `ERROR_MESSAGE` · `SEMANTIC_THRESHOLD` ·
`CANDIDATE_COUNT` · `SELECTED_COUNT` · `SELECTOR_NOTE` (nullable; the selector's run-level
`pool_note`) · `MODEL_USED` · `EMBED_DOC_VERSION` · `COMPUTATION_VERSION` ·
`AGENT_SESSION_ID`. The header is the only place a miss can be recorded: no header is "not
sourced", `no_match` with zero candidates is "processed, nothing matched", `failed` carries
the error. This establishes a repo precedent — no existing ledger records a
computed-but-empty result.

**`FCT_TREND_SOURCING_CANDIDATES`** — one row per candidate the selector was shown, picks
and rejects alike: `SOURCING_CANDIDATE_ID` (PK) · `SOURCING_RUN_ID` · `TREND_ID`
(deliberately denormalized) · `TIER` · `CATALOG_PRODUCT_ID` · `PRODUCT_HANDLE` ·
`PRODUCT_TITLE` · `PRODUCT_TYPE` · `VENDOR` · `PRODUCT_URL` · `PRICE_AT_MATCH` ·
`IMAGE_URL_AT_MATCH` · `AVAILABLE_AT_MATCH` · `SEMANTIC_SCORE` · `REASONED_FIT` ·
`REASONED_FIT_RATIONALE` · `SELECTED` · `CATALOG_PAYLOAD` · `CREATED_AT`. Rejects carry
`SELECTED=false` and NULL `REASONED_FIT`. The rejects are the calibration evidence. No
rank column — rank is derivable from `SEMANTIC_SCORE` while presentation order stays
score-descending. The `_AT_MATCH` suffix marks frozen snapshots; live price and
availability for the few products actually shown are hydrated by the consumer, not stored
as truth here. `CATALOG_PAYLOAD` is a VARIANT holding what one tier carries and another
cannot, so a second tier appends without DDL change.

- **A model-authored verdict is an enum, never a numeric score** (`strong | partial |
  weak`, three levels), and a retrieval score is never blended with a model verdict into
  one column. `SEMANTIC_SCORE` is geometry and reproducible; `REASONED_FIT` is judgement
  and is not.

### Trigger: a poll, not a chain hop

> **Amended 2026-08-21 (platform, Martin's call).** The ecomm agent runs on **Cloud Run**
> (a service, per [CRMA-436](https://mcclatchy.atlassian.net/browse/CRMA-436)'s decided
> fleet-extraction default), in the shared `mcc-crm-automations` project, not on Pipedream.
> This was never going to be a Pipedream dispatcher hop (see below), so the move carries
> none of the dispatcher-interop cost the enrichment-agent migration
> ([CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429)) has to solve for — the
> ecomm agent is the first agent to actually execute that map's spec, not just follow it.
> Code home is `services/ecomm-agent/` ([CRMA-439](https://mcclatchy.atlassian.net/browse/CRMA-439)'s
> `services/` namespace), deployed via `services/deploy.sh` ([CRMA-440](https://mcclatchy.atlassian.net/browse/CRMA-440)'s
> dark-deploy → smoke test → promote pattern). Shared pure-function modules live in
> `services/lib/` (bootstrapped here for the first time); `agents/lib/catalog_transform.mjs`
> (CRMA-773) stays where it is and is referenced/copied into `services/lib/` if/when the
> Cloud Run catalog-sync job (CRMA-777) is built.

- Sourcing is **not** a hop in the dispatcher chain and nothing in the chain fires it. The
  ecomm agent is its own **Cloud Run service** with one authenticated HTTP endpoint
  (`POST /source {trend_id}`) — **no separate cron/HTTP-trigger split**, unlike a Pipedream
  workflow. A **Cloud Scheduler** job (CRMA-778) invokes the same endpoint per trend on the
  poll cadence via a Google OIDC token; a human `curl`s the identical endpoint (also OIDC)
  for a manual single-trend fire or repair. Cloud Run's native synchronous HTTP response
  makes Pipedream's write-once "sync-response toggle" quirk moot — this is a simplification
  the platform switch buys for free, not a design change.
- Ingress is **authenticated Cloud Run, no public endpoint** (`--no-allow-unauthenticated`),
  following [CRMA-441](https://mcclatchy.atlassian.net/browse/CRMA-441)'s decided ingress
  pattern — but the ecomm agent needs its **own** caller identity/`run.invoker` binding,
  since nothing calls it from Pipedream; it is not a beneficiary of the existing
  `trend-tree-pipedream-caller@` service account. This binding is a provisioning
  prerequisite (see Provisioning below).
- The poll condition is an anti-join: trends holding a **real (non-seed) enrichment ledger
  row** — the seed rows written at promotion carry topic-only vectors and must be excluded
  — and no sourcing header for the (trend, tier). Live (non-retired) trends only.
- Sourcing therefore runs strictly **after the enrichment write**, because the write is
  what creates the persisted trend vector the poll condition keys on.
- **In-flight guard**: the header is written at run start with `STATUS='running'`, and the
  same anti-join skips it. A header still `running` after **30 minutes** is stale and
  re-takeable, so a crashed run cannot park a trend.
- A failed run leaves the trend matching the poll condition (the `failed` header does not
  satisfy it), so the next tick retries — self-healing by construction.
- Cron cadence: **every 15 minutes**, processing a bounded batch of **25 trends per tick**,
  oldest enrichment first. The dashboard's dynamic table already lags 15 minutes, so no
  consumer can perceive faster delivery. First-tick backlog is the ~443 live enriched
  trends; at this pacing it drains in under 5 hours.
- **Backfill is the poll**: existing trends match the condition on the first ticks. When a
  second tier switches on, every trend lacks that tier's header and backfills the same way.
- A catalog restock does not re-source anything; products refresh only when a trend is
  re-enriched.

### Retrieval

- Space: the pipeline's canonical **`snowflake-arctic-embed-l-v2.0` / 1024-dim** embedding.
  The trend side is the **persisted `TREND_VECTOR` on the latest real enrichment row** —
  no trend-side re-embed, ever. An LLM never computes similarity.
- Cosine similarity over `DIM_CATALOG_PRODUCT` rows with `CATALOG_STATUS='active'`,
  Shopify-tier floor **`SEMANTIC_THRESHOLD = 0.40`** (one global floor, not
  category-aware), at most **`TOP_N = 10`** candidates, score-descending.
- Vectors exist **for auditability, not cost**: the stored, replayable score is the
  property the ledgers depend on. Revisit trigger: if calibration shows the ranking adds
  nothing over the raw catalog, collapse the retrieval stage.
- Category adjacency anchors on `CATEGORY` (the closed 14-value enum); `SUBCATEGORY` (free
  text, ~71% cardinality) is signal shown to the selector, never a filter or join key.

### The selector

Settled by prototype against live `gemini-3.7-flash` (22/22 clean emits; the score-tie
geometry could not separate was resolved correctly in both directions on every repeat).

- The selector is a **filter, never a ranker**. Stored and displayed order is tier block
  first, then `SEMANTIC_SCORE` within a tier.
- One call per (trend, tier): the trend's name, short summary, and category/subcategory as
  labeled context; each candidate as `catalog_product_id` plus its embed doc (700-char
  cap) — the selector judges exactly the text retrieval matched on. Candidates are shown
  score-descending **without raw scores**: geometry stays out of judgement.
- One forced call of a shallow terminal emit tool (from the prototype):

  ```
  propose_product_selection
    outcome    "matched" | "no_match"
    picks      [] — up to {slots} of:
      catalog_product_id   string (echoed from the pool)
      reasoned_fit         "strong" | "partial" | "weak"
      rationale            one sentence, ≤25 words, operator-facing
    pool_note  one sentence on the pool as a whole
  ```

  `pool_note` lands on the header as `SELECTOR_NOTE`, giving the no-match state an
  operator-readable line.
- **Refusal is a first-class outcome** and strict: the same ritual in a different format is
  `partial`; an adjacent need in a different object is refused; sharing an ingredient,
  category, or vocabulary is not fit. The prompt states that most trends have no match and
  forbids filling space with least-irrelevant items.
- Call shape: **ungrounded** `gemini-3.7-flash` pinned as a code constant in the ecomm
  agent, forced-function mode locked to the emit tool, low thinking level, no temperature.
  The prompt is versioned as **`sourcing.selector` v1** in the prompt registry — versioned
  store plus telemetry, like every non-discovery lane. Born on the CRMA-726 target model
  and call-shape rules; nothing for that migration to touch.

### The multi-tier contract (specified, not built)

- A **tier** is one product catalog ranked by commercial preference — the ranking is what
  makes it a tier.
- Tiers compose by **top-up in preference order**: while total picks are under
  `MAX_SOURCED_PRODUCTS` (5) and a live lower tier exists, that tier is consulted — one
  retrieval and one selector call per consulted tier, never one call over a mixed pool.
  The selector's `{slots}` input is 5 minus picks already taken by higher tiers.
- The per-tier floor is **never relaxed to fill the quota**: the count triggers
  consultation, the floor gates entry, and a trend no catalog stocks returns nothing.
- Cross-tier `SEMANTIC_SCORE`s are never compared. Each consulted tier writes its **own
  header** — a single header per run would erase "our store was searched and stocked
  nothing", which is the buy-list query.

### Catalog sync and the CSV seed

- The sync is a **Cloud Run job** (`trend-tree-catalog-sync`, code under the fleet's
  services layout) in the shared GCP project, fired by a **daily Cloud Scheduler cron**
  running as the fleet runtime service account. It is not a Pipedream workflow — sourcing
  is the opposite data direction from ingestion.
- **Daily full sweep, diffed on an embed-doc hash** — no delta cursors. An unchanged
  product only touches `LAST_SEEN_AT`; only a changed embed doc re-embeds. Revisit
  trigger: a tier's catalog past ~2,500 products reopens delta sync.
- The Shopify read is the legacy REST product listing (accessible until 2027-04-16) with
  the extended field whitelist: title, handle, product type, vendor, tags, body HTML,
  status, image. Two shape gotchas: `body_html` is HTML and needs stripping; `tags` is a
  comma-separated string, not an array.
- **Embed doc v1** (Shopify tier, `EMBED_DOC_VERSION='v1'`):
  `title. Type: <type>. Vendor: <vendor>. Tags: <tags>. <body_html stripped, first 600
  chars>` — REST product-record fields only; `Type` is skipped when it holds the literal
  string `'0'` (a known store artifact).
- **CSV seed path (sanctioned)**: the catalog may be seeded from a Shopify admin CSV
  export ahead of the live sync — same embed doc, same handle key, `LAST_SEEN_AT` stamped
  with the export date. Seed rows graduate through the first live sweep as a normal sweep;
  nothing is re-keyed. The 2026-08-20 export (187 products, all active) is the seed corpus;
  its wholesale cost column never lands in Snowflake because the dimension stores no
  presentation fields. A manual re-export is the freshness lever until the token lands.
- **Freshness is guarded at the outcome layer only**: an audit-agent freshness row on the
  catalog's `MAX(LAST_SEEN_AT)` (YELLOW past 3 days, RED past 7) plus the ecomm agent
  **declining to source** against a catalog older than 7 days. No per-workflow registry
  entry, no GCP alert policy.

### Write path

- A single **`PROC_SOURCING_APPLY`** procedure appends header and candidate rows
  atomically, mirroring the enrichment apply proc: validation-first, returning a VARIANT
  receipt instead of raising. SQL stays out of the workflow JavaScript.

### Dashboard exposure

The dashboard dynamic table gains exactly three columns, from the latest header per trend:

- `SOURCING_STATUS` — `COALESCE`d so a trend with no header reads `'not_sourced'`, never
  NULL.
- `SOURCED_PRODUCTS` — an ordered array of the **selected** items only, frozen identity
  plus the `_AT_MATCH` snapshot, same idiom as the existing nearest-content column.
  Rejected candidates stay out of the dashboard; they are calibration data, queried from
  the ledger.
- `SOURCED_AT` — the header timestamp, so staleness is visible.

The 15-minute dynamic-table lag is inherited and accepted.

### Cost telemetry

- One `STG_AGENT_RUN_COSTS` row per ecomm-agent run, correlated by the header's
  `AGENT_SESSION_ID`. **Writing it is a requirement of the run, not best-effort — the row
  is written on failure too.** (Roughly half of enrichment runs historically skipped it;
  that habit is not the model.) The header stays the consumer-readable half:
  `STG_AGENT_RUN_COSTS` is out of `insights-agent`'s reach by design.
- Measured scale: selector calls cost ~$0.0013–0.0032 each at 1–2.4 s; the full 443-trend
  backfill projects to ~95 non-empty pools ≈ $0.15. Steady state is noise.

### Provisioning (prerequisites, some pending)

- **Shopify Admin API token** — parked on CRMA-747, expected week of 2026-08-24. Lands in
  Secret Manager as `trend-tree-shopify-token`; a staged wizard mints it (custom app,
  `read_products` + `read_product_listings`, own rate-limit bucket). A Cloud Run copy is
  mounted only if live hydration ever lands on the ecomm agent (unlikely — presentation
  fields are hydrated by the consumer, not the ecomm agent, per the write path above).
- **Cloud Scheduler cron** for the sync job (CRMA-777) and the ecomm-agent poll (CRMA-778),
  plus job-run permission for the runtime service account — self-service as of the
  2026-08-20 probe.
- The CSV seed removes the token from the build's critical path: everything except the
  live sync job and live hydration proceeds now.
- **New for the ecomm agent's Cloud Run move**: an Artifact Registry image (`mcc` repo,
  `mcc-crm-automations`/`us-east4`, per CRMA-437), the Cloud Run service itself, and one
  `run.invoker` binding for the ecomm agent's own caller identity (poller + manual fires) —
  distinct from the existing `trend-tree-pipedream-caller@` SA, which exists only for
  Pipedream-originated calls. This is the same kind of one-time admin ask CRMA-441 made for
  the enrichment-agent migration; unlike that ask, execution can start (build, dark-deploy,
  smoke test) before it lands, and only *promoting* traffic + wiring the Cloud Scheduler
  poller wait on it.

## Testing Decisions

A good test exercises external behavior at a seam — inputs in, decisions out — and never
implementation details. Two code seams, both at the repo's existing extracted-helper
pattern (pure `.mjs` modules under `agents/lib/`, `node:test`, run by the existing lib test
script; `promotion_gate.test.mjs` is the prior art):

1. **The sourcing-run core** (`services/lib/`, per CRMA-439's GCP shared-module home —
   see the Trigger section above): one pure function from (trend context, ranked candidate
   pool, selector emit) to the ledger write plan. Fixture-tested with a faked Gemini
   response — no network, no Snowflake. Covers: floor and TOP_N application,
   slots-remaining cap, tier top-up order, the three-state header, strict emit validation
   (picks ⊆ shown pool, enum grades, rationale length), freshness decline, and the
   running-header staleness rule.
2. **The catalog-sweep transform** (in the sync job's module): one pure function from
   (fetched catalog rows — REST page or CSV seed rows, both normalized into it — plus the
   dimension's current handle→hash/status state) to the upsert/delist plan and the list of
   docs to (re)embed. Covers embed doc v1 construction (HTML strip, 600-char cap,
   `Type='0'` skip, tags parsing), hash diffing, soft-delist, and seed/live convergence on
   the same key.

SQL — the DDL, the poll anti-join, the retrieval query — is verified the way this repo
verifies SQL: rows landed in the target table for a fired run, plus a SQL test file for
the poll and retrieval queries following the existing connections-test prior art. The
selector prompt itself is validated by the prototype's recorded evidence and regression-
checked by replaying its seven contract cases when the prompt version bumps.

## Out of Scope

- **Building any second tier** (Amazon or otherwise), including reviving the dormant
  Amazon ingestion scraper. The contract is specified; only Shopify is implemented.
- **The KDML / external discovery API** — Marcelo's separate track.
- **The published collection-page surface** — the Decision Page is the only consumer
  designed for.
- **Reusing the MiniLM embedding model** from `insights-agent` — the pipeline migrated off
  it; one embedding space.
- **Delta sync and GraphQL** — the daily full sweep suffices below ~2,500 products; a
  future embed-doc version that needs metafields or collection membership reopens this.
- **Re-sourcing on catalog restock** — products refresh only when a trend is re-enriched;
  a periodic re-sweep is additive, deliberately deferred.
- **Real-time alerting for the sync job** beyond the audit agent's freshness row.

## Further Notes

- The map's Standing constraints and Established facts (in
  `docs/wayfinder/trend-to-product-sourcing.md`) carry the full evidence trail: measured
  catalog shape, calibration data, selector prototype readout with the verbatim v1 prompt,
  and every rejected alternative with its reasoning.
- One question remains open with Marcelo (from the read-path research): whether the
  Decision Page hydrates price/image live or reads the frozen snapshots. The schema
  deliberately does not wait — the `_AT_MATCH` columns cost three columns and unblock
  either answer.
- The store's catalog stocks no SPF or sun-care product, so the handoff's worked example
  ("brush-on mineral SPF powder") is unrunnable against this catalog; the prototype's
  seven contract cases are the reference examples instead.
- Coordinate with the fleet model-allocation map (CRMA-726) if the selector's model pin
  ever changes; it is currently born conformant.
- Legacy REST product endpoints are frozen surfaces, accessible until 2027-04-16 — the
  sync carries that expiry as a known horizon.
