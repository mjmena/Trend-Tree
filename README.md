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

## 🔧 Phase 2 — Ingestion layer (next)

**Why this is next:** Phase 1's first run exposed an *upstream* problem the distillation agent can't solve:
- Total signal volume: **76 in 24h** — too thin for the agent to find emergent patterns reliably.
- Source mix: **52 / 76 = 68% Amazon Movers** (commerce-led products); only 10 Bluesky and 15 GDELT signals; zero from TikTok, Reddit, Pinterest, Wikimedia, Google Trends.
- Workflow status: of the 8 batch ingestion workflows, **7 are marked `inactive: true`** in this repo (gdelt is the only active one); legacy `trends-sql/pipedream/` may be feeding the rest.

The agentic distillation can't surface trends that don't have signal evidence. Without a richer, more diverse firehose, the rubric will keep finding the same kinds of Amazon-trend-driven candidates.

**Open questions for Phase 2 design** (no decisions made yet):
1. **Activate vs replace:** are the dormant batch ingesters worth turning on, or do they need redesign? (Several use Playwright scraping — fragile.)
2. **Static seed terms vs adaptive:** today's batch ingesters loop a fixed list (`["wellness trends", "beauty trends", ...]`). Should an agent decide what to fetch based on emerging patterns from yesterday's distillation output?
3. **Cadence:** batch every-N-hours vs streaming vs event-driven (e.g., distillation lead requests "more on X")?
4. **Source coverage gaps:** TikTok is firehose-only (not query-driven); Pinterest / Amazon / Wikimedia have placeholder workflows with no implementation; Reddit only fetches fixed-subreddit hot lists. Each needs a separate decision.
5. **Quality vs volume:** more signals isn't automatically better — would deduplication + better domain filtering at ingest time produce a higher-signal feed?

**No code changes scheduled yet** — Phase 2 starts with an alignment session on the questions above.

---

## ⏸ Phase 3 — Enrichment redesign (deferred)

**Current state:** [`llm-enrichment-p_YyC86Zo`](llm-enrichment-p_YyC86Zo/) — the legacy 3-LLM-in-parallel chain (Gemini for categorization + Grok for cultural context + Claude for synthesis) consuming a frozen `enrich_context` blob. Works, in production. Limitations: no tool use, no feedback between models, can't ask follow-up questions of the data.

**Planned redesign:** collapse to a single Sonnet 4.6 agent loop that decides what evidence it needs (Gemini and Grok become *tools* the agent calls, not parallel pre-computed inputs). Same canonical `agents/lib/` runtime as the Distillation agent.

Deferred until Phase 1 promotion is settled and Phase 2 ingestion is healthier.

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
