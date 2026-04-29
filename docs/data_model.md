# Trend-Tree data model

Snapshot of the live Snowflake schema as of 2026-04-28, post the
agent-owned-ledgers refactor + presentation-tier embeddings work.

The legacy [`schema.md`](../schema.md) is preserved for historical
reference but is heavily out of date. **This document is the source of
truth for current data shape.**

---

## Layering

```
MCC_RAW.MARKETING_DEV          ←  raw landing zone, mutable working state
        │  (TASK_PROMOTE_SIGNALS_TO_FCT, every 5 min)
        │  (TASK_PROMOTE_TREND_SIGNALS, every 5 min)
        ▼
MCC_PRESENTATION.TREND_AGENT   ←  canonical, immutable, append-only
                                  (one source of truth for every consumer)
```

Two databases / two schemas; the rule is **one direction**: presentation
derives from raw. No presentation-tier object should reach back into
`MCC_RAW` at refresh time.

Every "FCT" table is **append-only**. Mutable state (latest lifecycle
status, latest enrichment, claim flags) lives either on STG (claims) or
is derived from the latest row of a ledger (status/enrichment).

---

## Account / role

| | |
|---|---|
| Snowflake account | `WVB49304-MCCLATCHY_EVAL` |
| Service role for Pipedream writes | `CRMBOT_SERVICE_USER` (via `apn_yghdQYJ`) |
| Snowsql role for ad-hoc / DDL | `MARKETING_ENGINEER` |
| Compute warehouse for tasks | `MARKETING_WH` |
| Compute warehouse for dashboard | `TREND_AGENT_WH` |

---

## MCC_PRESENTATION.TREND_AGENT (canonical surface)

### `FCT_TRENDS` — trend identity (slim, immutable)

13 columns; one row per trend; **set once, frozen**. Every mutable
property (heat, lifecycle status, enrichment payload, supporting
signals) lives in a sibling ledger or link table.

| Column | Type | Notes |
|---|---|---|
| `TREND_ID` | TEXT | PK. UUID set at promotion. |
| `CANDIDATE_ID` | TEXT | FK to `STG_TREND_CANDIDATES.CANDIDATE_ID`. The candidate row this trend was promoted from. |
| `TREND_TOPIC` | TEXT | The agent's noun-verb topic phrase from distillation. |
| `AGENT_SESSION_ID` | TEXT | Promotion run session id. |
| `CHAIN_ID` | TEXT | Promotion run chain id. |
| `DETECTED_AT` | TIMESTAMP_NTZ | When the agent first surfaced it (distillation time). |
| `LAST_UPDATE_AT` | TIMESTAMP_NTZ | Promotion time (the trend's birth). |
| `PROMOTED_AT` | TIMESTAMP_NTZ | Promotion time. |
| `GTRENDS_KEYWORD` | TEXT | LLM-derived 2-3 word search query for Google Trends polling. |
| `TREND_NAME_B2B` | TEXT | Set once by first enrichment; **frozen after**. |
| `TREND_NAME_B2C` | TEXT | Set once by first enrichment; **frozen after**. |
| `CATEGORY` | TEXT | Set once by first enrichment; **frozen after**. |
| `SUBCATEGORY` | TEXT | Set once by first enrichment; **frozen after**. |

Why the names freeze: lifecycle re-enrichments may rewrite the
*description* (summary, vibe, narrative) but the trend's **identity**
(name, category) doesn't change without splitting the trend, which
is upstream-only.

### `FCT_SIGNALS` — embedded signal record

One row per signal; canonical reference for everything signal-related.
Maintained by `TASK_PROMOTE_SIGNALS_TO_FCT` (5-min cadence) reading
from `STG_EXTERNAL_SIGNALS` with `SIGNAL_TITLE IS NOT NULL` and
`SOURCE_NAME != 'amazon_movers'`.

| Column | Type | Notes |
|---|---|---|
| `SIGNAL_ID` | TEXT | PK. Same key everywhere — STG, FCT, FCT_TREND_SIGNALS. For URL-shaped sources, `SIGNAL_ID` *is* the URL. |
| `SOURCE_NAME` | TEXT | `bluesky`, `gdelt`, `google_trends_explore`, `agent_gemini_discovery`, `grok_live`, `amazon_trends`, etc. |
| `SIGNAL_TIMESTAMP` | TIMESTAMP_NTZ | When the signal was published / detected by the source. |
| `SIGNAL_TITLE` | TEXT | Title or first line. |
| `SIGNAL_TEXT` | TEXT | Body / snippet. |
| `METADATA` | VARIANT | Source-specific blob. Keys vary; `signal_kind` flag distinguishes `enrichment_citation` from default `discovery_signal`. |
| `SIGNAL_VECTOR` | VECTOR(FLOAT, 1024) | Cortex `EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', SIGNAL_TITLE \|\| ' ' \|\| LEFT(SIGNAL_TEXT, 512))`. Single vector covers title + body. |
| `EMBEDDED_AT` | TIMESTAMP_NTZ | When the TASK promoted this row. |

Excluded from FCT_SIGNALS by design: `amazon_movers` (individual SKUs
are too granular; only the aggregated `amazon_trends` rows are useful
for clustering / linking).

### `FCT_TREND_SIGNALS` — trend ↔ signal link table

One row per (trend, signal, link_kind). Maintained by
`TASK_PROMOTE_TREND_SIGNALS` (5-min cadence) flattening
`STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS` for promoted +
dedup-target candidates.

| Column | Type | Notes |
|---|---|---|
| `TREND_ID` | TEXT | PK part. |
| `SIGNAL_ID` | TEXT | PK part. References `FCT_SIGNALS.SIGNAL_ID` (no enforced FK; eventual consistency). |
| `LINK_KIND` | TEXT | PK part. *Operational origin*: `'supporting'` (from candidate's SUPPORTING_SIGNAL_IDS at promotion time) or `'evidence'` (reserved for enrichment citations — population deferred). |
| `LINK_TYPE` | TEXT | *Semantic role*: `news` / `social` / `commerce` / `reference` / `search_volume` / `video` / `other` / NULL. For `'supporting'` links, derived deterministically from `FCT_SIGNALS.SOURCE_NAME` at TASK time. For `'evidence'` (future), survives from the agent's per-trend classification in the enrichment payload. |
| `LINKED_AT` | TIMESTAMP_NTZ | When this row was inserted. |

`LINK_KIND` and `LINK_TYPE` are orthogonal — the first answers "where
did this link come from", the second "what role does it play for this
trend".

### `FCT_PROMOTION_LEDGER` — promotion decisions

Every promote / merge / reject / defer decision the promotion agent
has made. Append-only.

Key columns: `AUDIT_ID` (PK), `CANDIDATE_ID`, `DECISION` (`PROMOTE_NEW`/
`MERGE_INTO_EXISTING`/`REJECT`/`DEFER`), `DECISION_CATEGORY`,
`TARGET_TREND_ID`, `DISTILLATION_VERDICT`, `OVERRODE_VERDICT`,
`MAX_NEIGHBOR_SIM`, `CONSIDERED_NEIGHBORS` (VARIANT array of
per-neighbor reasoning), `CLUSTER_SIZE`, `SOURCE_COUNT`, `CONFIDENCE`,
`RATIONALE` (subagent reasoning paragraph), `MODEL_USED`,
`INPUT_TOKENS`, `OUTPUT_TOKENS`, `COST_ESTIMATE`, `DECIDED_AT`.

### `FCT_TREND_ENRICHMENT_LEDGER` — enrichment runs

Every enrichment run, full payload + 1024-dim trend vector. Append-only.
The dashboard's `top_signals` derivation reads `PAYLOAD:evidence`
(structured array of cited URLs with `type` field).

Key columns: `ENRICHMENT_ID` (PK), `TREND_ID`, `WRITTEN_AT`,
`WRITTEN_BY` (`promotion`/`enrichment`/`lifecycle_request`),
`ENRICHMENT_KIND` (`promotion_seed`/`initial`/`refinement`),
`PAYLOAD` (VARIANT — names, category, summary, vibe, social_proof,
voice_of_customer, social_narrative, cultural_drivers,
name_candidates_considered, name_reviewer, agent_telemetry, evidence
array), `TREND_VECTOR` (VECTOR 1024 — embedding at this point in time),
`MODEL_USED`, `LLM_INPUT_TOKENS`, `LLM_OUTPUT_TOKENS`, `LLM_COST_ESTIMATE`.

### `FCT_TREND_LIFECYCLE_LEDGER` — lifecycle evaluations

Every status evaluation with prior/new diff. Append-only. The two-cycle
retirement confirm reads the prior row.

Key columns: `LIFECYCLE_EVAL_ID` (PK), `TREND_ID`, `EVALUATED_AT`,
`PRIOR_STATUS`, `NEW_STATUS`, `PRIOR_HEAT`, `NEW_HEAT`,
`NEW_HEAT_SMOOTHED` (EWMA α=0.3), `HEAT_BASE` (pure-SQL baseline),
`HEAT_MODIFIER_PCT` (agent-emitted modifier in [-20, 20]),
`DECISION_PAYLOAD` (VARIANT, full propose_lifecycle_decision tool args),
`REASONING`, `REQUESTED_RE_ENRICHMENT` (BOOLEAN), `RETIREMENT_PROPOSAL`
(VARIANT, NULL except when proposed RETIRE this cycle), `NEXT_EVAL_AT`,
`MODEL_USED`, `LLM_INPUT_TOKENS`, `LLM_OUTPUT_TOKENS`,
`LLM_COST_ESTIMATE`, `STOP_REASON`, `TOOL_CALLS_JSON`.

### `FCT_TREND_SOURCE_METRICS` — per-source enrichment metrics

One row per (trend, source). Populated by the `sources-p_7NCy36w`
workflow ahead of enrichment. Adding a new source means a new
SOURCE_NAME value, no DDL change.

Key columns: `TREND_ID` (PK part), `SOURCE_NAME` (PK part — `gdelt`,
`wikimedia`, `bluesky`, `google_trends`, `amazon`, `pinterest`,
`tiktok`), `HEADLINE_METRIC` (FLOAT — one comparable number per source,
e.g. article count or pageviews), `HEADLINE_METRIC_NAME` (what
HEADLINE_METRIC means, e.g. `article_count_7d`, `pageviews_7d`),
`METRICS` (VARIANT — full source-specific payload), `ENRICHED_AT`,
`ENRICHMENT_VERSION`.

### `DT_TREND_DASHBOARD` — Steeple-facing dynamic table

Joins identity + latest enrichment + latest lifecycle. 15-minute target
lag. The single surface Steeple consumes. Per-column detail in
[`docs/dt_trend_dashboard_fields.md`](dt_trend_dashboard_fields.md).

### Other live objects

- `DT_LLM_TREND_EMBEDDINGS` — separate dynamic table holding embeddings
  of LLM-generated trend names and descriptions. Used by promotion
  for neighbor lookup. Do not confuse with `FCT_SIGNALS` (signal-level)
  or with the now-dropped `DT_EXTERNAL_TREND_EMBEDDINGS`.
- `FCT_TREND_GTRENDS_DAILY` — daily Google Trends timeseries pull per
  trend. Populated by `gtrends-poller-p_13CN9KG`.
- `FCT_TREND_DAILY_SNAPSHOTS` — daily signal/source counts per trend.
- `FCT_TREND_METRICS` — **frozen legacy** (324 rows from the suspended
  SQL Louvain era). Don't write code that reads it.

---

## MCC_RAW.MARKETING_DEV (raw working zone)

### `STG_EXTERNAL_SIGNALS` — landing zone for every signal

Mutable. SIGNAL_ID is the join key but is not a hard PK in Snowflake
metadata — actual uniqueness depends on writers using MERGE-on-key
(every `gemini-*` discovery workflow does). About 9% duplicate
SIGNAL_IDs exist over a 3-day window today, mostly from non-canonical
URL forms (utm params, AMP variants).

| Column | Type | Notes |
|---|---|---|
| `SIGNAL_ID` | TEXT | Join key. URL-shaped for most sources; pseudo-URL for Amazon (`amzn-trend://...`); MD5 fallback for Google Trends articles without URLs. |
| `INGESTED_AT` | TIMESTAMP_NTZ | When the row landed in STG. |
| `SOURCE_NAME` | TEXT | See FCT_SIGNALS for the value list. |
| `SIGNAL_TIMESTAMP` | TIMESTAMP_NTZ | When the signal was published. |
| `SIGNAL_TITLE` | TEXT | |
| `SIGNAL_TEXT` | TEXT | |
| `METADATA` | VARIANT | Source-specific. `signal_kind` discriminates `enrichment_citation` (fetched by enrichment agent as evidence) from default `discovery_signal` (firehose). Distillation lead filters on `signal_kind = 'discovery_signal'` to skip enrichment citations. |
| `AGENT_SESSION_ID` | TEXT | **Mutable claim state.** NULL = unclaimed, available for next distillation. Stamped by the agent that consumes the signal so future runs skip it. |
| `URL` | TEXT | Legacy column from pre-canonicalization era; usually duplicates SIGNAL_ID. |
| `LEGACY_SIGNAL_ID` | TEXT | Pre-canonicalization id; preserved for migration debugging. |

### `STG_TREND_CANDIDATES` — distillation output

Mutable. Each row is one candidate trend the distillation agent (lead
or subagent) emitted via `propose_trend_candidate`. Promotion agent
later updates `PROMOTED_TO` / `REJECTED_AT` / `DEFERRED_UNTIL`.

Key columns: `CANDIDATE_ID` (PK), `AGENT_SESSION_ID`, `CHAIN_ID`,
`ITERATION`, `CREATED_AT`, `TOPIC` (noun-verb behavior),
`SUPPORTING_SIGNAL_IDS` (ARRAY — flattened by `TASK_PROMOTE_TREND_SIGNALS`
into FCT_TREND_SIGNALS), `CONFIDENCE`, `SPECIFICITY_SCORE`,
`SOURCE_BREAKDOWN` (VARIANT — `{source_name: count}`), `BUCKET`
(legacy from Louvain era; ignored), `VERDICT` (`REAL_TREND` /
`CATEGORY_TOO_BROAD` / `NOISE` / `DUPLICATE_OF_<id>`),
`EVIDENCE_ADDED`, `REASONING`, `REASONING_TRACE`, `DEDUP_OF_TREND_ID`,
`PROMOTED_AT`, `PROMOTED_TO` (FK to FCT_TRENDS.TREND_ID once promoted),
`REJECTED_AT`, `REJECTION_REASON`, `DEFERRED_UNTIL`, `DEFER_REASON`,
`PROMOTION_DECIDED_BY`.

### `STG_DISTILLATION_CURSOR` — per-cursor watermark

One row per cursor (`distillation_main`, `distillation_revisit`).
Tracks `LAST_SIGNAL_TS` so the next run picks up where the last left
off. Updated at end of each distillation run.

### `DIM_LLM_PROMPT` — versioned prompt registry

One row per (PROMPT_KEY, VERSION). Exactly one row per PROMPT_KEY
should be `IS_ACTIVE = TRUE`. Workflows query `WHERE IS_ACTIVE = TRUE`
to load their system prompt. `MODEL_PARAMS` carries per-prompt
overrides like `thinking_level` / `budget_usd` / `max_iterations` so
runtime tuning doesn't require code changes.

Active keys today:
- `discovery.{gemini,grok,chatgpt}.system` — discovery LLM prompts
- `distillation.lead.system` v5 — Gemini 3.1 Pro, with cluster hints
- `distillation.subagent.system` v4 — Gemini 3.1 Pro
- `promotion.subagent.{system,decision_rubric}` v2 — Gemini 3.1 Pro
- `lifecycle.subagent.{system,decision_rubric}` v2 — Gemini 3.1 Pro
- `enrichment.system` — Claude Sonnet 4.6 (only active Anthropic prompt)

### `STG_LLM_PROMPT_LOGS`

Audit log for every LLM call. Tracks `MODEL_NAME`, `PROVIDER`,
`PROMPT_TOKENS`, `COMPLETION_TOKENS`, `LATENCY_MS`, `PROMPT`,
`RESPONSE`, `USAGE_CONTEXT`. Useful for cost reconciliation.

---

## Maintenance tasks

| Task | Cadence | What it does |
|---|---|---|
| `MCC_PRESENTATION.TREND_AGENT.TASK_PROMOTE_SIGNALS_TO_FCT` | 5 min | INSERT new STG rows into FCT_SIGNALS with embeddings via Cortex. Idempotent (NOT EXISTS guard); QUALIFY ROW_NUMBER dedupes intra-source dupes. |
| `MCC_PRESENTATION.TREND_AGENT.TASK_PROMOTE_TREND_SIGNALS` | 5 min | INSERT new (trend, signal, 'supporting') rows into FCT_TREND_SIGNALS by flattening STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS. Derives LINK_TYPE from FCT_SIGNALS.SOURCE_NAME. |
| `MCC_RAW.MARKETING_DEV.PROC_RELEASE_STALE_SIGNAL_CLAIMS` | called per distillation run | Releases AGENT_SESSION_ID claims older than the stale threshold so signals don't stay stuck if a distillation run failed mid-flight. |

Suspended / on-demand:
- `TASK_CLASSIFY_GOOGLE_TRENDS` — classifies new Google Trends entries as relevant/not. Suspended pending re-evaluation of the GT relevance pipeline.
- `TASK_CLUSTER_TRENDS` — **dropped 2026-04-28** with the agent-owned-ledgers refactor. The Louvain-based proc + task were retired; the suspended on-demand pattern wasn't paying for itself. Git history preserves the proc body for revival.

---

## Cross-cutting invariants

1. **SIGNAL_ID is the universal identity primitive.** Same key in
   STG, FCT_SIGNALS, FCT_TREND_SIGNALS. For URL-shaped sources,
   SIGNAL_ID *is* the URL. New writers should canonicalize before
   using a URL as SIGNAL_ID (the enrichment workflow has
   `validate_url_canonical` for this).

2. **Eventual consistency between FCT_TREND_SIGNALS and FCT_SIGNALS
   is by design.** A brand-new evidence link can point at a
   SIGNAL_ID that won't have an FCT_SIGNALS row for up to 5 minutes
   (the TASK lag). No FK enforcement; link-level use cases don't
   need the embedding.

3. **Append-only ledgers.** Every change to a trend (promote, enrich,
   evaluate lifecycle) writes a new row in the appropriate ledger.
   Nothing overwrites; latest = `MAX(EVALUATED_AT)` / `MAX(WRITTEN_AT)`
   / `MAX(DECIDED_AT)`. The dashboard inlines windowed-latest CTEs
   over each ledger.

4. **Each agent owns one ledger.** Promotion → `FCT_PROMOTION_LEDGER`.
   Enrichment → `FCT_TREND_ENRICHMENT_LEDGER`. Lifecycle →
   `FCT_TREND_LIFECYCLE_LEDGER`. No agent overwrites another's
   history.

5. **No cross-database reaches at refresh time.** Anything
   `MCC_PRESENTATION.TREND_AGENT.*` derives from must also live in
   `MCC_PRESENTATION.TREND_AGENT.*` (or the refresh role can't read
   it). The TASKs are the bridge from raw to presentation.

---

## See also

- [`README.md`](../README.md) — narrative overview and pipeline flow.
- [`CLAUDE.md`](../CLAUDE.md) — workflow inventory, gotchas,
  test/debug recipes.
- [`docs/dt_trend_dashboard_fields.md`](dt_trend_dashboard_fields.md) — per-column DT_TREND_DASHBOARD reference.
- [`schema.md`](../schema.md) — **legacy doc, kept for archaeology**.
  Heavily out of date; references dropped tables (DIM_TREND_ENRICHMENT,
  STG_ENRICHMENT_QUEUE, DT_EXTERNAL_TREND_EMBEDDINGS) and the retired
  4-LLM specialist+synthesizer enrichment pattern. Trust this document
  instead.
