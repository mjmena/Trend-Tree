# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@~/.claude/snippets/mcclatchy-stack.md
@~/.claude/snippets/pipedream.md
@~/.claude/snippets/snowflake.md

## What this repo is

A GitHub-synced Pipedream project. Each top-level directory is one Pipedream workflow. Pipedream watches this repo and redeploys workflows when commits land on `production`.

- **Pipedream project**: `proj_x9sLmqO` ("Trend Tree")
- Workspace, network, and Snowflake account IDs are in the imported `mcclatchy-stack.md`.

## Active workflows

| Workflow | Purpose |
|---|---|
| `discovery-p_5VCPP3N` | Multi-LLM (Gemini + Grok + ChatGPT) discovery agents — every 2h, surface emerging signals into `STG_EXTERNAL_SIGNALS` |
| `distillation-p_mkCBBqb` + `distillation-subagent-p_jmCjj3J` | Lead orchestrator + subagent investigators that distill raw signals into trend candidates → `STG_TREND_CANDIDATES_AGENT` |
| `promotion-p_xMC99jg` + `promotion-agent-p_yKCmm9r` | Promotion agent evaluates candidates → calls `PROC_PROMOTION_APPLY` to write `FCT_TRENDS` rows → `fire_enrichment_chain` step fans out to dispatcher |
| `dispatcher-p_8rCBgnl` | Stateless chain runner — takes `{trend_id}` POST → fires `sources` → `enrichment` → `write` synchronously |
| `sources-p_7NCy36w` | Per-trend source-metrics fetcher — populates `FCT_TREND_SOURCE_METRICS` |
| `enrichment-p_xMC995w` | Single Sonnet 4.6 agent loop — produces the canonical enrichment record |
| `write-p_o7CWa2K` | Persists enrichment to `DIM_TREND_ENRICHMENT` + history |
| `daily-digest-p_vQCkwgV` | Email digest of recently-promoted trends |
| `ingestion/*` | Per-source ingestion workflows (Bluesky, Amazon, Pinterest, TikTok, Google Trends + agent-tools subdir) |

**Deactivated** (kept in repo for rollback / reference):
- `llm-enrichment-p_YyC86Zo` — legacy 3-LLM cascade. Replaced by `enrichment-p_xMC995w` on 2026-04-27.

## Trend pipeline flow

```
discovery agents (every 2h) → STG_EXTERNAL_SIGNALS
                                  ↓
                        distillation lead/subagent
                                  ↓ (proposes candidates)
                          STG_TREND_CANDIDATES_AGENT
                                  ↓
                          promotion agent evaluates
                                  ↓ PROC_PROMOTION_APPLY
                          FCT_TRENDS  ←  canonical trend table
                                  ↓ promotion's fire_enrichment_chain
                          dispatcher (HTTP, per trend)
                                  ↓
                  sources → enrichment → write
                                  ↓
                          DIM_TREND_ENRICHMENT
                                  ↓
                          DT_TREND_DASHBOARD (canonical upstream)
```

**FCT_TRENDS is the canonical trend table** (post-2026-04-27). The legacy `FCT_TREND_METRICS` is frozen — it has 324 historical rows from the (now-suspended) SQL Louvain clustering job; a future audit/lifecycle agent will decide what to do with them. Don't write new code that reads `FCT_TREND_METRICS`.

## The Enrichment workflow (`enrichment-p_xMC995w`)

- Workflow id: `p_xMC995w`, HTTP trigger `hi_4EHDY9m`, endpoint `https://eoxadsat1xxgqa4.m.pipedream.net`
- Input: `POST { "trend_id": "<uuid>" }` — that's it.
- Output: synchronous JSON via `$.respond()` — `enrichment_output` (the canonical Phase 3 record), `agent_telemetry`, `llm_token_usage`, `llm_cost_estimate`.
- Read-only on Snowflake; the `write-p_o7CWa2K` workflow downstream persists to `DIM_TREND_ENRICHMENT`.

Single Sonnet 4.6 agent loop with 4 refinement layers:
1. Interleaved thinking (intra-turn)
2. Tool loop with live cultural grounding (Bluesky/GDELT/Grok live search)
3. In-prompt 5-candidate-per-audience naming with anti-cliché blocklist + corporate-media floor
4. Post-emission `run_name_reviewer` step (~$0.005 reviewer pass that emits alternates if score < 7)

Cost p95 ~$0.40-0.50/run, ~3-5 min wall-clock. Empirical results across 9 sample trends: 9/9 emit, names cleared corporate-media floor in 8/9 (1 borderline caught by reviewer).

## Testing the enrichment workflow

```sql
-- Find a FCT_TRENDS row with good source coverage
SELECT t.TREND_ID, t.TREND_TOPIC, COALESCE(t.TREND_HEAT_INDEX, 0) AS HEAT,
       COUNT(s.SOURCE_NAME) AS SOURCES
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS s ON t.TREND_ID = s.TREND_ID
WHERE s.HEADLINE_METRIC > 0
  AND COALESCE(t.VELOCITY_DIRECTION, '') != 'SUPERSEDED'
GROUP BY 1, 2, 3 HAVING COUNT(s.SOURCE_NAME) >= 4
ORDER BY HEAT DESC LIMIT 5;
```

Fire the enrichment workflow directly:
```sh
curl -sS -X POST https://eoxadsat1xxgqa4.m.pipedream.net \
  -H 'Content-Type: application/json' \
  -d '{"trend_id":"<uuid>"}' --max-time 480 | jq
```

Or fire the full chain via dispatcher (sources → enrichment → write all the way to DIM):
```sh
curl -sS -X POST https://eoqf5zok2vcvael.m.pipedream.net \
  -H 'Content-Type: application/json' \
  -d '{"trend_id":"<uuid>"}' --max-time 600 | jq
```

If the response is HTML (`<p><b>Success!</b></p>`), the trigger's `custom_response` toggle is off (see Pipedream snippet).

## Related repos on this machine

- `/home/marty/dev/trends-sql` — historical reference for the legacy monolithic enrichment pipeline + DDL. **Do not modify** — kept for archaeology.
- `/home/marty/dev/CRM-Proof-Pipeline` — other GitHub-synced Pipedream workflows for the same workspace; useful as a reference for working patterns.
