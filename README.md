# Trend Tree

A multi-agent system that watches the public consumer-culture firehose — news, social, search, marketplace, editorial — and decides, every few hours, what's worth calling a trend, what to name it, and when to retire it.

**As of 2026-04-28, all four agent stages are live in production.** The system runs end-to-end without human dispatch. A trend you saw yesterday may have been retired by an agent overnight, or split, or have its description rewritten because new evidence shifted the story.

---

## The 4-layer model — all live

```
  ┌──────────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────────┐
  │  DISCOVERY   │ →  │ DISTILLATION│ →  │ ENRICHMENT  │ →  │  LIFECYCLE   │
  │              │    │             │    │             │    │              │
  │  what's the  │    │ which of    │    │ what is     │    │ is this      │
  │  noise out   │    │ these are   │    │ this trend  │    │ trend still  │
  │  there?      │    │ trends?     │    │ really?     │    │ alive?       │
  │              │    │             │    │             │    │              │
  └──────────────┘    └─────────────┘    └─────────────┘    └──────────────┘
        ✅                  ✅                  ✅                  ✅
      Apr 26             Apr 25             Apr 27           Apr 28 (today)
```

Each layer is one or more LLM agents (Sonnet 4.6 + supporting models) deciding things, not pipelines moving rows. The decisions chain: discovery emits hypotheses, distillation accepts the worthy ones, promotion turns accepted candidates into named trends, enrichment writes the canonical narrative, lifecycle re-evaluates the portfolio every hour.

---

## Today's snapshot

| | |
|---|---|
| Trends actively tracked | **34** (agent-promoted; 324 legacy frozen) |
| Trends promoted just today | **3** (e.g. *Honey-Note Gourmand Fragrances*, *Tooth-Gem Revival*, *Body-Serum Skinification*) |
| Lifecycle evaluations on record | **91** across 31 trends |
| Average enrichment cost per trend | **~$0.45** |
| Average promotion cost per batch | **~$0.08** for 15 candidates |
| Average distillation cost per cycle | **~$0.32** for ~5 accepted candidates |
| Time from raw signal → named trend on the dashboard | **~10–15 min** end-to-end |
| Currently presented surface | `DT_TREND_DASHBOARD` (358 rows, joined into Steeple) |

---

## What each agent decides

| Agent | Decides | Cadence | Output goes to |
|---|---|---|---|
| **Discovery** (3-LLM ensemble) | "Is anything new bubbling up in this vertical?" | Every 2h, per LLM, per vertical | Raw signals table |
| **Distillation lead + investigators** | "Among today's signals, which clusters describe a real consumer behavior worth tracking?" | Every 2h, per cursor | Candidate table (verdict: REAL_TREND / NOISE / DUPLICATE) |
| **Promotion agent** | "Should this candidate become its own tracked trend, or merge into an existing one?" | Every 3h | New row in `FCT_TRENDS` + immediate enrichment chain |
| **Enrichment agent** (Sonnet 4.6) | "What is this trend, who's it for, what should we call it, what proof do we have?" | Triggered per new promotion | Names (B2B + B2C), category, narrative, social proof |
| **Lifecycle agent + sub-evaluators** *(new today)* | "Is this trend still alive, growing, stagnant, or retired? Should we re-enrich the description?" | Every 1h, scans all due trends | Status updates, heat-index decay, retirement flags |

---

## Today's headline updates (2026-04-28)

### 1. Lifecycle agent shipped (Phase 4)

The pipeline now closes the loop. After a trend is promoted and enriched, the **lifecycle agent** revisits it every hour with fresh evidence:
- Re-checks Google Trends search interest (a daily poller writes `FCT_TREND_GTRENDS_DAILY`).
- Re-counts how many sources are still talking about the topic, and how diverse those sources are (a one-source social-only trend gets penalized vs. a trend with editorial + social + commerce coverage).
- Smooths the heat index over time (EWMA — 70% prior + 30% new) so single-day spikes don't flip a trend's status.
- Decides among **NEW → STABLE → STAGNANT / DECLINING / RETIRED**. Retirement requires two consecutive proposals to commit (no accidental retirements from one off day).

The agent **does not** split or supersede trends — those decisions are concentrated upstream in distillation/promotion where the full signal context is fresher. The lifecycle agent has one job: triage what's already in the portfolio.

If new evidence has shifted the story (e.g. a wellness trend pivots from "powders" to "gummies"), lifecycle can request a **re-enrichment** so the description gets rewritten without touching the trend's identity.

### 2. Storage architecture cleanup — agent-owned ledgers

Each agent now owns a single **append-only ledger** of its decisions. No agent overwrites another's history. The `FCT_TRENDS` table was slimmed to identity-only (the trend's name, category, and origin metadata — set once and frozen). Everything mutable — heat, lifecycle status, enrichment payloads — lives in the ledger that produced it:

| Agent | Owns ledger |
|---|---|
| Promotion | `FCT_PROMOTION_LEDGER` (every promote/reject decision with reasoning) |
| Enrichment | `FCT_TREND_ENRICHMENT_LEDGER` (every enrichment run, full payload + vector embedding) |
| Lifecycle | `FCT_TREND_LIFECYCLE_LEDGER` (every status evaluation with prior-state diff) |

Trade-off accepted: storage duplication (each enrichment row may be 95% identical to the last) in exchange for full auditability. Every change to a trend can be traced back to the agent run that made it, with reasoning intact.

The dashboard surface (`DT_TREND_DASHBOARD`) and Steeple-facing column shape were preserved across the refactor — consumers see no breaking change.

---

## How a trend moves through the system

```
discovery agents (Gemini + Grok + ChatGPT, every 2h, sharded by vertical)
    │ each writes "I think X is happening" rows
    ▼
raw signals table (~thousands of rows/day, deduplicated)
    │
    ▼
distillation lead (Sonnet 4.6) reviews 24h of new signals,
hands hypotheses to subagent investigators in parallel
    │ each investigator decides REAL_TREND / NOISE / DUPLICATE
    ▼
candidates table (~5 accepted per cycle, with reasoning)
    │
    ▼
promotion agent (Sonnet 4.6, every 3h) evaluates each candidate
against existing trends — should this be its own trend, or merge?
    │ writes FCT_TRENDS + seeds the trend's lifecycle + enrichment ledgers
    ▼
trend identity row (frozen: trend_id, topic, candidate origin)
    │ promotion fires the enrichment chain inline
    ▼
sources workflow (Google Trends, Wikimedia, GDELT) → enrichment agent (Sonnet 4.6, ~3-5 min)
    │ produces names, category, narrative, social proof
    ▼
enrichment ledger row (named, categorized, vibe shift articulated)
    │ first-run UPDATE on FCT_TRENDS sets the frozen name + category
    ▼
lifecycle agent sweeps every hour, evaluates due trends
    │ each evaluation writes a new lifecycle ledger row
    ▼
DT_TREND_DASHBOARD (refreshed on demand) — what Steeple shows
```

The whole chain takes **~10–15 minutes** for a fresh trend from "first appears in distillation" to "named and on the dashboard." Lifecycle then keeps it current.

---

## Sample output

A trend the system promoted yesterday and re-evaluated this morning:

> **B2C name:** *The White Cast Vanishing Act*
> **B2B name:** *Invisible Zinc Pivot*
> **Category:** beauty
> **Heat index:** 63.8 (smoothed)
> **Status:** STABLE
> **Cluster:** 21 supporting signals across 4 source families
> **Summary:** Consumers are ditching chemical SPF formulas and reaching for tinted mineral sunscreens that go on invisibly — driven by Korean centella formulas and TikTok's "no white cast" demand…

A trend promoted **today** (still in the enrichment queue as you read this):

> **Topic:** Honey-note gourmand fragrances surging as the new feminine scent direction
> **Status:** NEW
> **Initial heat:** 82.4
> **Promotion confidence:** 0.65

---

## What's next

- **Re-enrichment mode for lifecycle.** When the lifecycle agent decides a trend's narrative has drifted (new sub-behaviors emerging, dominant source shifting), it currently flags `request_re_enrichment` but the lighter-weight "refinement" enrichment mode is still wired in stub form. Coming next.
- **Operational dashboards.** Five ops views (cost-per-day, promotion-health, agent-leaderboard) were dropped during the ledger refactor and will be rebuilt as Steeple panels rather than Snowflake views, once that team picks them up.
- **Lifecycle triage of the legacy 324.** The old SQL-clustered trend table (`FCT_TREND_METRICS`) is frozen pending a one-shot lifecycle pass to retire stale rows or migrate the live ones into `FCT_TRENDS`.

---

## Operating reference (engineer drill-down)

### Active workflows

| Layer | Workflow | Fires on |
|---|---|---|
| Discovery | `discovery-p_5VCPP3N` | Per-LLM cron @ 2h, sharded by vertical |
| Distillation | `distillation-p_mkCBBqb` + `distillation-subagent-p_jmCjj3J` | Cron @ 2h via cursor |
| Distillation revisit | `distillation-revisit-p_o7CWWZl` + `distillation-revisit-subagent-p_ezCwwKm` | Re-investigates earlier deferred candidates |
| Distillation watchdog | `distillation-watchdog-p_dDCWWPg` | Releases stale signal claims if a distillation run fails mid-flight |
| Promotion | `promotion-p_xMC99jg` + `promotion-agent-p_yKCmm9r` | Cron @ 3h + HTTP-on-demand |
| Promotion → Enrichment chain | `dispatcher-p_8rCBgnl` → `sources-p_7NCy36w` → `enrichment-p_xMC995w` → `write-p_o7CWa2K` | Synchronous HTTP chain per newly-promoted trend |
| Lifecycle | `lifecycle-agent-p_JZCz73w` (sweeper) → `lifecycle-subagent-p_gYC562o` (per-trend evaluator) | Sweeper cron @ 1h |
| Lifecycle support | `gtrends-poller-p_13CN9KG` | Daily Google Trends timeseries fetch |
| Daily digest | `daily-digest-p_vQCkwgV` | Scheduled email of top trends |
| Error alerts | `error-alerts-p_zAC1Nd9` | Slack channel notifications when a workflow errors |

### Ingestion (raw signal feeds)

`ingestion/amazon` · `ingestion/bluesky` · `ingestion/google-trends` · `ingestion/tiktok` · (`ingestion/pinterest` deferred). Plus four agent-callable HTTP search tools under `ingestion/tools/` (Bluesky, GDELT, Google Trends, Grok live web).

### Where data lives in Snowflake

| Object | Role |
|---|---|
| `MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS` | Trend identity (34 rows). Slim, immutable per-trend metadata. |
| `MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER` | Every promote/reject decision the promotion agent has made (255 rows). |
| `MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER` | Every enrichment run, full payload + 1024-dim vector (315 rows). |
| `MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER` | Every lifecycle evaluation with status diff + heat (91 rows). |
| `MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD` | Refresh-on-demand snapshot table joining the above for Steeple (358 rows). |
| `MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS` | Frozen legacy table (324 rows from the retired SQL clustering era). |
| `MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS` | Raw inbound signals from all discovery + ingestion sources. |
| `MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES` | Distillation output, awaiting promotion review. |

### Endpoints

| Action | Endpoint |
|---|---|
| Fire enrichment for one trend (full sources → enrichment → write chain) | `POST https://eoqf5zok2vcvael.m.pipedream.net {"trend_id":"<uuid>"}` |
| Fire enrichment alone (already have sources) | `POST https://eoxadsat1xxgqa4.m.pipedream.net {"trend_id":"<uuid>"}` |
| Fire distillation manually | `POST https://eo8lg4tmkchk2qc.m.pipedream.net {}` |
| Fire promotion manually | `POST https://eot66usfdph5i7h.m.pipedream.net {}` |
| Fire lifecycle for one trend | `POST https://53536769d8379ab44edb7179328e9fd3.m.pipedream.net {"trend_id":"<uuid>"}` |
| Fire lifecycle sweeper | `POST https://23f3a2c4e5fbd681c1531592137719be.m.pipedream.net {"sweep_cap":25,"write_live":true}` |

### Quick queries

```sql
-- Top trends right now (joins identity + latest enrichment + latest lifecycle)
SELECT TREND_NAME, CATEGORY, HEAT_INDEX, LIFECYCLE_STATUS,
       TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
ORDER BY HEAT_INDEX DESC LIMIT 20;

-- Most recent lifecycle decisions
SELECT TREND_ID, EVALUATED_AT, NEW_STATUS, NEW_HEAT_SMOOTHED,
       DECISION_PAYLOAD:reasoning::STRING AS reasoning
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
ORDER BY EVALUATED_AT DESC LIMIT 20;

-- Enrichment audit trail for one trend
SELECT WRITTEN_AT, ENRICHMENT_KIND, WRITTEN_BY,
       PAYLOAD:trend_name_b2c::STRING AS name_b2c,
       PAYLOAD:summary_short::STRING AS summary
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID = '<uuid>'
ORDER BY WRITTEN_AT DESC;

-- Recent promotion decisions with reasoning
SELECT DECIDED_AT, DECISION, DECISION_CATEGORY, TARGET_TREND_ID,
       MAX_NEIGHBOR_SIM, CLUSTER_SIZE, SOURCE_COUNT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
ORDER BY DECIDED_AT DESC LIMIT 20;
```

### Per-workflow gotchas, deployment patterns, Snowflake quirks

See [`CLAUDE.md`](CLAUDE.md).
