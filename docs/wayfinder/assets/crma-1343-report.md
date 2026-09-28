<!-- ticket: CRMA-1343 · map: CRMA-1214 -->

# CRMA-1343: the adopt bar re-scored under the settled rules

Measured 2026-09-28. The run made **no new vendor calls**. `crma-1343-rescore.mjs` re-composes
all 187 replay cases from the stored Request A answers (`crma-1222-results.jsonl`) under
CRMA-1223's rules. It merges Request B from CRMA-1332's `signal_frequency` arm
(`crma-1332-oracle-signal_frequency.jsonl`). Then it scores the result through the unchanged
`crma-1222-score.mjs` against CRMA-1231's four ground-truth rules. The full output is
`crma-1343-scorecard.json`.

**Bottom line: 84 of 136 (61.8%). The typed path still fails the adopt bar.** The (a3)
constraint accounts for 18 of the 52 mismatches. Without those 18, the rate is 84 of 118 (71.2%),
which also fails the bar.

## What changed in the composition

The CRMA-1222 composer (`crma-1222-run.mjs` `compose()`) changes in four places:

1. **A split `pair_sameness` takes the heavier extreme.** If `unsettled` is not the top
   level, code takes the larger of P(`same_thing`) and P(`different_thing`). One pair has
   equal extremes. It stays `unsettled`, because neither extreme is heavier.
2. **The merge target is the neighbour with the highest P(`same_thing`)**, not the
   highest confidence.
3. **Two or more `same_thing` neighbours merge into the older trend.** "Older" is
   `FCT_TRENDS.PROMOTED_AT`, queried live for the 8 trends involved
   (`crma-1343-trend-created.json`). `DETECTED_AT` gives the same order for every pair.
4. **Both recurrence Nouls cut at 0.5.** The old provisional cuts were 0.84 and 0.80.

`evidence_quality` and `oracle_match` still round to the nearest level.

## Checks

- **The pair tally reproduces CRMA-1223 exactly.** 555 pairs, 45 rounded `unsettled`,
  29 lean `same_thing`, and merges found go from 33 to 54 of the incumbent's 70.
  There are 4 cases with two `same_thing` neighbours, which is the flag rate CRMA-1223
  reported.
- **The script reproduces the old score when the old rules go back in.** A throwaway
  copy with rounding, confidence ranking and the 0.84/0.80 cuts returns 72 of 136. That
  is CRMA-1332's `signal_frequency` figure.
- **No case needs a new oracle call.** The new rules only add `same_thing` pairs, so
  no case moves onto the oracle route. The script stops with an error if a case on the
  oracle route has no stored oracle answer.

## The adopt bar, step by step

| Rules | Matches | Rate |
| --- | ---: | ---: |
| CRMA-1222 (rounding, `trend_topic` keyword) | 69 / 136 | 50.7% |
| + CRMA-1332 (`signal_frequency` keyword) | 72 / 136 | 52.9% |
| + CRMA-1223 (heavier extreme, P(`same_thing`) target, older trend, 0.5 cuts) | **84 / 136** | **61.8%** |
| … with the 18 (a3) mismatches removed from the scored population | 84 / 118 | 71.2% |

CRMA-1223's net +12 is **+15 fixed and −3 broken**:

- **All 15 fixes are merges the incumbent made.** Before, 12 of them went to the oracle route
  and 3 to `stands_alone`, because no neighbour rounded to `same_thing`. Examples: "Mass Market HOCl Skin Sprays", "Wearable Cooling Accessories",
  and "Layering solid perfumes and sprays". One fix, "Reapplying midday sun protection via
  over-makeup SPF powders and mists", is a two-`same_thing` case. The older-trend rule picks the
  incumbent's target, and the P(`same_thing`) ranking alone does not. That rule is worth 1 of the 84.
- **All 3 breaks are new neighbour merges the incumbent did not make.** None is a
  self-neighbour. By hand, two read as the same thing: "High-fiber meals & chia to support gut
  health and GLP-1" into "Fibremaxxing", and "GLP-1 users prioritizing high-protein foods" into
  "GLP-1 Halo Effect" (the incumbent rejected this one). The third is a sibling, not the same
  thing: "Kidults hunting in-store for limited-edition blind boxes" into "Micro-dropping mundane
  utility items as hype status symbols".

## The 52 mismatches, by mechanism

| Ledger → typed path | n | Mechanism |
| --- | ---: | --- |
| PROMOTE_NEW → REJECT | 17 | oracle route, **multi-AI-agent only — (a3)** |
| MERGE_INTO_EXISTING → REJECT | 1 | oracle route, **multi-AI-agent only — (a3)** |
| PROMOTE_NEW → REJECT | 12 | oracle route, one source family, ET found no `same_concept` |
| MERGE_INTO_EXISTING → REJECT | 9 | oracle route, one source family, no `same_thing` neighbour |
| REJECT → PROMOTE_NEW | 2 | oracle route, ET `same_concept` ("Topical NAD+ serums", "The Wet Lash Look") |
| MERGE_INTO_EXISTING → PROMOTE_NEW | 4 | `stands_alone_promote`, no neighbour at `same_thing` |
| REJECT → PROMOTE_NEW | 2 | `stands_alone_promote` |
| REJECT → MERGE_INTO_EXISTING | 2 | `neighbour_merge` |
| PROMOTE_NEW → MERGE_INTO_EXISTING | 2 | `neighbour_merge` |
| MERGE_INTO_EXISTING → MERGE_INTO_EXISTING | 1 | merge target differs |

**The oracle route is 41 of 52 mismatches (79%).** It splits into three groups:

- **(a3), 18 cases.** Every multi-AI-agent-only candidate in the scored population
  mismatches. None matches, which agrees with CRMA-1332's 0 of 19. The 19th case, "Renters
  installing peel-and-stick acoustic panels", now resolves as a correct merge before it
  reaches the oracle. These rejections are **by design**: CRMA-1222 decided that agreement
  between AI discovery agents is not independent corroboration.
- **One source family, 21 cases.** The candidate had one origin. The oracle did not
  corroborate it, and no neighbour cleared `same_thing`. Nine of these are incumbent merges,
  so the pairwise check still misses some duplicates. The other 12 are incumbent promotions
  on single-origin evidence.
- **Oracle promotions of incumbent rejections, 2 cases.**

**The pairwise and `stands_alone` disagreements are 11 cases.** All of them sit in the
contested 0.60–0.80 similarity band, except "High-fiber meals & chia" at 0.52.

## CRMA-1231's other rules

| Rule | Result | Change from CRMA-1222 |
| --- | --- | --- |
| 1 — tombstones score against the eventual REJECT | 3 / 5 | none |
| 2 — `NEEDS_MORE_SIGNAL` cohort, agreement only | 2 / 12 agree | none |
| 3 — `not_a_topic` on real evidence, hand-inspect | 1 case (ledger MERGE) | none |
| 4 — same-vendor miscount, vendor-aware count | 12 / 12 avoided `stands_alone` | none |

The recurrence override fired **0 times** at the 0.5 cuts. CRMA-1223 predicted this:
`is_same_recurring_topic` is below 0.1 on 514 of 555 pairs.

## What this measurement does not settle

- **The incumbent is not ground truth.** The adopt bar measures agreement with the incumbent.
  Of the 52 mismatches, 18 are rejections that the map's own decision requires. At least 2 of
  the 3 new merges read as correct by hand.
- **The adopt bar was written as "match the incumbent's 7/7".** That bar came from a 7-case
  model-pin comparison, before the verdict set lost DEFER and before (a3). A match rate on 136
  enriched cases is a different measurement. The replay set also over-samples the hard bands
  on purpose (CRMA-1216), so 61.8% is not a production rate.
- **The ET monthly quota is still unverified.** `signal_frequency` sends about two ET calls
  per oracle case.
