# Glossary

The terms below are the ones a reader needs to make sense of this documentation. The canonical glossary for the project (for engineers / Claude) lives in [`CONTEXT.md`](../../CONTEXT.md) at the repo root.

| Term | Meaning |
|---|---|
| **ATLAS** | The main trend dashboard UI in the Insights Agent — the trend list / trend cards view. The audience for this document. |
| **Trend** | A cultural pattern our pipeline identified, named, and tracked. One row per trend in `FCT_TRENDS`. ATLAS only ever shows trends. |
| **Candidate** | A potential trend proposed by the distillation agent but not yet promoted. Lives in `STG_TREND_CANDIDATES`. ATLAS does **not** show candidates. |
| **Signal** | One individual data point ingested into the pipeline (a news article, a Bluesky post, a Google Trends curve). Stored in `FCT_SIGNALS`. |
| **Source** | The integration that brought a signal into the pipeline — `bluesky`, `gdelt`, `google_trends_explore`, `agent_gemini_discovery`, etc. ~14 distinct sources today. |
| **Publisher** | The actual website a signal originates from — `nytimes.com`, `vox.com`, `bsky.app`. **What `DISTINCT_PUBLISHER_COUNT` counts.** |
| **Direct platform source** | A source we ingest passively from a single platform's API — canonical, verifiable end-to-end. |
| **Discovery agent** | An LLM that proactively searches the public web and returns URLs we post-verify before ingest. Some signals are filtered out before reaching a trend. |
| **Enrichment payload** | The narrative + names + category + evidence the enrichment agent emits for one trend. Stored in `FCT_TREND_ENRICHMENT_LEDGER`. |
| **EWMA** | Exponentially-weighted moving average. The technique used to smooth `HEAT_INDEX` so single-cycle noise doesn't move the displayed number. |
| **Ledger** | An append-only table that records every decision a given agent has made. Each agent owns exactly one ledger; the current state of a trend is the latest row per `TREND_ID`. |

---

← Back to [hub](index.md)
