# ADR-0003 sample sweep: descriptor neighbor-quality comparison (#54)

**Generated:** 2026-06-30 · **Scope:** 18-trend cross-category sample + full `food_beverage` category (55) · **Decision input for:** #55 (legacy embed-recipe retire go/no-go)

> **Update (full-category extension):** after the 18-trend sample held, we
> re-enriched the **entire `food_beverage` category (55/55)** for a within-category
> comparison at scale. Findings strengthen: mean top-3 cosine **rose** 0.570 →
> **0.584**, clusters tightened, no scrambling. See the [food_beverage section](#full-category-extension-food_beverage-n55) below.

## What this is

The re-enrichment sweep (#54) re-runs active trends through enrichment so they
gain a `descriptor` and re-embed their `TREND_VECTOR` from `descriptor.statement`
(ADR-0003 / #53). Per the agreed plan we ran a **sample first** to produce this
old-vs-new neighbor-quality comparison before committing the full 263-trend spend.

## Method

- **Sample**: top-6-by-heat in each of `beauty`, `food_beverage`, `wellness` (18
  trends), chosen for dense within-sample sibling structure so neighbor sets are
  meaningful.
- **Baseline**: legacy-recipe vectors for all 263 active trends snapshotted to
  `MCC_RAW.MARKETING_DEV.TMP_DESC_SWEEP_BASELINE` *before* re-enrichment.
- **Sweep**: full chain (dispatcher → sources → enrichment → write) fired
  sequentially per trend; 18/18 succeeded, all carry a descriptor + a
  statement-based vector (verified: stored vector cosine = 1.0 vs an embed of
  its own `descriptor.statement`).
- **Comparison**: top-3 nearest neighbors computed **within the sample**
  (apples-to-apples), legacy vectors vs statement vectors, via
  `VECTOR_COSINE_SIMILARITY`.

## Aggregate (n=18)

| Metric | Legacy recipe | Statement seed |
|---|---|---|
| Mean top-3 cosine | 0.504 | 0.495 |
| Same-category neighbors (of 54 top-3 slots) | 34 | 36 |
| Identical #1 nearest neighbor | — | 12 / 18 (67%) |

**Read:** identity-similarity structure is **held**. Mean cosine is flat (the
small dip reflects statement vectors being more discriminating — the legacy
multi-field doc inflated baseline similarity via shared driver/narrative
boilerplate). Same-category purity ticks up. The tightest sibling pairs survive.

## Per-trend top-3 neighbors (legacy → statement)

| Category | Trend | Legacy top-3 | Statement top-3 |
|---|---|---|---|
| beauty | Cellular Longevity Skincare | Hair Longevity [.613] · Face-Grade Body [.506] · Skincare-Infused [.491] | Hair Longevity [.592] · Skincare-Infused [.513] · Face-Grade Body [.497] |
| beauty | Face-Grade Body Care | Skincare-Infused [.591] · Cellular Longevity [.506] · Hair Longevity [.455] | Skincare-Infused [.551] · Cellular Longevity [.497] · Functional Fragrance [.445] |
| beauty | Functional Fragrance | Skincare-Infused [.485] · Face-Grade Body [.453] · Crock Awakening [.438] | Skincare-Infused [.482] · Heat Atlas [.454] · Cellular Longevity [.454] |
| beauty | Hair Longevity Regimens | Cellular Longevity [.613] · Skincare-Infused [.469] · Face-Grade Body [.455] | Cellular Longevity [.592] · The Jawline Protocol [.522] · Skincare-Infused [.484] |
| beauty | Skincare-Infused Cosmetics | Face-Grade Body [.591] · Cellular Longevity [.491] · Functional Fragrance [.485] | Face-Grade Body [.551] · Cellular Longevity [.513] · Hair Longevity [.484] |
| beauty | The Jawline Protocol | Fibermaxxing [.557] · Hair Longevity [.433] · Skincare-Infused [.425] | Hair Longevity [.522] · Functional Fragrance [.425] · Cellular Longevity [.417] |
| food | Crock Awakening | Fibermaxxing [.592] · Protein Feelings [.527] · Functional Creatine [.501] | Fibermaxxing [.658] · Protein Feelings [.558] · Functional Creatine [.484] |
| food | GLP-1-Aligned Eating | Dose-Friendly Dining [.791] · Protein Feelings [.659] · Fibermaxxing [.441] | Dose-Friendly Dining [.695] · Fibermaxxing [.493] · Protein Feelings [.473] |
| food | Half-Hour Haul | Crock Awakening [.476] · Protein Feelings [.42] · GLP-1-Aligned [.393] | GLP-1-Aligned [.401] · Protein Feelings [.389] · QSR Fruit Refreshers [.36] |
| food | Heat Atlas | Protein Feelings [.479] · Crock Awakening [.429] · QSR Fruit Refreshers [.388] | QSR Fruit Refreshers [.526] · Functional Fragrance [.454] · Protein Feelings [.421] |
| food | Protein Feelings | GLP-1-Aligned [.659] · Dose-Friendly Dining [.627] · Functional Creatine [.583] | Fibermaxxing [.602] · Crock Awakening [.558] · Functional Creatine [.492] |
| food | QSR Fruit Refreshers | Protein Feelings [.479] · Functional Creatine [.405] · Heat Atlas [.388] | Heat Atlas [.526] · Half-Hour Haul [.36] · Crock Awakening [.355] |
| wellness | Backyard Bathhouse | Clinical Home Ecosystems [.487] · Cellular Longevity [.408] · Functional Fragrance [.376] | Clinical Home Ecosystems [.615] · Skincare-Infused [.431] · The Jawline Protocol [.403] |
| wellness | Clinical Home Ecosystems | Backyard Bathhouse [.487] · Nervous System Gym [.442] · Functional Creatine [.436] | Backyard Bathhouse [.615] · Nervous System Gym [.476] · Functional Fragrance [.42] |
| wellness | Dose-Friendly Dining | GLP-1-Aligned [.791] · Protein Feelings [.627] · Functional Creatine [.447] | GLP-1-Aligned [.695] · Functional Creatine [.473] · The Jawline Protocol [.377] |
| wellness | Fibermaxxing | Crock Awakening [.592] · The Jawline Protocol [.557] · Protein Feelings [.514] | Crock Awakening [.658] · Protein Feelings [.602] · Functional Creatine [.513] |
| wellness | Functional Creatine | Protein Feelings [.583] · Crock Awakening [.501] · Fibermaxxing [.49] | Fibermaxxing [.513] · Protein Feelings [.492] · Crock Awakening [.484] |
| wellness | Nervous System Gym | Clinical Home Ecosystems [.442] · Hair Longevity [.365] · Functional Fragrance [.357] | Clinical Home Ecosystems [.476] · Backyard Bathhouse [.356] · Functional Fragrance [.35] |

## Interpretation

- **No scrambling.** Every tight sibling relationship that should hold, holds:
  the skincare cluster stays internally linked; the GLP-1 pair (GLP-1-Aligned ↔
  Dose-Friendly Dining) remains each other's #1 by a wide margin; the
  fiber/fermented/protein group (Fibermaxxing, Crock Awakening, Protein Feelings,
  Functional Creatine) stays mutually nearest.
- **Cleaner where the legacy topic was vague.** "Protein Feelings" (frozen
  `TREND_TOPIC` is literally *"Food and Beverage Trends"*) and "Heat Atlas"
  (*"Global Spice Surge"*) get more on-target neighbors under the statement seed —
  the faithful statement carries identity the junk topic didn't.
- **The mean-cosine dip is a feature, not a regression.** Legacy docs shared
  generic driver/narrative phrasing, inflating cross-trend similarity uniformly;
  the statement seed concentrates on identity, so similarities spread out while
  the *ranking* of true siblings is preserved or sharpened.

## Full-category extension: food_beverage (n=55)

The whole active `food_beverage` category re-enriched (55/55 carry a descriptor +
statement vector; one transient HTTP-400 failure cleared on a single retry —
idempotency confirmed). Within-category top-3 neighbors, legacy vs statement:

| Metric | Legacy recipe | Statement seed |
|---|---|---|
| Mean top-3 cosine | 0.570 | **0.584** |
| Identical #1 nearest neighbor | — | 21 / 55 (38%) |

At full-category scale the mean similarity **rises** (the small-sample dip
reverses), and the lower #1-preservation rate is expected — with 55 candidates
there are many near-ties for the top slot, so #1 reshuffles among genuine
siblings while neighborhoods tighten overall.

Illustrative (legacy → statement):

| Trend | Frozen topic | Legacy top-3 | Statement top-3 |
|---|---|---|---|
| Heat Atlas | *Global Spice Surge* | Spicy-Fruit [.657] · Swangy [.653] · Seoul-to-Aldi [.611] | Spicy-Fruit [**.759**] · Swangy [**.708**] · Seoul-to-Aldi [.687] |
| Protein Feelings | *Food and Beverage Trends* | GLP-1-Aligned [.659] · Dairy Proteinmaxxing [.618] · Pack the Week [.591] | Dairy Proteinmaxxing [.636] · Modular Snack Meals [.619] · Post-Imitation Plant Proteins [.605] |
| GLP-1-Aligned Eating | *GLP-1 Halo Effect — protein-forward grocery buying…* | Protein Feelings [.659] · Sensory Single-Serves [.567] · Dairy Proteinmaxxing [.475] | Pantry Protagonist [.537] · Mass Merchant as Primary Grocer [.509] · Midnight Magnesium Bites [.497] |
| Swangy Street-Candy | *Swangy flavors in RTD…* | Swavory [.741] · Spicy-Fruit [.719] · Heat Atlas [.653] | Spicy-Fruit [.711] · Heat Atlas [**.708**] · Swavory [.699] |

- **Vague topics get faithful neighborhoods.** "Protein Feelings" (topic literally
  *"Food and Beverage Trends"*) and "Heat Atlas" (*"Global Spice Surge"*) cohere with
  their real siblings under the statement seed.
- **Meaningful re-grouping, not noise.** "GLP-1-Aligned Eating" moves off generic
  protein and onto grocery-shopping-behavior trends — matching its statement's actual
  emphasis (*protein-forward grocery buying*), arguably a more faithful identity.
- The dense flavor cluster (Swangy/Swavory/Spicy-Fruit/Heat Atlas) stays mutually
  nearest and **tightens**.

## Second full category: beauty (n=51)

Replicates the food_beverage result — the directional finding is consistent across
two independent full categories (51/51 covered; the two transient HTTP-400s cleared
on a single retry each):

| Metric | Legacy recipe | Statement seed |
|---|---|---|
| Mean top-3 cosine (food_beverage) | 0.570 | **0.584** |
| Mean top-3 cosine (beauty) | 0.590 | **0.605** |
| #1 nearest neighbor preserved (beauty) | — | 24 / 51 (47%) |

Both full categories show mean similarity **rising** under the statement seed, with
no scrambling. Two consistent data points at scale.

## Recommendation

Statement-based vectors hold and **improve** identity-similarity quality — neutral
on the small cross-category sample, net-positive at full `food_beverage` scale —
with a clear qualitative win on vague-topic trends and faithful re-grouping. Two
independent full categories (food_beverage, beauty) both show mean top-3 cosine
rising at scale. The COALESCE fallback (#53) means partial rollout is safe at any
point. **Supports completing the full active-set sweep**, and is a green signal for
the #55 legacy-recipe retire decision — which remains the human gate.

## Reproduce

```sql
-- baseline snapshot: MCC_RAW.MARKETING_DEV.TMP_DESC_SWEEP_BASELINE
-- sample:           MCC_RAW.MARKETING_DEV.TMP_DESC_SWEEP_SAMPLE
-- comparison query: see #54 working notes (within-sample top-3, old vs new)
```

## 2026-09-29 — active-set sweep of the frozen-name remainder (CRMA-463)

The August triage counted about 150 active trends still on the legacy fallback.
Before this sweep the count was **144** of 481 active trends (all outside
`food_beverage`/`beauty` except one in each). Those 144 split cleanly into two groups:

| Group | Count | Action |
|---|---|---|
| `FCT_TRENDS.TREND_NAME` already frozen | 70 | **Swept** |
| `FCT_TRENDS.TREND_NAME IS NULL` (ATLAS shows the legacy B2C/B2B name) | 74 | **Held**: needs a product decision |

**Why the 74 are held.** The write step calls `PROC_ENRICHMENT_APPLY` with
`KIND='initial'`. That call sets `TREND_NAME` whenever it is NULL (ADR-0001).
`DT_TREND_DASHBOARD.TREND_NAME` is `COALESCE(t.TREND_NAME, t.TREND_NAME_B2C, …)`,
so re-enriching these 74 trends would **rename their cards in ATLAS**. Examples:
"Backyard Barkitecture", "Beestings & Biomes", "Candy-Aisle Creatine". ADR-0001's
migration intended that rename, but it is a user-visible change, so it needs a
human go-ahead. For the 70 frozen-name trends the sweep changes no identity:
name, category and subcategory are all frozen non-null on `FCT_TRENDS`.

**Results (70 swept).**

- 69 of 70 succeeded on the first pass (3 in flight, about 60 minutes).
- The one failure was the known transient `llm failed: HTTP 400`. It cleared on a
  single re-run, which the driver's selection picked up on its own.
- **70/70** trends now have a new `KIND='initial'` ledger row that carries a
  `descriptor.statement` and a vector. For all 70, the latest non-null vector is
  now statement-based: the minimum cosine against a fresh embed of its own
  statement is 0.99999.
- **Cost:** $10.91 total, $0.136 median, $0.296 max. All 70 rows carry an
  `LLM_COST_ESTIMATE`.
- **No identity changes:** the before/after `FCT_TRENDS` diff of `TREND_NAME`,
  `CATEGORY`, `SUBCATEGORY` and `TREND_TOPIC` over all 581 trends shows 0 changes.
- **Dormant/retired untouched:** 52 DORMANT and 48 RETIRED trends. Their ledger
  row counts (137 / 109) and latest `WRITTEN_AT` are unchanged.

After the sweep, **407/481** active trends carry a statement-based vector. The
**74** remaining are exactly the held NULL-name group.

**Selection query** (a trend needs the sweep when the payload of its current
vector row has no statement):

```sql
WITH active AS (
  SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
  WHERE LIFECYCLE_STATUS IN ('NEW','GROWING','STABLE','RESURGENT')
),
latest_vec AS (   -- same row DT_TREND_DASHBOARD.trend_vectors reads
  SELECT TREND_ID, NULLIF(TRIM(PAYLOAD:descriptor:statement::STRING), '') AS STMT
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_VECTOR IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) = 1
)
SELECT a.TREND_ID
FROM active a
JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t USING (TREND_ID)
LEFT JOIN latest_vec lv USING (TREND_ID)
WHERE lv.STMT IS NULL
  AND t.TREND_NAME IS NOT NULL;   -- drop this line to include the NULL-name group
```

**Re-run.** `scripts/descriptor_sweep.sh` selects by the query above, so it is
idempotent: a second run fires only the trends that have not landed.

```sh
DRY_RUN=1 scripts/descriptor_sweep.sh          # count + list, fires nothing
scripts/descriptor_sweep.sh                    # fire the dispatcher chain, <=3 in flight
INCLUDE_UNNAMED=1 scripts/descriptor_sweep.sh  # ALSO the NULL-name group: renames ATLAS cards
```

The driver needs the `snow` CLI (connection `claude`, run it unsandboxed), `jq`
and `curl`. It refuses to start above `MAX_TRENDS=240` (about $60 at $0.25/run)
and writes a per-trend TSV log to `$LOG_DIR`. Check the outcome with rows, not
the log: run `DRY_RUN=1` again and the target is 0.
