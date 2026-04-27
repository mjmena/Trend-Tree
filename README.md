# Trend Tree

A GitHub-synced [Pipedream](https://pipedream.com) project that distills consumer trends from a daily firehose of signals (news headlines, Bluesky posts, Amazon movers, Google Trends, TikTok hashtags, etc.) and writes them to Snowflake for downstream brand-fit analysis.

This README captures the **roadmap and current state**. Operational gotchas and per-workflow details live in [`CLAUDE.md`](CLAUDE.md).

---

## The 4-layer mental model

```
  ┌──────────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────────┐
  │  INGESTION   │ →  │ DISTILLATION│ →  │ ENRICHMENT  │ →  │  LIFECYCLE   │
  │              │    │             │    │             │    │              │
  │  raw signals │    │ noun-verb   │    │ B2B/B2C     │    │ refresh /    │
  │  → STG_      │    │ trends →    │    │ naming,     │    │ retire /     │
  │  EXTERNAL_   │    │ FCT_TRENDS  │    │ category,   │    │ split /      │
  │  SIGNALS     │    │ via         │    │ vibe shift, │    │ merge        │
  │              │    │ promotion   │    │ social proof│    │              │
  └──────────────┘    └─────────────┘    └─────────────┘    └──────────────┘
        ✅                  ✅                  ✅                  ⏸
      SHIPPED            SHIPPED             SHIPPED            DEFERRED
```

Layers 1–3 are all live as agentic redesigns. Layer 4 (Lifecycle) is the only one still in static-SQL form and is the next agent redesign on deck.

The trend pipeline runs synchronously per promoted trend:

```
discovery agents (cron, every 2h) → STG_EXTERNAL_SIGNALS
                                       ↓
                             distillation lead/subagent
                                       ↓ (proposes candidates)
                              STG_TREND_CANDIDATES_AGENT
                                       ↓
                              promotion agent evaluates
                                       ↓ PROC_PROMOTION_APPLY
                              FCT_TRENDS  ←  canonical trend table
                                       ↓ promotion's fire_enrichment_chain
                              dispatcher (HTTP per trend)
                                       ↓
                       sources → enrichment → write
                                       ↓
                              DIM_TREND_ENRICHMENT
                                       ↓
                              DT_TREND_DASHBOARD (upstream surface)
```

---

## Workflow inventory

Grouped by role. Workflow IDs in headers; click each for the source.

### Orchestration & persistence

| Workflow | Role |
|---|---|
| [`dispatcher-p_8rCBgnl`](dispatcher-p_8rCBgnl/) | Stateless HTTP-only chain runner. Takes `{trend_id}` and fires `sources` → `enrichment` → `write` synchronously. (Cron-poll trigger retired with the queue layer 2026-04-27.) |
| [`sources-p_7NCy36w`](sources-p_7NCy36w/) | For one trend, generates search terms + fetches per-source metrics → `FCT_TREND_SOURCE_METRICS`. |
| [`enrichment-p_xMC995w`](enrichment-p_xMC995w/) | **Phase 3 — single Sonnet 4.6 agent loop.** Replaces the legacy 3-LLM cascade. Live cultural grounding via Bluesky/GDELT/Grok; 4-layer naming refinement (interleaved thinking + tool loop + in-prompt critique + post-emission reviewer). |
| [`write-p_o7CWa2K`](write-p_o7CWa2K/) | Persists enrichment to `DIM_TREND_ENRICHMENT` + `FCT_TREND_ENRICHMENT_HISTORY`. |
| [`daily-digest-p_vQCkwgV`](daily-digest-p_vQCkwgV/) | Scheduled link-checker + LLM source-verifier → Braze email of the day's trend dashboard. |

### Discovery (LLM trend hypothesis generation)

| Workflow | Role |
|---|---|
| [`discovery-p_5VCPP3N`](discovery-p_5VCPP3N/) | Three LLMs (Gemini/Grok/ChatGPT) sharded across 6 verticals propose trend topics, Claude reranks + dedupes, URL HEAD-validate, write `agent_*_discovery` rows to `STG_EXTERNAL_SIGNALS`. Per-model crons run independently @ 2h each. |

### Distillation (signal → candidate)

| Workflow | Role |
|---|---|
| [`distillation-p_mkCBBqb`](distillation-p_mkCBBqb/) | Sonnet 4.6 lead agent pulls 24h of unclaimed signals, scans for noun-verb hypotheses, fans to subagents in parallel. (SQL Louvain bucketing retired 2026-04-27; agent works from raw signals + neighbors only.) |
| [`distillation-subagent-p_jmCjj3J`](distillation-subagent-p_jmCjj3J/) | Single-hypothesis investigator: tool-calls signal-lookup / dedup / search-ingest, returns a verdict. |

### Promotion (candidate → trend)

| Workflow | Role |
|---|---|
| [`promotion-p_xMC99jg`](promotion-p_xMC99jg/) | Pulls pending REAL_TREND candidates, applies HARD_GATE (cluster_size, source_families), dispatches each to the agent, applies via `PROC_PROMOTION_APPLY` → writes `FCT_TRENDS`. New `fire_enrichment_chain` step then POSTs each newly-promoted `trend_id` to the dispatcher. |
| [`promotion-agent-p_yKCmm9r`](promotion-agent-p_yKCmm9r/) | Per-candidate verifier; compares against neighboring active trends, returns PROMOTE_NEW / MERGE_INTO / DEFER / REJECT. |

### Ingestion (raw signal feeds → `STG_EXTERNAL_SIGNALS`)

All write URL-shaped `SIGNAL_ID`s via JS + `snowflake-sdk` direct connector (the registry SQL proxy 413's at ~256KB).

| Workflow | Role |
|---|---|
| [`ingestion/amazon-p_rvC71gN`](ingestion/amazon-p_rvC71gN/) | Scrapes Amazon Movers & Shakers across 6 departments; `SIGNAL_ID = https://www.amazon.com/dp/<ASIN>`. |
| [`ingestion/bluesky-p_V9CgV17`](ingestion/bluesky-p_V9CgV17/) | `searchPosts` against a fixed seed-term list (`sort=top`, 24h window, engagement-filtered). |
| [`ingestion/google-trends-p_3nC3xkk`](ingestion/google-trends-p_3nC3xkk/) | Google Trends RSS + related-queries pull. |
| [`ingestion/tiktok-p_yKCm9Am`](ingestion/tiktok-p_yKCm9Am/) | Playwright scrape of TikTok trending hashtags. |
| [`ingestion/pinterest-p_xMC9jR5`](ingestion/pinterest-p_xMC9jR5/) | Pinterest trending categories scrape. **`inactive: true`** — raw output didn't fit specificity rubric, deferred. |

### Ingestion tools (HTTP-callable, used by distillation + enrichment agents)

All four now persist results to `STG_EXTERNAL_SIGNALS` with `signal_kind` tagging (`enrichment_citation` when called from enrichment, default `discovery_signal` otherwise).

| Workflow | Role |
|---|---|
| [`ingestion/tools/search-bluesky-p_13CNNwP`](ingestion/tools/search-bluesky-p_13CNNwP/) | Ad-hoc Bluesky search. |
| [`ingestion/tools/search-gdelt-p_WxCppoa`](ingestion/tools/search-gdelt-p_WxCppoa/) | Ad-hoc GDELT news search. |
| [`ingestion/tools/search-google-trends-p_YyC88x8`](ingestion/tools/search-google-trends-p_YyC88x8/) | Ad-hoc Google Trends lookup. |
| [`ingestion/tools/grok-live-search-p_vQCkkGK`](ingestion/tools/grok-live-search-p_vQCkkGK/) | Grok live web search via xAI; **citations now persist** (added 2026-04-27). |

### Deactivated (kept in repo for rollback / reference)

| Workflow | State |
|---|---|
| [`llm-enrichment-p_YyC86Zo`](llm-enrichment-p_YyC86Zo/) | Legacy 3-LLM cascade enrichment. Replaced by `enrichment-p_xMC995w` 2026-04-27. |
| [`agents/audit-p_pWCwPyL`](agents/audit-p_pWCwPyL/) | Legacy SIGNAL_CHANGE/AVG_SIMILARITY anomaly detector. Retired with the SQL clustering pipeline 2026-04-27. |

---

## Roadmap

The 4-layer mental model maps to phases. Status as of 2026-04-27.

### ✅ Phase 1 — Distillation agent (shipped 2026-04-25)

Replaces the static SQL clustering's "what counts as a trend?" decision with a Sonnet 4.6 agent loop that's opinionated about specificity (rejects "wellness" / "AI" categories, demands noun-verb consumer behaviors).

Architecture: lead orchestrator + per-hypothesis subagent + 4 agent-callable HTTP tools wrapping source APIs. Canonical Anthropic loop runtime + tool catalog in [`agents/lib/`](agents/lib/), inlined into each step's `entry.js` per Pipedream packaging.

### ✅ Phase 2 — Ingestion + discovery layer (shipped 2026-04-26..27)

**Discovery:** 3-LLM ensemble (Gemini, Grok, ChatGPT) sharded across 6 verticals; Claude Sonnet 4.6 reranks + canonicalizes; per-model cron sources allow independent cadence tuning.

**Ingestion:** 5 platform feeds (4 active + Pinterest deferred) emitting URL-shaped `SIGNAL_ID` + per-source `METADATA`; `bluesky` queries `searchPosts?sort=top` with engagement filter; all upsert via `snowflake-sdk` direct TCP.

**Quality gates active in promotion:** `min_source_families >= 2` HARD_GATE; `agent_*_discovery` rows split per-LLM; `SOURCE_BREAKDOWN` computed in SQL at insert time (kills hallucinated source labels).

### ✅ Phase 3 — Enrichment agent (shipped 2026-04-27)

Replaces the legacy 3-LLM cascade ([`llm-enrichment-p_YyC86Zo`](llm-enrichment-p_YyC86Zo/)) with a single Sonnet 4.6 agent loop ([`enrichment-p_xMC995w`](enrichment-p_xMC995w/)).

**4-layer naming refinement:**
1. Interleaved thinking (intra-turn)
2. Tool loop with live cultural grounding (Bluesky/GDELT/Grok live search)
3. In-prompt 5-candidate-per-audience procedure with anti-cliché blocklist + corporate-media floor
4. Post-emission `run_name_reviewer` step (~$0.005 reviewer that emits alternates if score < 7)

**Schema additions to `DIM_TREND_ENRICHMENT`:** `CATEGORY_CONFIDENCE`, `LOW_CONFIDENCE_FLAG`, `SOCIAL_PROOF` (structured array with click-through URLs), `ORIGINALLY_SURFACED_AT`, `NAME_CANDIDATES_CONSIDERED` (audit trail), `NAME_REVIEWER`, `AGENT_TELEMETRY`. STEPPS dropped per dashboard direction; prediction score deferred.

**Empirical results across 9 sample trends:** 9/9 emit clean, all clear corporate-media floor (1 borderline caught + corrected by reviewer). Cost p95 ~$0.45/run.

Sample naming wins: legacy "Beef Tallow Glow-Up" → new **"Carnivore Beauty"** / reviewer alt **"Tallow & Tradition"**. Legacy "Your Daily Scoop of Creatine" → **"Grey Matter Gains"**.

### ✅ Phase 4.5 — FCT_TRENDS canonical, queue retired (shipped 2026-04-27)

Promoted `FCT_TRENDS` to the primary trend table. Retired `FCT_TREND_METRICS` writes (frozen at 324 legacy rows; future audit/lifecycle agent will triage). Eliminated `STG_ENRICHMENT_QUEUE` + `TASK_QUEUE_ENRICHMENT` cron-poll layer; promotion now fires the `sources → enrichment → write` chain directly per newly-promoted `trend_id` via `fire_enrichment_chain`.

Also retired in this phase: SQL Louvain bucketing in distillation (lead/subagent prompt v3 collapses OVERLAP/AGENT_ONLY/LOUVAIN_ONLY into a single procedure); audit workflow; per-bucket subagent prompt fragments. Louvain infrastructure (`proc_cluster_trends`, `dt_external_trend_embeddings`) preserved for possible future on-demand tool use.

`DT_TREND_DASHBOARD` rebuilt as `UNION ALL` of `FCT_TRENDS` (canonical) + `FCT_TREND_METRICS` (legacy) so dashboard has 336 rows during the transition.

### ⏸ Phase 4 — Lifecycle agent (deferred)

**Current state:** static SQL — `v_trend_lifecycle.sql` (refresh / retire decisions on time thresholds). `proc_split_trend.sql` and `proc_dedup_trends.sql` retired 2026-04-27 because the distillation agent now handles split/dedup decisions at proposal time.

**Planned redesign:** periodic Sonnet 4.6 agent reasoning over the active trend portfolio, deciding refresh / retire / split / merge with semantic context (was this trend seasonal? does the merged result lose a sub-narrative? is the split commercially viable?). First job for the lifecycle agent: triage the 324 frozen `FCT_TREND_METRICS` rows.

---

## Operating reference

| What | Where |
|---|---|
| Per-workflow gotchas | [`CLAUDE.md`](CLAUDE.md) |
| Distillation lead trigger | `https://eo8lg4tmkchk2qc.m.pipedream.net` (POST `{"dry_run": false}`) |
| Distillation subagent trigger | `https://eo5h5le4j2qu3tm.m.pipedream.net` (POST `{hypothesis, signal_ids, ...}`) |
| Enrichment agent trigger | `https://eoxadsat1xxgqa4.m.pipedream.net` (POST `{"trend_id":"<uuid>"}`) — single-trend; returns full enrichment payload |
| Dispatcher trigger (full chain) | `https://eoqf5zok2vcvael.m.pipedream.net` (POST `{"trend_id":"<uuid>"}`) — fires sources → enrichment → write end-to-end |
| Canonical trend table | `MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS` (12 rows agent-promoted) |
| Legacy trend table (frozen) | `MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS` (324 rows; awaiting lifecycle-agent triage) |
| Dashboard surface | `MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD` (336 rows: UNION of both trend tables) |
| Run cursor | `MCC_RAW.MARKETING_DEV.STG_DISTILLATION_CURSOR` (one row per cursor name; `distillation_main` is live) |
| Agent run cost telemetry | `MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS` |
| Pipedream errors API | `GET /v1/workflows/<id>/%24errors/event_summaries?org_id=o_qOIvyEa&limit=N&expand=event` (the `expand=event` param is required to see actual exception messages) |

## Quick queries

```sql
-- Top trends by heat (joins canonical + legacy via the dashboard surface)
SELECT TREND_NAME, CATEGORY, HEAT_INDEX, TOTAL_CLUSTER_SIZE, TREND_SOURCE
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
ORDER BY HEAT_INDEX DESC LIMIT 20;

-- Recent agent candidates with reasoning
SELECT TOPIC, VERDICT, CONFIDENCE, SPECIFICITY_SCORE,
       ARRAY_SIZE(SUPPORTING_SIGNAL_IDS) AS N_SIGNALS, REASONING
FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES_AGENT
WHERE CREATED_AT > DATEADD(day, -1, CURRENT_TIMESTAMP())
ORDER BY CREATED_AT DESC, CONFIDENCE DESC;

-- Recently-enriched trends with naming audit
SELECT TREND_NAME_B2B, TREND_NAME_B2C, CATEGORY, CATEGORY_CONFIDENCE,
       NAME_REVIEWER:score_b2c::NUMBER AS reviewer_score,
       NAME_REVIEWER:alternate_b2c::STRING AS reviewer_alt,
       AGENT_TELEMETRY:cost_usd::FLOAT AS cost_usd
FROM MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
WHERE ENRICHED_AT > DATEADD(day, -7, CURRENT_TIMESTAMP())
ORDER BY ENRICHED_AT DESC LIMIT 20;

-- Distillation cost trajectory (one row per run)
SELECT STARTED_AT, WORKFLOW_NAME, MODEL, TOOL_CALL_COUNT, COST_USD, STATUS
FROM MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS
ORDER BY STARTED_AT DESC LIMIT 20;
```
