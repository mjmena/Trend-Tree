# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@~/.claude/snippets/mcclatchy-stack.md
@~/.claude/snippets/pipedream.md
@~/.claude/snippets/snowflake.md

## What this repo is

A GitHub-synced Pipedream project. Each top-level directory is one Pipedream workflow. Pipedream watches this repo and redeploys workflows when commits land on `production`.

- **Pipedream project**: `proj_x9sLmqO` ("Trend Tree")
- Workspace, network, and Snowflake account IDs are in the imported `mcclatchy-stack.md`.

## Workflow defaults

- Questions ("is X worth keeping?", "what's happening with Y?") get analysis, not edits. Don't start implementing until a change is explicitly requested.
- Non-trivial features start design-first: `/grill-with-docs` → `/to-prd` → `/to-issues`, then implement from the issue (`/ship-issue`).
- Keep changes surgical and scoped to the explicit request — no extra endpoints, steps, or features without asking.

## Active workflows

| Workflow | Purpose |
|---|---|
| `discovery-p_5VCPP3N` | Multi-LLM (Gemini + Grok + ChatGPT) discovery agents — every 2h, surface emerging signals into `STG_EXTERNAL_SIGNALS` |
| `distillation-p_mkCBBqb` + `distillation-subagent-p_jmCjj3J` | Gemini 3.1 Pro lead + subagent. Distills raw signals (cluster-hint annotated via `PROC_CLUSTER_SIGNAL_SUBSET` over `FCT_SIGNALS`) into trend candidates → `STG_TREND_CANDIDATES` |
| `promotion-p_xMC99jg` + `promotion-agent-p_yKCmm9r` | Gemini 3.1 Pro promotion agent. Evaluates candidates → calls `PROC_PROMOTION_APPLY` to write `FCT_TRENDS` rows → `fire_enrichment_chain` step fans out to dispatcher |
| `dispatcher-p_8rCBgnl` | Stateless chain runner — takes `{trend_id}` POST → fires `sources` → `enrichment` → `write` synchronously |
| `sources-p_7NCy36w` | Per-trend source-metrics fetcher — populates `FCT_TREND_SOURCE_METRICS` |
| `enrichment-p_xMC995w` | Single Claude Sonnet 4.6 agent loop — produces the canonical enrichment record (the lone Anthropic holdout post-Gemini migration) |
| `write-p_o7CWa2K` | Persists enrichment to `FCT_TREND_ENRICHMENT_LEDGER` (append-only ledger; the legacy `DIM_TREND_ENRICHMENT` was retired in the 2026-04-28 agent-owned-ledgers refactor) |
| `lifecycle-agent-p_JZCz73w` + `lifecycle-subagent-p_gYC562o` | Gemini 3.1 Pro lifecycle agent. Sweeps every hour, re-evaluates trend status (NEW/GROWING/STABLE/DECLINING/DORMANT/RESURGENT/RETIRED) → `FCT_TREND_LIFECYCLE_LEDGER` |
| `prediction-agent-p_QPCkLP1` | Deterministic emergence scorer (no LLM). Computes `PREDICTION_SCORE` (0–100), `PREDICTION_FLAG` (Emerging / Watchlist / High Potential), `PREDICTION_ELIGIBLE` across all live trends in one batch SQL run → `FCT_TREND_PREDICTION_LEDGER`. Feeds the Insights Agent Predictions Queue. Daily 14:00 UTC cron (`dc_wDuPeGB`) + manual via HTTP. Scores + writes in a single `INSERT...SELECT` (no proc). |
| `daily-digest-p_vQCkwgV` | Email digest of recently-promoted trends |
| `audit-agent-p_xMC9nm3` | Gemini 3.1 Pro health auditor. Daily 13:00 UTC + HTTP. Prefetches Snowflake freshness/cost/stuck-trends + Pipedream errors per workflow (registry covers all live workflows incl. the full ingestion tier as of 2026-06-08), emits GREEN/YELLOW/RED report → `FCT_AUDIT_LEDGER` + Slack DM (gated on non-GREEN). Realtime per-error alerting is handled by an external multi-repo monitor outside this project |
| `ingestion/*` | Per-source ingestion workflows (Bluesky, Amazon, Pinterest, Google Trends + agent-tools subdir) |

**Deactivated** (kept in repo for rollback / reference):
- `llm-enrichment-p_YyC86Zo` — legacy 3-LLM cascade. Replaced by `enrichment-p_xMC995w` on 2026-04-27.
- `ingestion/tiktok-p_yKCm9Am` — Creative Center hashtag scraper, scrapped 2026-06-09. TikTok retired the scraped page (301 → "TikTok One Creative Suite"; the `creative_radar_api` XHR is gone), and the hashtag-level output never met the distillation specificity rubric anyway (#18). The discovery workflow's Grok lane covers the TikTok cultural niche.

## Trend pipeline flow

```
discovery agents (every 2h) → STG_EXTERNAL_SIGNALS
                                  ↓
                        TASK_PROMOTE_SIGNALS_TO_FCT (5-min)
                                  ↓
                          FCT_SIGNALS  ←  embedded signal record
                                  ↓
                        distillation lead/subagent (Gemini 3.1 Pro)
                          (cluster-hinted via PROC_CLUSTER_SIGNAL_SUBSET)
                                  ↓ (proposes candidates)
                          STG_TREND_CANDIDATES
                                  ↓
                          promotion agent evaluates (Gemini 3.1 Pro)
                                  ↓ PROC_PROMOTION_APPLY
                          FCT_TRENDS  ←  canonical trend identity
                                  ↓
                        TASK_PROMOTE_TREND_SIGNALS (5-min)
                                  ↓
                          FCT_TREND_SIGNALS  ←  trend↔signal links
                                  ↓ promotion's fire_enrichment_chain
                          dispatcher (HTTP, per trend)
                                  ↓
                  sources → enrichment (Sonnet 4.6) → write
                                  ↓
                          FCT_TREND_ENRICHMENT_LEDGER
                                  ↓
                          DT_TREND_DASHBOARD (15-min lag dynamic table)

                          lifecycle agent (Gemini 3.1 Pro, hourly)
                                  ↓
                          FCT_TREND_LIFECYCLE_LEDGER
                                  ↓
                          DT_TREND_DASHBOARD reads latest status

                          prediction agent (deterministic SQL, daily 14:00 UTC)
                                  ↓ INSERT...SELECT (score + write in one statement)
                          FCT_TREND_PREDICTION_LEDGER
                                  ↓
                          DT_TREND_DASHBOARD adds PREDICTION_SCORE / FLAG / ELIGIBLE
                          (additive, isolated from HEAT_INDEX)
```

**FCT_TRENDS is the canonical trend identity table** (post-2026-04-27 agent-owned-ledgers refactor — slim, immutable). All mutable state (heat, lifecycle status, enrichment payload, supporting signals) lives in dedicated append-only ledgers / link tables. The legacy `FCT_TREND_METRICS` is frozen — 324 historical rows from the suspended SQL Louvain clustering job; don't write new code that reads it.

For per-table column detail, see [`docs/data_model.md`](docs/data_model.md).

## The Enrichment workflow (`enrichment-p_xMC995w`)

- Workflow id: `p_xMC995w`, HTTP trigger `hi_4EHDY9m`, endpoint `https://eoxadsat1xxgqa4.m.pipedream.net`
- Input: `POST { "trend_id": "<uuid>" }` — that's it.
- Output: synchronous JSON via `$.respond()` — `enrichment_output` (the canonical Phase 3 record), `agent_telemetry`, `llm_token_usage`, `llm_cost_estimate`.
- Read-only on Snowflake; the `write-p_o7CWa2K` workflow downstream persists to `FCT_TREND_ENRICHMENT_LEDGER`.

Single Sonnet 4.6 agent loop with 4 refinement layers:
1. Interleaved thinking (intra-turn)
2. Tool loop with live cultural grounding (Bluesky/GDELT/Grok live search)
3. In-prompt 5-candidate-per-audience naming with anti-cliché blocklist + corporate-media floor
4. Post-emission `run_name_reviewer` step (~$0.005 reviewer pass that emits alternates if score < 7)

Cost p95 ~$0.40-0.50/run, ~3-5 min wall-clock. Empirical results across 9 sample trends: 9/9 emit, names cleared corporate-media floor in 8/9 (1 borderline caught by reviewer).

## Testing the enrichment workflow

```sql
-- Find a trend with good source coverage from the dashboard view (heat
-- + lifecycle state come from FCT_TREND_LIFECYCLE_LEDGER, not FCT_TRENDS).
SELECT TREND_ID, TREND_NAME, HEAT_INDEX, TOTAL_CLUSTER_SIZE,
       DISTINCT_SOURCE_COUNT, LIFECYCLE_STATUS
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
WHERE LIFECYCLE_STATUS IN ('NEW', 'STABLE')
  AND DISTINCT_SOURCE_COUNT >= 4
ORDER BY HEAT_INDEX DESC LIMIT 5;
```

Fire the enrichment workflow directly:
```sh
curl -sS -X POST https://eoxadsat1xxgqa4.m.pipedream.net \
  -H 'Content-Type: application/json' \
  -d '{"trend_id":"<uuid>"}' --max-time 480 | jq
```

Or fire the full chain via dispatcher (sources → enrichment → write all the way to the ledger):
```sh
curl -sS -X POST https://eoqf5zok2vcvael.m.pipedream.net \
  -H 'Content-Type: application/json' \
  -d '{"trend_id":"<uuid>"}' --max-time 600 | jq
```

If the response is HTML (`<p><b>Success!</b></p>`), the trigger's `custom_response` toggle is off (see Pipedream snippet).

## Deploying & verifying changes

A commit to `production` **is** the deploy — Pipedream redeploys changed workflows after the push, asynchronously.

- Confirm the redeploy actually landed before firing test requests (a curl during the sync lag exercises the *old* code). Check via the Pipedream API — recipes in the `pipedream-synced-project` skill.
- Don't trust HTTP responses from deployed-component HTTP sources (`sc_xxx` triggers): they can return `400 "Error in workflow"` while the run succeeds (#24). Workflow built-in HTTP triggers with `custom_response` on are reliable; `sc_xxx` responses are not.
- "It worked" means rows landed. Verify outcomes by querying the target table (`FCT_TREND_ENRICHMENT_LEDGER`, `FCT_AUDIT_LEDGER`, …) for the id/run you fired — not by reading curl output.

## Related repos on this machine

- `/home/marty/dev/trends-sql` — historical reference for the legacy monolithic enrichment pipeline + DDL. **Do not modify** — kept for archaeology.
- `/home/marty/dev/CRM-Proof-Pipeline` — other GitHub-synced Pipedream workflows for the same workspace; useful as a reference for working patterns.

## Agent skills

### Issue tracker

Issues + PRDs live in GitHub Issues (`mjmena/Trend-Tree`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
