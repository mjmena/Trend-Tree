<!-- Title: Where the Signals Come From -->
<!-- Parent: ATLAS Dashboard -->

# Where the signals come from

The pipeline knows about 15 sources today, of which roughly 10 are actively ingesting at any moment (a few are paused or intermittent — flagged per-source below). The sources fall into two functional buckets:

- **Direct platform sources** are integrations that pull from a single platform's public API or feed. These are canonical — every signal is verifiable end-to-end against the source.
- **Discovery agents** are LLMs that proactively search the public web for emerging themes every 2 hours. They return URLs we post-verify before ingesting; some signals are filtered out before they reach the trend. _LLM-mediated, with post-verification._

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

- **What it is** — GDELT (Global Database of Events, Language, and Tone) — a news-monitoring index covering thousands of publishers worldwide.
- **Provides** — News articles tagged by theme, location, sentiment.
- **Cadence** — _TODO: confirm current cadence (15-min default, may be throttled)_
- **Publisher** — Extracted from `METADATA:domain` per article; many publishers (NYT, WaPo, BBC, etc.).
- **Reliability** — Canonical.
- **Notes** — Requires a `User-Agent` header (default node-fetch UA gets dropped silently); some IP-based rate limiting in effect.

### `google_trends_explore`

- **What it is** — Google Trends "Explore" data — search interest curves for specific terms.
- **Provides** — Interest scalars and trending-search-by-region.
- **Cadence** — Periodic — _TODO: confirm cadence_
- **Publisher** — Always `trends.google.com`.
- **Reliability** — Canonical.
- **Notes** — A separate `gtrends-poller` workflow pulls per-trend interest curves daily (this feeds [`KEY_DATA_POINTS`](fields/key-data-points.md)).

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
- **Cadence** — _TODO: confirm — the batch ingester was retired in late April 2026; historical data is preserved in `FCT_SIGNALS` but new ingestion may be paused. Mark active vs historical._
- **Publisher** — Always `wikipedia.org`.
- **Reliability** — Canonical.

### `tiktok`

- **What it is** — TikTok trending signals.
- **Provides** — Trending video / sound signals.
- **Cadence** — _TODO: confirm_
- **Publisher** — Always `tiktok.com`.
- **Reliability** — Canonical, with shape caveats — _TODO: confirm whether the TikTok ingester is currently routing to the test table or to live (it was paused in April 2026 pending shape fixes)_.

### `pinterest`

- **What it is** — Pinterest trending pins / boards.
- **Provides** — Trending content from Pinterest.
- **Cadence** — _TODO: confirm_
- **Publisher** — Always `pinterest.com`.
- **Reliability** — Canonical, with same caveats as TikTok — _TODO: confirm active vs paused_.

---

## Discovery agents

### `agent_gemini_discovery`, `agent_grok_discovery`, `agent_chatgpt_discovery`

- **What it is** — Three discovery agents — Gemini 3.1 Pro, Grok, and ChatGPT — each proactively searching the public web for emerging themes every 2 hours. Each runs independently (separate cron triggers, separate prompts) so we can tune them in isolation.
- **Provides** — Discovered URLs with category tags and short justifications.
- **Cadence** — Every 2 hours per agent (sharded by vertical for Gemini — see below).
- **Publisher** — Extracted from the URL's `METADATA:canonical_url`. Many publishers; depends on what each agent surfaces. Vertex grounding-redirect URLs (`vertexaisearch.cloud.google.com/...`) resolve to `NULL` publisher and drop out of [`DISTINCT_PUBLISHER_COUNT`](fields/distinct-publisher-count.md).
- **Reliability** — **LLM-mediated, with post-verification.** Each returned URL is post-verified for resolvability before being ingested; some signals are filtered out before they reach a trend.

### `gemini_food_drink`, `gemini_other`, `gemini_travel`, `gemini_wellness`

- **What it is** — Vertical-sharded Gemini discovery agents. Each instance targets a single category (Food & Drink, Wellness, Travel, "other") so prompts can be tuned per vertical.
- **Provides** — Same shape as the generic agent_*_discovery sources, but scoped to one vertical.
- **Cadence** — Every 2 hours.
- **Publisher** — From `METADATA:source_name`.
- **Reliability** — Same as discovery agents above.

### `grok_live`

- **What it is** — Grok's live search API, used to pull real-time X (Twitter) content during enrichment.
- **Provides** — Social-platform signals grounded via Grok's search.
- **Cadence** — Called on demand by the enrichment agent.
- **Publisher** — Always `x.com`.
- **Reliability** — LLM-mediated.

---

← Back to [hub](index.md)
