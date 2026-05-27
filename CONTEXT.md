# Trend-Tree

McClatchy's data pipeline that ingests cultural signals, identifies trends, and surfaces them on the **ATLAS** dashboard in the Insights Agent for marketing strategists and content teams.

## Language

**ATLAS**:
The main trend dashboard UI in the Insights Agent — the trend list / trend cards view. The audience for `docs/dashboard/`.
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

**Link kind**:
The provenance of a `FCT_TREND_SIGNALS` row attaching a signal to a trend — either `'supporting'` (the signal underwrote the candidate that became this trend; written by `TASK_PROMOTE_TREND_SIGNALS` from `STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS` once per promotion/dedup) or `'attributed'` (written later by `lifecycle-attribution-subagent-p_PACe77B` when a newly-arrived signal is semantically matched into an existing trend at lifecycle-sweep time). **Mutually exclusive per `(trend_id, signal_id)` pair** — `'supporting'` always wins, because the attribution agent's NOT EXISTS guard ignores `LINK_KIND` and skips any pair already linked. The two kinds have very different freshness profiles: supporting is spiky and gated on promotions firing; attributed is steadier and gated on the lifecycle sweep cron.
_Avoid_: `'evidence'` — documented as a planned third kind in `sql/fct_trend_signals.sql:9-33` but never implemented. The enrichment agent's typed citation pool lives in `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:evidence`, not in the link table; the lifecycle-attribution agent replaced the original "enrichment-writes-evidence" plan.

**Trend topic**:
The trend's identity string — the LLM-coined prose name a strategist reads on ATLAS (e.g., "Curated Clutter Revival"). Lives in `FCT_TRENDS.TREND_TOPIC`. **Identity** — frozen at promotion, never re-derived, audience is humans.
_Avoid_: "trend name" (the dashboard column is `TREND_TOPIC`; "name" is also overloaded with enrichment-emitted audience names).

**Gtrends search keyword**:
The 2–4 word query the gtrends-poller submits to Google Trends to compute a trend's `INTEREST_PEAK_PCT`. Lives in `FCT_TRENDS.GTRENDS_KEYWORD`. **Mutable lookup helper** — not identity. Set at promotion via Cortex `mistral-large2` for cost reasons, but may be re-derived later if it's returning empty timeseries. Audience is the Google Trends API, not humans.
_Avoid_: conflating with [trend topic] — they share an origin column at promotion time but are conceptually distinct. The trend topic is descriptive prose for marketers; the search keyword is a consumer-vernacular query string for a machine.

## Flagged ambiguities

**`DISTINCT_SOURCE_COUNT` is misnamed.** The column counts distinct **publishers**, not sources. Canonical replacement `DISTINCT_PUBLISHER_COUNT` was added to `DT_TREND_DASHBOARD` on 2026-05-26 as a sibling alias (same value, new name), following the `VELOCITY_DIRECTION` / `LIFECYCLE_STATUS` pattern. The legacy `DISTINCT_SOURCE_COUNT` is kept for back-compat. Prefer `DISTINCT_PUBLISHER_COUNT` in any new query or display; the Insights Agent UI migrates from the legacy name when convenient.

**"Trend" vs "candidate".** A *candidate* is a `STG_TREND_CANDIDATES` row proposed by the distillation agent. A *trend* is a candidate after the promotion agent has accepted it (one `FCT_TRENDS` row + a `FCT_PROMOTION_LEDGER` entry). ATLAS only ever shows trends. Resolved here for the doc; if any term collisions arise during writing, refine.

**`FCT_TRENDS` is mostly-but-not-entirely identity.** CLAUDE.md describes it as "slim, immutable, identity (13 cols)" after the 2026-04-28 agent-owned-ledgers refactor. That's true of most columns (`TREND_ID`, `CANDIDATE_ID`, `TREND_TOPIC`, `DETECTED_AT`, `PROMOTED_AT`), but `GTRENDS_KEYWORD` is a **mutable lookup helper** that sits on the same table for convenience (cheap to set once at promotion, no separate writer to maintain). Re-deriving it does not violate trend identity. If more mutable helpers accrue on `FCT_TRENDS` they should be called out the same way, or the column should move to a dedicated mutable table.

**Empty `INTEREST_OVER_TIME` array ≠ low search volume.** Google Trends Explore returns empty `timelineData` for *both* "this keyword genuinely has insufficient search data" *and* "you look like a bot, here is a silent rate-limit response." The poller's `INTER_TREND_SLEEP_MS = 3_000` comment in `gtrends-poller-p_13CN9KG/fetch_and_compute/entry.js:16` is the only place that fact is encoded today. Diagnosing GT poller failures requires probing the same keyword in the GT UI (browser, residential IP) before concluding the keyword is the problem — confirmed 2026-05-27 when `Korean spicy ramen` returned strong data in the UI but 8/9 empty days from the poller.

**`INTEREST_PEAK_PCT` is always 100 when non-empty.** Google Trends normalizes single-keyword timeseries so the highest point of the returned curve equals 100 by definition — that's the GT normalization convention, not a measurement. `FCT_TREND_GTRENDS_DAILY.INTEREST_PEAK_PCT` is therefore a *binary* indicator (`100` = "any data," `0` = "empty/blocked"), not a continuous one. **`INTEREST_AVG_PCT` is the continuous measure** — captures sustained interest vs single spike. The lifecycle subagent's `external_factor` switched from peak to avg on 2026-05-27 (`lifecycle-subagent-p_gYC562o/run_subagent/entry.js:255-265`); any new consumer of GT data should likewise prefer avg unless they explicitly want the binary "did the poll succeed" signal.
