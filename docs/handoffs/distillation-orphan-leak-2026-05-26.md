# Handoff — Distillation agent is emitting hallucinated/legacy SIGNAL_IDs

## TL;DR

While cleaning up 22 migration-era orphan trends (purged 2026-05-26 via
`sql/orphan_purge_2026_05_26.sql`), an unrelated ongoing leak surfaced:
the distillation agent emits SIGNAL_IDs in `STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS`
that **don't exist in `FCT_SIGNALS`**. `TASK_PROMOTE_TREND_SIGNALS` then
faithfully inserts those into `FCT_TREND_SIGNALS`, producing orphan link
rows for newly-promoted trends.

The rate is small (~1 orphan row/week, ~7 affected trends in the 27 days
between the 2026-04-28 refactor and 2026-05-26 cleanup) but signals a
quality problem in distillation's evidence emission. This handoff is the
investigation entry point for the root cause.

The audit-agent now carries a `data_hygiene` tripwire that fires YELLOW
if `active_orphan_trends` ≥ 1, RED if > 5 — so this leak is no longer
silent.

## How it was discovered

While auditing why ~30% of live trends have `DISTINCT_PUBLISHER_COUNT = 0`,
the 22 fully-orphan trends turned out to be 2026-04-28 migration artifacts
(legacy IDs that don't resolve to the post-refactor UUID-keyed `FCT_SIGNALS`).
Expected.

What was *not* expected: querying `FCT_TREND_SIGNALS` left-joined to
`FCT_SIGNALS` by `LINKED_AT > 2026-04-29` returned 8 rows across 7 distinct
trends — orphan link rows created **after** the migration. Sorted by date:

| LINKED_AT | TREND | SIGNAL_ID | Pattern |
|---|---|---|---|
| 2026-05-22 | (orphan trend, NULL topic) | `external_corroboration_pending` | phantom placeholder |
| 2026-05-16 | (orphan trend, NULL topic) | `derived_empty_nester_exotics` | phantom placeholder |
| 2026-05-13 | HVAC Scent Architecture | `https://nuviaaromas.com/products/hvac-pro-scent-subscription` | hallucinated URL |
| 2026-05-13 | HVAC Scent Architecture | `https://www.pulsetv.com/scentsation-aromavip-hvac-diffuser` | hallucinated URL |
| 2026-05-10 | Mainstream Peptide Supplementation | `gdelt_3b8ef71f40bb44a5e3cbd17e97e372b8` | legacy hash format |
| 2026-04-30 | (orphan trend, NULL topic) | `amazon_trends_kitchen-dining_2026-04-29_1` | legacy date-suffix format |
| 2026-04-30 | Small oily fish maxxing | `amazon_trends_grocery_2026-04-27_4` | legacy date-suffix format |
| 2026-04-30 | Mugwort clay stick masks | `https://www.amazon.com/dp/B0G58K8BQN` | hallucinated URL |

Tracing one back via `STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS` confirms
the distillation agent emitted these IDs as its evidence array, and
promotion's `TASK_PROMOTE_TREND_SIGNALS` (5-min cadence) faithfully
inserted them into `FCT_TREND_SIGNALS` without checking that the
referenced signals exist.

The HVAC trend (2026-05-13) is a clear smoking gun: 5 supporting URLs,
3 resolve to `FCT_SIGNALS` rows, **2 do not** (`nuviaaromas.com`,
`pulsetv.com`). Those two URLs were never ingested.

## Three failure patterns

### 1. Hallucinated URLs from grounded search

The distillation lead/subagent does grounded web search via Gemini's
Google Search tool. When it composes the candidate's `SUPPORTING_SIGNAL_IDS`,
it sometimes includes URLs that surfaced in the grounded-search results
but were never ingested by any discovery agent / GDELT poller / etc.

This is the most concerning pattern because the agent is citing
"evidence" it never had. Even if we filter at `TASK_PROMOTE_TREND_SIGNALS`,
the candidate record itself still asserts a signal that doesn't exist.

### 2. Legacy hash-format IDs

`gdelt_<hash>` and `amazon_trends_<category>_<date>_<n>` are pre-2026-04-28
ID formats. The current ingesters emit URL-as-ID. Either:
- An ingester somewhere is still emitting legacy formats (unlikely —
  `FCT_SIGNALS` queries show all current rows use URL-as-ID for these
  sources)
- The distillation agent has a stale lookup of `FCT_SIGNALS` from before
  the format change baked into its context / few-shot examples / signal
  preview tool
- The agent is generating IDs by template, not by lookup

Worth checking the distillation agent's signal-preview / cluster-hint
tools (`PROC_CLUSTER_SIGNAL_SUBSET`) — if any of them surface old
SIGNAL_ID strings, the agent will cite what it sees.

### 3. Phantom placeholder strings

`external_corroboration_pending` and `derived_empty_nester_exotics`
aren't IDs at all — they look like the agent decided to express
"I don't have a real signal for this yet" or "I'm aggregating these
under a derived bucket" as a literal string. These were attached to
trends whose `TREND_TOPIC IS NULL` in `FCT_TRENDS`, suggesting the
trends were promoted but their candidate metadata was incomplete.

## Suggested investigation paths

### Reproduce the leak in dev

1. Find the most recent orphan link in `FCT_TREND_SIGNALS`:
   ```sql
   SELECT ts.TREND_ID, ts.SIGNAL_ID, ts.LINKED_AT
   FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
   LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s ON s.SIGNAL_ID = ts.SIGNAL_ID
   WHERE s.SIGNAL_ID IS NULL
   ORDER BY ts.LINKED_AT DESC
   LIMIT 5;
   ```
2. Trace back to `STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS` via the
   trend's `CANDIDATE_ID`.
3. Pull the distillation subagent's reasoning trace / tool-call log for
   that candidate run (if retained) — see how the agent arrived at the
   orphan ID.

### Audit distillation's signal-emission contract

- `distillation-subagent-p_jmCjj3J` — read the system prompt for
  `distillation.subagent.system`. Check whether it explicitly instructs
  the agent to "emit only SIGNAL_IDs from the cluster preview" — and
  whether the cluster preview tool surfaces real `FCT_SIGNALS` rows
  (with their current UUID IDs).
- `PROC_CLUSTER_SIGNAL_SUBSET` — if this proc returns SIGNAL_IDs by
  fetching from `FCT_SIGNALS` directly, that's the canonical path.
  If it derives IDs by string-template (e.g. `'gdelt_' || HASH(url)`),
  that's the leak.
- Check whether the distillation subagent's `propose_candidate` tool
  schema requires the `supporting_signal_ids` array to be non-empty —
  and whether the agent fills it with whatever it can come up with when
  it doesn't have real signals.

### Plug the leak at the integration boundary (defensive)

`TASK_PROMOTE_TREND_SIGNALS` (5-min schedule) inserts from
`STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS` into `FCT_TREND_SIGNALS`.
Adding a `WHERE EXISTS (SELECT 1 FROM FCT_SIGNALS WHERE ...)` filter
would stop the bleed at the task boundary. **Not recommended as a fix
in isolation** — silently drops the agent's claimed evidence and masks
the underlying distillation problem. Use only as belt-and-suspenders
*after* the distillation root cause is fixed.

### Audit-agent tripwire (already shipped 2026-05-26)

The audit-agent's new `data_hygiene` area watches `active_orphan_trends`.
YELLOW at 1–5 orphans, RED above 5. If you fix the root cause and the
count stays at 0 indefinitely, the fix worked.

## Key files

| File | Why |
|---|---|
| `distillation-p_mkCBBqb/`, `distillation-subagent-p_jmCjj3J/` | The agents emitting the orphan SIGNAL_IDs |
| `sql/proc_cluster_signal_subset.sql` (or wherever it lives) | The cluster-hint proc that feeds distillation candidates |
| `sql/seed_prompts_distillation*.sql` | Distillation prompts — check the SIGNAL_ID-emission instructions |
| Production task `TASK_PROMOTE_TREND_SIGNALS` (in Snowflake, not the repo) | The 5-min INSERT that propagates orphan IDs into FCT_TREND_SIGNALS |
| `audit-agent-p_xMC9nm3/workflow.yaml` (`q_orphan_trends`) | The tripwire that catches drift |

## Memory pointers

- `agent_owned_ledgers_refactor.md` — the 2026-04-28 refactor that created the original 110-trend orphan backlog (cleaned up 2026-05-26)
- `legacy_signal_tables_retired_2026_04_28.md` — what got dropped in that refactor; explains the legacy SIGNAL_ID formats
- `distillation_phase_15.md` — the distillation agent's current shape (24h sliding window, selective signal claim)
- `pipedream_sql_proxy_413.md` / `pipedream_sql_proxy_backslash_collapse.md` — relevant if you need to touch the distillation workflow's Snowflake calls

## Out of scope

- The 22-trend backlog cleanup — done 2026-05-26 via
  `sql/orphan_purge_2026_05_26.sql`. Time Travel covers 21 days on
  TREND_AGENT tables if recovery is needed.
- The heat-index recalibration that surfaced this whole thread — see
  the separate plan file `/home/marty/.claude/plans/so-awile-back-we-wild-blossom.md`
