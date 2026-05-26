# Trend-Tree

McClatchy's data pipeline that ingests cultural signals, identifies trends, and surfaces them on the **ATLAS** dashboard in the Insights Agent for marketing strategists and content teams.

## Language

**ATLAS**:
The main trend dashboard UI in the Insights Agent — the trend list / trend cards view. The audience for `docs/dashboard-explainability.md`.
_Avoid_: "trend dashboard" (ambiguous with `DT_TREND_DASHBOARD`), "Insights Agent dashboard" (the Insights Agent has multiple UI surfaces — Predictions Queue, Collections, Decision Page — not all of them are ATLAS).

**DT_TREND_DASHBOARD**:
The Snowflake dynamic table (`MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD`) that ATLAS queries. One row per trend; 15-minute refresh lag.
_Avoid_: "the dashboard view" (V_TREND_DASHBOARD was dropped 2026-04-28; this is now a dynamic table).

**Signal**:
One individual data point ingested into the pipeline. Has exactly one source and (usually) one publisher. Stored in `FCT_SIGNALS`.

**Source**:
The integration / workflow that brought a signal into the pipeline. The name in `FCT_SIGNALS.SOURCE_NAME` — e.g., `bluesky`, `gdelt`, `google_trends_explore`, `amazon_trends`, `gemini_food_drink`, `agent_gemini_discovery`. ~14 distinct values today. Subdivided into two kinds:
- **Direct platform source** — we ingest passively from a single platform's API or feed. Canonical, verifiable end-to-end (`bluesky`, `gdelt`, `google_trends_explore`, `amazon_trends`, `wikimedia`, `tiktok`, `pinterest`).
- **Discovery agent** — an LLM proactively searches the public web and returns URLs we post-verify before ingest. Some signals are filtered out before reaching the trend (`agent_gemini_discovery`, `agent_grok_discovery`, `agent_chatgpt_discovery`, `gemini_food_drink`/`other`/`travel`/`wellness`, `grok_live`).

_Avoid_: "platform" (too vague — could mean source or publisher), "ingestion source" (just say "source").

**Publisher**:
The actual website or property a signal originates from — e.g., `nytimes.com`, `vox.com`, `bsky.app`, `wikipedia.org`. Extracted from the signal's metadata. **What `DISTINCT_PUBLISHER_COUNT` actually counts** — four GDELT articles from four publishers count as 4, not 1.
_Avoid_: "domain" in user-facing copy (technically synonymous but feels technical); "outlet" (used for paid-media in other McClatchy contexts).

## Flagged ambiguities

**`DISTINCT_SOURCE_COUNT` is misnamed.** The column counts distinct **publishers**, not sources. Canonical replacement `DISTINCT_PUBLISHER_COUNT` was added to `DT_TREND_DASHBOARD` on 2026-05-26 as a sibling alias (same value, new name), following the `VELOCITY_DIRECTION` / `LIFECYCLE_STATUS` pattern. The legacy `DISTINCT_SOURCE_COUNT` is kept for back-compat. Prefer `DISTINCT_PUBLISHER_COUNT` in any new query or display; the Insights Agent UI migrates from the legacy name when convenient.

**"Trend" vs "candidate".** A *candidate* is a `STG_TREND_CANDIDATES` row proposed by the distillation agent. A *trend* is a candidate after the promotion agent has accepted it (one `FCT_TRENDS` row + a `FCT_PROMOTION_LEDGER` entry). ATLAS only ever shows trends. Resolved here for the doc; if any term collisions arise during writing, refine.
