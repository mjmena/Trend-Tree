# Agent pipeline vs. legacy SQL pipeline

**A side-by-side look at what changed, with real examples from the live data as of 2026-04-28.**

> **Historical snapshot (2026-04-28).** Row counts and examples are point-in-time. Two mechanics described below have since changed: heat is now formula v2 with **Google Trends dropped** and EWMA α=0.5 (50/50), and dual B2C/B2B naming was retired for a **singular `TREND_NAME`**. For current heat/lifecycle/naming, see [`confidence.md`](confidence.md), [`dashboard/fields/heat-index.md`](dashboard/fields/heat-index.md), and ADR-0001/ADR-0005.

---

## TL;DR

The legacy SQL pipeline (`FCT_TREND_METRICS`, 324 rows) clustered raw signals by title-similarity and labeled the result. It produced category-level tags ("Wellness", "AI-Powered Shopping"), couldn't dedupe spinoff clusters of the same news event, and had no concept of trend retirement — **78.7% of its trends were marked STAGNANT, with no path to remove them**.

The new agent pipeline (`FCT_TRENDS` + three append-only ledgers, 34 rows so far) uses LLM agents at every decision point: discovery, distillation, promotion, enrichment, lifecycle. It produces noun-verb behavioral descriptions ("Invisible tinted mineral sunscreen as daily face SPF replacing chemical SPF"), audience-specific names ("Invisible Zinc Pivot" for B2B sales decks; "The White Cast Vanishing Act" for consumer-facing copy), full decision audit trails, and a continuously-evaluated lifecycle with two-cycle retirement confirm.

The legacy table is frozen in place as historical reference. The agent pipeline is what new work goes through.

---

## At a glance

| Metric | Legacy SQL pipeline | Agent pipeline |
|---|---|---|
| Trends in production | 324 (frozen) | 34 (growing daily) |
| Average topic length | **22 chars** ("Holistic Beauty Wellness") | **83 chars** ("Facial-grade body serums applied head-to-toe for full-body skin brightening") |
| Trends with B2B + B2C names | Some (legacy enrichment ran) | All 32 enriched (94% — 2 still in flight) |
| Trends with confidence calibration | None | All 32 enriched (`category_confidence` — low-confidence flag derived in views at < 0.6) |
| Decision audit trail | None | Full ledger of every promote / enrich / lifecycle decision with reasoning |
| Lifecycle re-evaluation | One-shot at clustering time | **Hourly**, with EWMA heat smoothing + two-cycle retirement confirm |
| Status distribution | 255 STAGNANT (78.7%), 0 SUPERSEDED ever | 31 STABLE, 3 NEW, 0 STAGNANT yet (system is young) |
| Largest cluster | **728 signals** in one trend (unworkably broad) | **21 signals** (focused) |
| Worst duplicate | "Coachella 2026" appeared as **44 separate trend rows** | Zero duplicates by design — promotion agent compares each candidate against existing trends |
| Cost per trend | ~$0 (SQL only) | ~$0.45 enrichment + ~$0.05 per lifecycle eval |

---

## Where the agent pipeline succeeds

### 1. Specificity at the source — behaviors, not categories

The most important change isn't a feature; it's the **shape of what gets called a trend**.

**Legacy topic samples (categories):**
> Wellness · Coffee · K-Beauty Skincare · AI-Powered Shopping · Sleep Tonics · Specialty Coffee Trends · Holistic Beauty Wellness

**Agent topic samples (behaviors):**
> Invisible tinted mineral sunscreen as daily face SPF replacing chemical SPF
> Post-GLP-1 gut reset protocols — consumers managing weight regain after stopping GLP-1
> Functional mushroom gummies & buccal pouches replacing daily powder supplements
> QSR fruity refresher drinks replacing sodas — McDonald's, Starbucks, Sonic summer expansion

The legacy pipeline's clustering rewards **breadth** (more articles share a topic word → bigger cluster). The agent pipeline's distillation rewards **specificity** (subagent rejects anything <4 words or category-shaped). The result: agent topics describe consumer *behaviors* you can write a brief about, rather than search-engine categories.

### 2. No more duplicate clusters

**Legacy "Coachella 2026" appears 44 times** as separate trend rows. Title-similarity clustering can't distinguish "Coachella 2026 lineup" from "Coachella 2026 fashion" from "Coachella 2026 weekend two" — they all become their own cluster. Result: Coachella alone accounts for **13.6% of the entire legacy trend table**.

```
Legacy duplicates (by trend topic):
  Coachella 2026                  44 rows
  Coachella 2026 Frenzy            8 rows
  NFL Draft Interest               6 rows
  2026 FIFA World Cup              4 rows
  K-Beauty Skincare                3 rows  (plus 1 more as "K-Beauty Skincare Trends")
  Espresso Cream Trends            3 rows
  Plogging Movement                2 rows
```

The agent promotion step explicitly evaluates each new candidate against existing FCT_TRENDS via vector similarity and agent reasoning. Decisions are PROMOTE_NEW, MERGE_INTO_EXISTING, REJECT, or DEFER — and every decision goes to `FCT_PROMOTION_LEDGER` with the reasoning trail intact. **There are zero duplicate trends in the agent population by design.**

### 3. Audience-aware naming with corporate-media floor

The legacy enrichment did produce B2B and B2C names, but the LLM cascade defaulted to padding the topic with "Wellness", "Integrated", or "Practices":

**Legacy naming samples:**
| Topic | B2C name | B2B name |
|---|---|---|
| Holistic Skin Wellness | Skin Deep & Beyond | **Integrated Dermal Wellness** |
| Vagus Nerve Stimulation | Calm Your Inner Wiring | **Nervous System Regulation Wellness** |
| Somatic Grounding Practices | Shake It Out & Settle In | **Somatic Grounding Wellness Practices** |
| Fitness Snacking | Bite-Sized Workouts | Micro-Dose Fitness Integration |

Note the pattern: 3 of 4 B2B names just append "Wellness" to the topic. None would survive a sales-deck review.

**Agent naming samples (single Sonnet 4.6 with 4-layer naming refinement):**
| Topic | B2C name | B2B name |
|---|---|---|
| Facial-grade body serums applied head-to-toe… | Neck-Down Actives | Body Skinification Buildout |
| Post-GLP-1 gut reset protocols… | Post-Ozempic Soft Landing | GLP-1 Off-Ramp Metabolics |
| Protein coffee "proffee" stix… | Carry-On Proffee | Macro-Stacked Coffee Singles |
| Colostrum supplement breakout… | Beestings & Biomes | IgG-Forward Gut Fortification |
| Molecule-led mood-functional fragrances… | Mood by Molecule | Mood-Mapped Perfumery |

The agent's naming pipeline is four layers:
1. Interleaved thinking inside each agent turn (drafts + critiques 5 candidates per audience)
2. Live cultural grounding via Bluesky / GDELT / Grok web search
3. Anti-cliché blocklist + corporate-media floor (no nsfw, no insult-coded names)
4. Post-emission `name_reviewer` step that scores each candidate 1-10 and emits an alternate if score < 7

Every emitted name carries an audit trail of all 5+ candidates considered and the reviewer's score.

### 4. Decision provenance and audit trail

The legacy pipeline produced **rows**. The agent pipeline produces **decisions with reasoning**, each persisted in an append-only ledger:

| Ledger | What it records |
|---|---|
| `FCT_PROMOTION_LEDGER` | Every promote / merge / reject / defer decision with the agent's reasoning, neighbor similarity scores, and which distillation candidate triggered it |
| `FCT_TREND_ENRICHMENT_LEDGER` | Every enrichment run — full payload (names, narrative, social proof) plus the 5 name candidates considered, the reviewer score, the model used, the token count, and the agent's tool-call trace |
| `FCT_TREND_LIFECYCLE_LEDGER` | Every lifecycle evaluation with the prior status, new status, raw + smoothed heat, retirement reasoning if proposed, and a `request_re_enrichment` flag if the narrative needs refresh |

You can answer "**why** was this trend promoted?" or "**when** did the agent decide this trend was retired?" with a single ledger query. The legacy pipeline could only answer "what cluster was this signal in?"

### 5. Calibrated confidence

New enrichment payload includes:
- `category_confidence` — float 0-1, how sure the agent is about the category assignment (downstream views threshold at < 0.6 for a low-confidence flag)
- `name_reviewer.score_b2c` / `name_reviewer.score_b2b` — 1-10 from the post-emission reviewer

The legacy enrichment produced a category with no confidence signal. The dashboard treated all category labels equally, regardless of whether the model was 0.95 sure or 0.45 sure.

### 6. Structured cultural narrative + typed evidence pool

Both legacy and new enrichment produce `summary_short`, `summary_long`, and `social_narrative` (consumer-voice framing). The agent pipeline adds:

| New field | What it gives stakeholders |
|---|---|
| `evidence` | **Typed citation pool**: array of `{url, type, source, claim, captured_at, quote?, engagement?}` covering all proof points the agent referenced. Types: `news`, `social`, `commerce`, `reference`, `search_volume`, `video`, `other`. The dashboard curates the display from this; the agent's job is to assemble the evidence, not shape it for any one UI. |
| `cultural_drivers` | Why this trend is happening now (regulatory shift, generational, economic) |
| `seasonal_relevance` | Whether the trend is seasonal vs. evergreen, with timing notes |
| `geographic_hotspots` | Where the trend is concentrated (regional, urban, demographic) |
| `name_candidates_considered` | Audit trail — all 5 B2C + 5 B2B names the agent drafted, with self-critique |
| `name_reviewer` | Reviewer score + alternate, with rationale |
| `category_confidence` | Float 0-1; downstream low-confidence threshold at 0.6 |

**Side-by-side narrative example.** Legacy "Magnesium Sleep Supplements" (top legacy trend by heat) produced:

> Summary: Consumers are actively building magnesium into nightly wellness stacks — from glycinate capsules to salt baths — chasing better sleep and everyday balance.

The new pipeline's "Sleep-Optimizing Functional Indulgence Foods" produced:

> Summary: Consumers are reaching for melatonin- and magnesium-infused chocolates, gummies, and desserts as their after-dark indulgence — turning bedtime snacking into a supplement-delivery occasion.
>
> Plus a typed evidence pool — Amazon product listings tagged `commerce`, Bluesky posts tagged `social` with quotes + engagement counts, news editorial tagged `news`, search-volume snapshots tagged `search_volume` — each with the URL the agent used to support the claim.

The legacy describes a *category*. The agent describes a *behavior shift* with a memorable framing **and** ships the evidence trail behind every claim. Both came from the same source signals.

### 7. Lifecycle awareness — the biggest functional gain

This is what unlocks everything else. The legacy pipeline had a `VELOCITY_DIRECTION` column with values GROWING / STABLE / DECLINING / STAGNANT / SUPERSEDED. In practice:

```
Legacy lifecycle distribution:
  STAGNANT   255   (78.7%)
  GROWING     25
  DECLINING   23
  STABLE      18
  NEW          3
  SUPERSEDED   0   (column existed but was never written)
```

**78.7% of the legacy trend table is STAGNANT.** Was that real? No — it's an artifact of the static clustering not knowing how to update its own assessment over time. Once a cluster fell off the velocity threshold, it stayed STAGNANT forever, accumulating in the table.

The new lifecycle agent runs every hour. For each trend due for re-evaluation, it:
1. Pulls the latest 7-day signal counts and source diversity
2. Pulls daily Google Trends search interest
3. Smooths the new heat reading against the prior with EWMA (70% prior + 30% new) to dampen single-day noise
4. Decides a lifecycle status from the current set: NEW / GROWING / STABLE / DECLINING / DORMANT / RESURGENT / RETIRED (the legacy `STAGNANT` status is gone)
5. **Two-cycle retire confirm**: if it proposes RETIRED, it doesn't commit. The next eval has to also propose RETIRED before the trend is actually marked. One off day can't kill a trend.
6. If the narrative has shifted (new sub-behaviors emerging, dominant source changing), it can flag `request_re_enrichment` to trigger a description refresh without touching the trend's identity.

### 8. Source-family quality gate

The legacy SQL pipeline used a soft "distinct source count" metric — average 3.2 sources per trend. But many of those clusters mixed near-duplicate sources (e.g. three articles from the same syndication network counted as three sources).

The agent promotion step has a HARD_GATE: **`source_families >= 2` is required to promote**. The agent population averages 2.4 distinct source families per trend — fewer than legacy on paper, but every one is guaranteed to be cross-platform (e.g. social + commerce + editorial). This is what drives the agent's higher confidence in each individual trend.

---

## Honest tradeoffs

| Where legacy still has the edge | Why it matters | Path forward |
|---|---|---|
| **Volume** — 324 vs 34 trends | Legacy captured more breadth | Agent pipeline is 3 weeks old; volume will catch up. The HARD_GATE deliberately keeps the floor high. |
| **Established history** — months of legacy data | Useful for backwards-looking analysis | Lifecycle agent will triage the 324 frozen rows in a one-shot pass — most will be RETIRED, a handful (Magnesium Sleep, Mouth Taping) may migrate forward. |
| **Per-trend cost** — ~$0 vs ~$0.45 + lifecycle | Legacy was free | Cost is bounded: enrichment runs once per trend (~$0.45 one-time) + ~$0.05/cycle for ongoing lifecycle (one cycle per active trend per ~6h). Total run-rate at 100 active trends ≈ $20/day. |

---

## Cost picture (current operating envelope)

| Stage | Cost per run | Cadence | Daily cost at current volume |
|---|---|---|---|
| Discovery | ~$0.10 per LLM per vertical | 3 LLMs × 6 verticals × 12 runs/day = 216 runs | ~$22/day |
| Distillation | ~$0.32 per cycle | Every 2h, 1 cycle = 12/day | ~$4/day |
| Promotion | ~$0.08 per batch (15 candidates evaluated) | Every 3h = 8/day | ~$0.65/day |
| Enrichment | ~$0.45 per fresh trend | One-time per promotion (~3-5/day) | ~$2/day |
| Lifecycle | ~$0.05 per trend per eval | Hourly sweeper, ~30 trends due / cycle | ~$1.20/hour ≈ $30/day |

**Total: ~$60/day** for the full agentic pipeline at current volume (34 active trends + 200+ raw signals/day).

---

## Recommended next step for the legacy 324

Run the lifecycle agent against `FCT_TREND_METRICS` as a one-shot triage pass. Predicted outcomes:

1. **~250 RETIRED** — anything currently labeled STAGNANT that has had no fresh signals in 7+ days
2. **~50 MIGRATE** — trends with continuing signal activity (e.g. Magnesium Sleep Supplements, Mouth Taping) that should be promoted into `FCT_TRENDS` with fresh enrichment
3. **~20 MERGE** — duplicate clusters (the 44 Coachella rows) collapse into one canonical trend per topic
4. **~4 RE-INVESTIGATE** — high-heat trends where the legacy summary is too vague; needs a fresh distillation cycle

Estimated cost: 324 × ($0.05 lifecycle + $0.45 conditional re-enrich) = ~$80–$165 one-time.

---

## How to drill in on either population

```sql
-- Top legacy trends by heat (frozen at 2026-04-27)
SELECT TREND_TOPIC, TREND_HEAT_INDEX, VELOCITY_DIRECTION, TOTAL_CLUSTER_SIZE
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
ORDER BY TREND_HEAT_INDEX DESC LIMIT 20;

-- Top agent trends with enrichment narrative
SELECT TREND_NAME_B2C, TREND_NAME_B2B, CATEGORY,
       HEAT_INDEX, LIFECYCLE_STATUS, SUMMARY_SHORT
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
WHERE TREND_SOURCE = 'fct_trends'
ORDER BY HEAT_INDEX DESC LIMIT 20;

-- Same trend, full agent narrative (vibe shift, social proof, etc.)
SELECT *
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
WHERE TREND_ID = '<uuid>'
ORDER BY WRITTEN_AT DESC LIMIT 1;

-- Audit one promotion decision
SELECT DECISION, DECISION_CATEGORY, DISTILLATION_VERDICT, OVERRODE_VERDICT,
       CONSIDERED_NEIGHBORS, MAX_NEIGHBOR_SIM
FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
WHERE TARGET_TREND_ID = '<uuid>';

-- See lifecycle history for one trend
SELECT EVALUATED_AT, NEW_STATUS, NEW_HEAT, NEW_HEAT_SMOOTHED,
       DECISION_PAYLOAD:reasoning::STRING AS reasoning
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID = '<uuid>'
ORDER BY EVALUATED_AT DESC;
```
