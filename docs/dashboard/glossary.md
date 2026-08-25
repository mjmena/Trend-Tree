<!-- Title: Glossary -->
<!-- Parent: ATLAS Dashboard -->

# Glossary

The terms below are the ones a reader needs to make sense of this documentation. The canonical glossary for the project (for engineers / Claude) lives in [`CONTEXT.md`](../../CONTEXT.md) at the repo root.

| Term | Meaning |
|---|---|
| **ATLAS** | The main trend dashboard UI in the Insights Agent — the trend list / trend cards view. The audience for this document. |
| **Trend** | A cultural pattern our pipeline identified, named, and tracked. One row per trend in `FCT_TRENDS`. ATLAS only ever shows trends. |
| **Candidate** | A potential trend proposed by the distillation agent but not yet promoted. Lives in `STG_TREND_CANDIDATES`. ATLAS does **not** show candidates. |
| **Signal** | One individual data point ingested into the pipeline (a news article, a Bluesky post, a Google Trends curve). Stored in `FCT_SIGNALS`. |
| **Source** | The integration that brought a signal into the pipeline — `bluesky`, `gdelt`, `google_trends_explore`, `agent_gemini_discovery`, etc. ~14 distinct sources today. **Unrelated to product sourcing** — see the note below this table. |
| **Publisher** | The actual website a signal originates from — `nytimes.com`, `vox.com`, `bsky.app`. **What `DISTINCT_PUBLISHER_COUNT` counts.** |
| **Direct platform source** | A source we ingest passively from a single platform's API — canonical, verifiable end-to-end. |
| **Discovery agent** | An LLM that proactively searches the public web and returns URLs we post-verify before ingest. Some signals are filtered out before reaching a trend. |
| **Enrichment payload** | The narrative + names + category + evidence the enrichment agent emits for one trend. Stored in `FCT_TREND_ENRICHMENT_LEDGER`. |
| **EWMA** | Exponentially-weighted moving average. The technique used to smooth `HEAT_INDEX` so single-cycle noise doesn't move the displayed number. |
| **Ledger** | An append-only table that records every decision a given agent has made. The current state of a trend is the latest row per `TREND_ID`. Most agents own one ledger; the ecomm agent owns two — a header ledger of runs and a detail table of the products each run considered. |
| **Product sourcing** | Matching a trend to products in a commerce catalog that we could sell against it. Produces `SOURCING_STATUS` / `SOURCED_PRODUCTS` / `SOURCED_AT`. |
| **Ecomm agent** | The service that performs product sourcing. It runs every 15 minutes over a batch of live trends, independently of enrichment. |
| **Sourcing run** | One attempt to match one trend to products. Its outcome becomes that trend's `SOURCING_STATUS`. A trend can be sourced many times; the card always shows the latest run. |
| **Candidate product** | A product the ecomm agent retrieved and showed to itself for judgement. Rejected candidates are kept as tuning evidence and never reach a card. Not to be confused with **Candidate** above, which is a proposed trend. |
| **Semantic score** | How close a product sits to a trend in vector space, 0–1. Reproducible geometry, not an opinion. |
| **Reasoned fit** | The ecomm agent's verdict on whether a shopper would accept a product for this trend — `strong` / `partial` / `weak`. An opinion, deliberately kept separate from the semantic score. |
| **Tier** | Which catalog a product came from. `shopify` is the only tier live today. |

**"Source" and "sourcing" are different things.** A **source** is where a signal came from — a platform or a publisher. **Product sourcing** is matching a trend to sellable products. `DISTINCT_SOURCE_COUNT` counts publishers and has nothing to do with `SOURCING_STATUS`. The repo's "🟡 Migrating Fields — Data Sourcing" page is about data provenance, and is a third unrelated use of the word.

---

← Back to [hub](index.md)
