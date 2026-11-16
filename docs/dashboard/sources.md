<!-- Title: Where the Signals Come From -->
<!-- Parent: ATLAS Dashboard -->

# Where the signals come from

The pipeline knows about ~14 sources today; several are paused, retired, or on-demand (flagged per-source below). The sources fall into three functional buckets:

- **Direct platform sources** are integrations that pull from a single platform's public API or feed. These are canonical — every signal is verifiable end-to-end against the source.
- **Discovery agents** are LLMs that proactively search the public web for emerging themes every 2 hours. They return URLs we post-verify before ingesting; some signals are filtered out before they reach the trend. _LLM-mediated, with post-verification._
- **Agent search tools** (e.g. `grok_live`, `search-gdelt`) are on-demand search tools the distillation and enrichment agents call while reasoning about a specific cluster or trend. They don't run on a schedule.

---

## Direct platform sources

### `bluesky`

- **What it is** — Real-time public posts from the Bluesky social network.
- **Provides** — Original posts and engagement signals.
- **Cadence** — Streamed continuously.
- **Publisher** — Always `bsky.app` (single-platform).
- **Reliability** — Canonical.
- **Notes** — High signal volume; ideal for early cultural pattern detection.

### `gdelt`

- **What it is** — GDELT (Global Database of Events, Language, and Tone) — a news-monitoring index covering thousands of publishers worldwide. The **passive GDELT batch ingester was retired 2026-04-26**; `gdelt` rows now come **only** from the `search-gdelt` agent search tool.
- **Provides** — News articles tagged by theme, location, sentiment.
- **Cadence** — On-demand — called by the distillation and enrichment agents, not on a fixed schedule.
- **Publisher** — Extracted from `METADATA:domain` per article; many publishers (NYT, WaPo, BBC, etc.).
- **Reliability** — Canonical.
- **Notes** — Requires a `User-Agent` header (default node-fetch UA gets dropped silently); some IP-based rate limiting in effect.

### `google_trends_explore`

- **What it is** — Google Trends "Explore" data — search interest curves for specific terms.
- **Provides** — Interest scalars and trending-search-by-region.
- **Cadence** — Periodic — _TODO: confirm cadence_
- **Publisher** — Always `trends.google.com`.
- **Reliability** — Canonical.
- **Notes** — The separate `gtrends-poller` workflow that pulled per-trend interest curves daily was removed on 2026-09-25 (CRMA-1313). [`KEY_DATA_POINTS`](fields/key-data-points.md) is now always empty.

### `google_trends_rss`

- **What it is** — Google Trends "trending now" RSS feed (US): the searches surging right now and the news articles Google attaches to them.
- **Provides** — One signal per linked article.
- **Cadence** — Every 15 minutes (the feed updates about every 10 minutes).
- **Publisher** — The article's own domain.
- **Reliability** — Canonical.

### `amazon_trends`

- **What it is** — Amazon trending product / search data.
- **Provides** — Trending product signals from Amazon.
- **Cadence** — Periodic — _TODO: confirm_
- **Publisher** — Always `amazon.com`.
- **Reliability** — Canonical (with aggregation — see "Notes").
- **Notes** — Signals are aggregated upstream (Amazon raw output isn't 1:1 with our `FCT_SIGNALS` rows). For aggregated signals, the `SIGNAL_ID` is a pseudo-URL — guard with an `http(s)://` check before rendering as a link.

### `wikimedia`

- **What it is** — Wikipedia pageview signals.
- **Provides** — Pageview spikes for Wikipedia articles.
- **Cadence** — Not currently ingesting — the passive batch ingester was retired in late April 2026. Historical data is preserved in `FCT_SIGNALS`.
- **Publisher** — Always `wikipedia.org`.
- **Reliability** — Canonical.

### `tiktok`

- **What it is** — TikTok short videos found through Google search (SerpApi `google_short_videos`, restricted to tiktok.com). Runs as the Cloud Run job `trend-tree-tiktok-ingest` since 2026-09-28. The old Creative Center scraper was scrapped on 2026-06-09 and stays off.
- **Provides** — One signal per video whose title names something specific. The job searches 24 fixed one-word seeds (4 for each of 6 verticals, e.g. `skincare`, `snack`, `dupe`) over the past day, at most 50 searches a run. A Gemini 3.7 Flash filter drops vague titles before anything is written.
- **Cadence** — Once a day, 09:00 UTC. The daily audit flags the source if no new rows land within about 25 hours.
- **Publisher** — Always `tiktok.com`.
- **Reliability** — Canonical: every signal is a real video URL. Search-mediated, so coverage depends on what Google returns for the seed words.

### `pinterest`

- **What it is** — Pinterest trending pins / boards.
- **Provides** — Trending content from Pinterest.
- **Cadence** — Paused. The ingestion workflow is inactive; historical rows are preserved in `FCT_SIGNALS`.
- **Publisher** — Always `pinterest.com`.
- **Reliability** — Not currently ingesting.

---

## Discovery agents

### `agent_gemini_discovery`, `agent_grok_discovery`, `agent_chatgpt_discovery`

- **What it is** — Three discovery agents — Gemini, Grok, and ChatGPT (each agent's model version is set in its prompt row) — each proactively searching the public web for emerging themes every 2 hours. Each runs independently (separate cron triggers, separate prompts) so we can tune them in isolation.
- **Provides** — Discovered URLs with category tags and short justifications.
- **Cadence** — Every 2 hours per agent (plus the separate `gemini_other` agent — see below).
- **Publisher** — Extracted from the URL's `METADATA:canonical_url`. Many publishers; depends on what each agent surfaces. Vertex grounding-redirect URLs (`vertexaisearch.cloud.google.com/...`) resolve to `NULL` publisher and drop out of [`DISTINCT_PUBLISHER_COUNT`](fields/distinct-publisher-count.md).
- **Reliability** — **LLM-mediated, with post-verification.** Each returned URL is post-verified for resolvability before being ingested; some signals are filtered out before they reach a trend.

### `gemini_other` (and the retired `gemini_food_drink`, `gemini_travel`, `gemini_wellness`)

- **What it is** — A vertical-scoped Gemini discovery agent for the "other" category. The food & drink, travel and wellness shards no longer run; their historical rows are preserved in `FCT_SIGNALS`.
- **Provides** — Same shape as the generic agent_*_discovery sources, but scoped to one vertical.
- **Cadence** — Every 2 hours.
- **Publisher** — From `METADATA:source_name`.
- **Reliability** — Same as discovery agents above.

---

## Editorial nominations

### `editorial`

- **What it is** — URLs a person attaches when nominating a trend from ATLAS (live since 2026-10-26). The endpoint fetches each URL once and drops only dead or malformed ones.
- **Provides** — One signal per kept URL. The nomination either becomes a new trend (`TREND_ORIGIN = 'EDITORIAL'`) or, when it describes a trend that already exists, adds its signals to that trend.
- **Cadence** — Not scheduled; arrives when someone nominates.
- **Publisher** — The URL's own domain.
- **Reliability** — Human-selected. A nomination skips the structural gate and the promotion judgment.

---

## Agent search tools

These are **not** discovery agents — they're on-demand search tools the distillation and enrichment agents call while reasoning about a specific cluster or trend. They don't run on a cron; they fire only when an agent invokes them.

### `grok_live`

- **What it is** — Grok's live search API, an agent search tool. **X-only since 2026-05-28** — it pulls real-time X (Twitter) content.
- **Provides** — Social-platform signals grounded via Grok's search.
- **Cadence** — Called on demand by the distillation and enrichment agents (not on a schedule).
- **Publisher** — Always `x.com`.
- **Reliability** — LLM-mediated.

---

← Back to [hub](index.md)
