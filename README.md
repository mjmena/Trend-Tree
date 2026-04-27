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
  │  EXTERNAL_   │    │ STG_TREND_  │    │ category,   │    │ split /      │
  │  SIGNALS     │    │ CANDIDATES  │    │ vibe shift, │    │ merge        │
  │              │    │             │    │ commercial  │    │              │
  └──────────────┘    └─────────────┘    └─────────────┘    └──────────────┘
        🔧                  ✅                  ⏸                  ⏸
       NEXT              SHIPPED            DEFERRED           DEFERRED
```

Each layer can be redesigned independently. Layer 2 (Distillation) was the first agentic redesign because trend quality was the most-felt pain point; layer 1 (Ingestion) is next because the signal feed itself turned out to be the bottleneck once Distillation got smarter.

---

## Workflow inventory

20 Pipedream workflows, grouped by role:

### Orchestration & persistence

| Workflow | Role |
|---|---|
| [`dispatcher-p_8rCBgnl`](dispatcher-p_8rCBgnl/) | Pops a trend from `STG_ENRICHMENT_QUEUE`, claims a lock, fans out to enrichment with callback wiring. |
| [`sources-p_7NCy36w`](sources-p_7NCy36w/) | For one trend, generates search terms and fetches per-source metrics → `FCT_TREND_SOURCE_METRICS`. |
| [`llm-enrichment-p_YyC86Zo`](llm-enrichment-p_YyC86Zo/) | Synchronous Gemini + Grok + Claude chain producing the trend's full enrichment payload (categories, vibe, commercial fit, B2B/B2C names). |
| [`write-p_o7CWa2K`](write-p_o7CWa2K/) | Persists the enrichment result to `DIM_TREND_ENRICHMENT` + `FCT_TREND_ENRICHMENT_HISTORY`, marks the queue row complete. |
| [`daily-digest-p_vQCkwgV`](daily-digest-p_vQCkwgV/) | Scheduled link-checker + LLM source-verifier → Braze email of the day's trend dashboard. |

### Discovery (LLM trend hypothesis generation)

| Workflow | Role |
|---|---|
| [`discovery-p_5VCPP3N`](discovery-p_5VCPP3N/) | Three LLMs (Gemini/Grok/ChatGPT) sharded across 6 verticals propose trend topics, Claude reranks + dedupes, URL HEAD-validate, write `agent_*_discovery` rows to `STG_EXTERNAL_SIGNALS`. Per-model crons run independently. |

### Distillation (signal → candidate)

| Workflow | Role |
|---|---|
| [`distillation-p_mkCBBqb`](distillation-p_mkCBBqb/) | Sonnet 4.6 lead agent pulls 24h of unclaimed signals, runs Louvain + agent-only clustering, fans hypotheses to subagents. |
| [`distillation-subagent-p_jmCjj3J`](distillation-subagent-p_jmCjj3J/) | Single-hypothesis investigator: tool-calls signal-lookup / dedup / search-ingest, returns a verdict. |

### Promotion (candidate → trend)

| Workflow | Role |
|---|---|
| [`promotion-p_xMC99jg`](promotion-p_xMC99jg/) | Pulls pending REAL_TREND candidates, applies HARD_GATE (cluster_size, source_families), dispatches each to the agent, applies the result via `PROC_PROMOTION_APPLY`. |
| [`promotion-agent-p_yKCmm9r`](promotion-agent-p_yKCmm9r/) | Per-candidate verifier; compares against neighboring active trends, returns PROMOTE_NEW / MERGE_INTO / DEFER / REJECT. |

### Ingestion (raw signal feeds → `STG_EXTERNAL_SIGNALS`)

All five write URL-shaped `SIGNAL_ID`s via JS + `snowflake-sdk` direct connector (the registry SQL proxy 413's at ~256KB).

| Workflow | Role |
|---|---|
| [`ingestion/amazon-p_rvC71gN`](ingestion/amazon-p_rvC71gN/) | Scrapes Amazon Movers & Shakers across 6 departments; `SIGNAL_ID = https://www.amazon.com/dp/<ASIN>`. |
| [`ingestion/bluesky-p_V9CgV17`](ingestion/bluesky-p_V9CgV17/) | `searchPosts` against a fixed seed-term list (`sort=top`, 24h window, engagement-filtered). |
| [`ingestion/google-trends-p_3nC3xkk`](ingestion/google-trends-p_3nC3xkk/) | Google Trends RSS + related-queries pull. |
| [`ingestion/tiktok-p_yKCm9Am`](ingestion/tiktok-p_yKCm9Am/) | Playwright scrape of TikTok trending hashtags. |
| [`ingestion/pinterest-p_xMC9jR5`](ingestion/pinterest-p_xMC9jR5/) | Pinterest trending categories scrape. **`inactive: true`** — raw output didn't fit specificity rubric, deferred. |

### Ingestion tools (HTTP-callable, used by distillation subagent)

| Workflow | Role |
|---|---|
| [`ingestion/tools/search-bluesky-p_13CNNwP`](ingestion/tools/search-bluesky-p_13CNNwP/) | Ad-hoc Bluesky search for hypothesis corroboration. |
| [`ingestion/tools/search-gdelt-p_WxCppoa`](ingestion/tools/search-gdelt-p_WxCppoa/) | Ad-hoc GDELT news search. |
| [`ingestion/tools/search-google-trends-p_YyC88x8`](ingestion/tools/search-google-trends-p_YyC88x8/) | Ad-hoc Google Trends lookup. |
| [`ingestion/tools/grok-live-search-p_vQCkkGK`](ingestion/tools/grok-live-search-p_vQCkkGK/) | Grok live web search via xAI. |

---

---

## Roadmap

The 4-layer mental model maps to phases. Below: status as of 2026-04-27.

## ✅ Phase 1 — Distillation agent (shipped 2026-04-25)

**Goal:** replace the static SQL clustering's "what counts as a trend?" decision with a Sonnet 4.6 agent loop that's opinionated about specificity (rejects "wellness" / "AI" categories, demands noun-verb consumer behaviors).

**Architecture:**
- [`distillation-p_mkCBBqb`](distillation-p_mkCBBqb/) — lead orchestrator (cron-triggered; reads signal window + Louvain output + active trend pool, classifies signals into 3 buckets, dispatches subagents in parallel).
- [`distillation-subagent-p_jmCjj3J`](distillation-subagent-p_jmCjj3J/) — single-hypothesis investigator (Sonnet 4.6 + interleaved thinking + ingest tool calls for corroboration, returns verdict).
- [`ingestion/tools/`](ingestion/tools/) — 4 agent-callable HTTP wrappers around source APIs (Bluesky, GDELT, Google Trends, Grok live web search) so subagents can fetch on demand.
- [`agents/lib/`](agents/lib/) — canonical (off-deploy-path) source for the Anthropic loop runtime, tool catalog, subagent fanout helper. Inlined into each step's `entry.js` per Pipedream packaging constraints (no cross-file imports).

**Output:** writes to **`MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES_AGENT`** — a *shadow table* alongside the existing `STG_TREND_CANDIDATES` produced by `proc_cluster_trends.sql`. Phase 1 is non-destructive; Phase 1.5 (below) decides what gets promoted.

**First-run results (2026-04-25):**

| Metric | Value |
|---|---|
| Signals scanned | 76 in 24h window |
| Candidates accepted | 10 |
| Bucket | All `AGENT_ONLY` (Louvain returned 0 in window) |
| Specificity scores | 0.77 - 0.86 |
| Confidence range | 0.58 - 0.80 |
| Wall clock | 4 min |
| LLM cost | $0.62 (~$0.06/candidate) |

Sample candidates:
- "DIY gel nail builder kits & cluster lash extensions replacing salon appointments"
- "Under-desk & passive movement devices for home/office fitness (MERACH ellipticals, vibration plates)"
- "Korean centella SPF serum (SKIN1004) replacing conventional sunscreen"
- "GLP-1 users reshaping grocery & dining spend"
- "Anti-looksmaxxing counter-movement"

The "too broad" failure mode (wellness / AI / sustainability) is gone — every candidate is a noun-verb behavior with named products or concrete framing.

---

## ✅ Phase 2 — Ingestion + discovery layer (shipped 2026-04-26..27)

**Two parallel streams shipped in this phase:**

**Discovery (LLM-driven trend hypothesis generation)**
- 3-LLM ensemble (Gemini, Grok, ChatGPT) sharded across 6 verticals — wellness, food_beverage, beauty_personal_care, fashion_apparel, home_lifestyle, commerce_retail
- Per-model cron sources allow independent cadence tuning (currently 2h each)
- HTTP trigger supports per-model fires via `{"model": "gemini"}` payload
- Claude Sonnet 4.6 reranks the combined proposal pool, drops below-threshold scores
- `canonicalize_and_validate` fetches each cited article (GET, ~64KB body parse), extracts `og:title` + `article:published_time` from HTML head + JSON-LD, drops articles >30 days old or with title irrelevant to the topic, soft-keeps paywall/bot-block 4xx URLs as `unverified`
- v4 prompts in `DIM_LLM_PROMPT` template `{{current_date}}` and demand 14-day-recent citations
- Writes via direct snowflake-sdk TCP (the registry SQL proxy 413's at ~256KB)

**Ingestion (5 platform feeds)**
- `amazon`, `bluesky`, `google_trends`, `tiktok` actively writing to `STG_EXTERNAL_SIGNALS`; `pinterest` deferred (`inactive: true` — raw output didn't fit the specificity rubric)
- All five emit URL-shaped `SIGNAL_ID` + `URL` fields, plus per-source `METADATA`
- `bluesky` queries `searchPosts?sort=top` with a configurable 24h `since` window and engagement filter (likes + reposts ≥ N)
- All five upsert via JS + `snowflake-sdk` direct connector — bypasses the proxy that bit the original Python attempts

**Quality gates active in promotion**
- `min_source_families >= 2` HARD_GATE; `agent_*_discovery` rows are split per-LLM (gemini, grok, chatgpt are independent families) so 3-LLM agreement alone passes the gate
- `SOURCE_BREAKDOWN` is computed in SQL at insert time from real signal joins, not from the LLM's self-reported claim — kills hallucinated source labels

**Trust calibration (deferred)**
- [Issue #22](https://github.com/mjmena/Trend-Tree/issues/22) — measure unverified-vs-verified URL promotion rates after ~30 days, decide whether to tighten the soft-keep policy.

---

## 🔧 Phase 3 — Enrichment redesign (next)

**Current state:** [`llm-enrichment-p_YyC86Zo`](llm-enrichment-p_YyC86Zo/) — the legacy 3-LLM-in-parallel chain (Gemini for categorization + Grok for cultural context + Claude for synthesis) consuming a frozen `enrich_context` blob. Works, in production. Limitations: no tool use, no feedback between models, can't ask follow-up questions of the data.

**Planned redesign:** collapse to a single Sonnet 4.6 agent loop that decides what evidence it needs (Gemini and Grok become *tools* the agent calls, not parallel pre-computed inputs). Same canonical `agents/lib/` runtime as the Distillation agent.

The Phase 2 work makes this much easier: signals now carry `article_title`, `article_published_date`, `days_since_published`, `unverified`, `source_model` in METADATA. The enrichment agent can reason over richer per-signal context than the legacy chain ever saw.

---

## ⏸ Phase 4 — Lifecycle agent (deferred)

**Current state:** static SQL — `v_trend_lifecycle.sql` (refresh / retire decisions on time thresholds), `proc_dedup_trends.sql` (pairwise LLM merge), `proc_split_trend.sql` (Louvain-based splitting). Functional but threshold-driven, not contextual.

**Planned redesign:** periodic Sonnet 4.6 agent reasoning over the active trend portfolio, deciding refresh / retire / split / merge with semantic context (was this trend seasonal? does the merged result lose a sub-narrative? is the split commercially viable?).

Deferred until enrichment redesign is done — lifecycle agent benefits from the richer enrichment context.

---

## Phase 1.5 — Promotion decision (open)

`STG_TREND_CANDIDATES_AGENT` is currently shadow-only. Three options for promotion to the live `STG_TREND_CANDIDATES`:
1. **Replace** — agent candidates fully replace SQL clustering output.
2. **Augment** — agent's `AGENT_ONLY`-bucket candidates supplement SQL clustering; agent's `LOUVAIN_ONLY` rejections (CATEGORY_TOO_BROAD verdicts) filter out broad clusters.
3. **Curate** — agent feeds a manual review queue; human approves before promotion.

Recommendation: start with (2), upgrade to (1) once trust is built. Decision deferred until ~5 days of agent runs against richer post-Phase-2 data.

---

## Operating reference

| What | Where |
|---|---|
| Per-workflow gotchas | [`CLAUDE.md`](CLAUDE.md) |
| End-to-end smoke test | [`scripts/test_distillation.sh`](scripts/test_distillation.sh) (use `--quick` to skip slow paths) |
| Distillation lead trigger | `https://eo8lg4tmkchk2qc.m.pipedream.net` (POST `{"dry_run": false}`) |
| Distillation subagent trigger | `https://eo5h5le4j2qu3tm.m.pipedream.net` (POST `{hypothesis, signal_ids, bucket, ...}`) |
| 4 ingest tool wrappers | `ingestion/tools/{search-bluesky, search-gdelt, search-google-trends, grok-live-search}-p_*` |
| Shadow output table | `MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES_AGENT` |
| Run cursor | `MCC_RAW.MARKETING_DEV.STG_DISTILLATION_CURSOR` (one row per cursor name; `distillation_main` is the live one) |
| Agent run cost telemetry | `MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS` |
| Pipedream errors API | `GET /v1/workflows/<id>/%24errors/event_summaries?org_id=o_qOIvyEa&limit=N&expand=event` (the `expand=event` param is required to see actual exception messages) |

## Quick queries

```sql
-- Recent agent candidates with reasoning
SELECT TOPIC, BUCKET, VERDICT, CONFIDENCE, SPECIFICITY_SCORE,
       ARRAY_SIZE(SUPPORTING_SIGNAL_IDS) AS N_SIGNALS, REASONING
FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES_AGENT
WHERE CREATED_AT > DATEADD(day, -1, CURRENT_TIMESTAMP())
ORDER BY CREATED_AT DESC, CONFIDENCE DESC;

-- Source breakdown for last cursor window
SELECT SOURCE_NAME, COUNT(*)
FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
WHERE SIGNAL_TIMESTAMP > (SELECT LAST_SIGNAL_TS FROM MCC_RAW.MARKETING_DEV.STG_DISTILLATION_CURSOR
                          WHERE CURSOR_NAME = 'distillation_main')
GROUP BY 1 ORDER BY 2 DESC;

-- Distillation cost trajectory (one row per run)
SELECT STARTED_AT, WORKFLOW_NAME, MODEL, TOOL_CALL_COUNT, COST_USD, STATUS
FROM MCC_RAW.MARKETING_DEV.STG_AGENT_RUN_COSTS
ORDER BY STARTED_AT DESC LIMIT 20;
```
