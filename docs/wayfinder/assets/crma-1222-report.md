<!-- ticket: CRMA-1222 · map: CRMA-1214 -->

# CRMA-1222 prototype: the pairwise duplicate check on the widened replay set

Live run against `jev-1.13.0`, 2026-09-21/22, over all 187 cases in the CRMA-1216
widened replay set. Code: `crma-1222-jev-client.mjs`, `crma-1222-family.mjs`,
`crma-1222-build-cases.mjs`, `crma-1222-run.mjs`, `crma-1222-score.mjs`. Raw
per-case answers: `crma-1222-results.jsonl`. Full scorecard:
`crma-1222-scorecard.json`.

**Bottom line: this run does not reach an adopt/reject verdict.** It is
blocked on one external precondition — no `EXPLODING_TOPICS_API_KEY` is
reachable from this environment (checked keychain, env vars, and every GCP
secret in `mcc-crm-automations`; none exist for it, the same gap CRMA-1216 and
CRMA-1229 already hit on the Gemini-era harness). 119 of 187 cases (64%)
round `evidence_quality` to `needs_corroboration`, which under the composition
rules requires `oracle_match` — Request B — to resolve, and Request B cannot
fire. Everything this run *did* measure is real, live, and load-bearing; the
oracle path and the adopt-bar comparison it feeds are not.

## Bucket breakdown (187 cases)

| Bucket | n | What it means |
| --- | ---: | --- |
| `et_unavailable` | 119 | `evidence_quality` -> `needs_corroboration`; oracle can't run here |
| `source_data_gap` | 21 | `STG_TREND_CANDIDATES.SOURCE_BREAKDOWN` / `SUPPORTING_SIGNAL_IDS` are empty **today** for these candidates, even though the historical decision had real evidence — see "Data-gap finding" below |
| `normal` (scored on adopt bar) | 17 | Neither of the above, not a tombstone/NEEDS_MORE_SIGNAL/level-0/family-mismatch case |
| `rule4_family_mismatch` | 12 | Same-vendor-miscounted by `sourceFamilyOf()` — scored against the corrected family count, not the ledger |
| `rule2_needs_signal` | 12 | CRMA-1231 rule 2 — labeled cohort, not scored pass/fail |
| `rule1_tombstone` | 5 | CRMA-1231 rule 1 — the 3 turn-exhaustion candidates' DEFER rows, scored against eventual REJECT |
| `rule3_level0` | 1 | `not_a_topic` with real (non-empty) evidence — hand-inspect only, zero production precedent |

## (a) Adopt-bar scorecard

**On the 17-case scored population: 8/17 matched (47%)**, well under the
adopt bar (match the incumbent 7/7-equivalent). Read this as **directional,
not decisive** — the population is small and structurally hard: it is what's
left after excluding all four CRMA-1231 special classes and everything the ET
gap swallowed, so it over-represents the contested 0.70–0.80 similarity band
by construction (`S07_contested_not_merge` + `S08_contested_merge` are most of
it). Every one of the 9 mismatches has the same shape:

| Case | Ledger | Composed | Rule |
| --- | --- | --- | --- |
| `S07_contested_not_merge` (1) | REJECT | PROMOTE_NEW | `stands_alone_promote` |
| `S07b_confirm_reject` (1) | REJECT | PROMOTE_NEW | `stands_alone_promote` |
| `S08_contested_merge` (6) | MERGE_INTO_EXISTING | PROMOTE_NEW | `stands_alone_promote` |
| `S09_b060_070_MERGE_INTO_EXISTING` (1) | MERGE_INTO_EXISTING | PROMOTE_NEW | `stands_alone_promote` |

Every mismatch is the same failure mode: `evidence_quality` rounds to
`stands_alone` (the candidate's own evidence is judged sufficient), and *no*
neighbour's `pair_sameness` rounds to `same_thing`, so composition never
reaches the merge/reject branch. This is either the typed path being less
willing to call two topics "the same thing" than the incumbent was — the
`MISSED_DUPLICATE` risk the map is watching for — or the incumbent
over-merging in exactly the contested band this stratum was built to probe.
Distinguishing those two readings needs eyes on the actual topic-pair text,
not aggregate stats; that hand read is unfinished.

**Rule 1 (tombstones):** 3/5 rows unscored (`needs_corroboration`); the
other 2 (`cand-x6gub4aomrp0ovow`'s two DEFER rows) confidently resolved
`stands_alone` -> PROMOTE_NEW, against an eventual REJECT. This is exactly
CRMA-1219's requested regression check, in the direction CRMA-1219 didn't
anticipate: not a promoted case collapsing into rejection, but a turn-budget
casualty that, given its *full* neighbour pool instead of the zero neighbours
the exhausted incumbent saw, reads as confidently real. Worth a human look
before this map closes.

**Rule 2 (`NEEDS_MORE_SIGNAL` cohort):** 2/12 scored and agreed with the
eventual verdict (both PROMOTE_NEW); the other 10 hit the ET gap. Too thin to
read.

## (b) Fit test 4 — confidence separation

| | n | mean `evidence_quality` confidence | mean top-`pair_sameness` confidence |
| --- | ---: | ---: | ---: |
| known-easy (`S06_ge080_all`, `S11_none_*`) | 39 | **0.709** | 0.934 |
| known-ambiguous (`S07_contested_not_merge`, `S08_contested_merge`) | 53 | **0.571** | 0.976 |

`evidence_quality`'s confidence separates in the right direction (easy cases
read 14 points more confident than ambiguous ones) — consistent with
CRMA-1217's original finding that Score confidence tracks difficulty.
**`pair_sameness`'s confidence does not separate, and runs backwards**: the
contested cases score *higher* mean top-pair confidence (0.976) than the
unambiguous ones (0.934). That is a genuine caution for CRMA-1223: routing on
`pair_sameness` confidence alone, without a `evidence_quality`-style check,
may not discriminate hard pairs the way the map's Standing constraints hoped.
The validation-batch case (`cand-cpc4l6mtms0g73gc`'s stratum sibling,
`S07_contested_not_merge`, score 1.58 conf 0.36) shows confidence *can* be
low on a genuinely contested pair — but the aggregate above shows that isn't
the median behaviour.

## (c) The near-synonym residual risk — NOT resolved by this run

The two closest real-world instances of CRMA-1217's residual-risk class in
this replay set (`cand-gyzc2tofmteds12q` / "Cottage cheese as a versatile
high-protein base for snacks", `S06_ge080_all`, and `cand-kbzkbavbmtdo1pum` /
"Cottage cheese as high-protein base for snacks and desserts",
`S07a_et_earned_2nd`) **both landed in the source-data-gap bucket** — their
`SOURCE_BREAKDOWN` and `SUPPORTING_SIGNAL_IDS` are empty in
`STG_TREND_CANDIDATES` today, so `evidence_quality` correctly said
`not_a_topic` on an empty state (score 0.42/0.46, confidence 0.37/0.31).
That's the client working correctly on a starved input, not a real test of
whether Jev resolves the near-synonym pair. **CRMA-1217's original
`cottage cheese ice cream` vs `cottage cheese frozen dessert` pair, run
bare with no supporting evidence, still lands unsettled** (verified live this
session: score 1.24, confidence 0 — see the smoke test in the session log).
The residual risk from CRMA-1217 stands exactly where it stood: **unsettled**.
This ticket does not close it.

## (d) Criteria vs bare-instructions arm (the three per-neighbour Nouls)

Measured over every neighbour pair fired in both arms (555 pairs per noul,
187 cases):

| Noul | mean \|Δ\| | max \|Δ\| | flips ≥0.3 |
| --- | ---: | ---: | ---: |
| `is_same_recurring_topic` | 0.013 | 0.25 | 0 |
| `recurrence_deserves_own_row` | 0.052 | 0.19 | 0 |
| `is_narrower_instance` | 0.046 | 0.29 | 0 |

**Criteria make almost no measured difference.** Zero pairs crossed a
0.3-magnitude band on either side, for any of the three nouls, anywhere in
the widened set. This confirms CRMA-1217's original finding (the nouls were
clean *without* criteria) at scale. `is_narrower_instance` — the one noul
CRMA-1221 added criteria to specifically, to fix its 0.82 false-positive on
the near-synonym pair — shows the largest max delta (0.29) and the
second-largest mean delta of the three, so criteria aren't *pure* overhead
there even though this set never flipped a rounding decision. Not resolved:
whether criteria fix that *specific* false positive, since the near-synonym
pair itself couldn't be tested here (see (c)).

## (e) Recurrence-override firing rate

**Zero.** `recurrence_blocked_merge` never fired across all 187 cases, using
the provisional CRMA-1217 cut points (`is_same_recurring_topic` ≥0.84,
`recurrence_deserves_own_row` ≥0.80). Either this replay set genuinely
contains no candidate/neighbour pair that should recur-block a merge, or the
provisional cut is stricter than it should be. CRMA-1223 should treat this as
"unobserved," not "confirmed absent" — it's a 12-candidate-strata sample, and
the mechanism itself is unexercised end to end.

## (f) Cost and latency — real, not vendor-doc-derived

187 cases, dual-arm (both Noul criteria arms in one request), 1–57 questions
per case depending on neighbour count:

- **Total: $0.0547** for the whole 187-case run.
- **Mean $0.000292/candidate**, min $0.0000306, max $0.000770 (the 8-neighbour
  cases).
- **Mean latency 277ms/request**, no case over ~800ms.

This is the dual-arm shape (roughly 2x CRMA-1215's single-arm ~$0.000038/candidate
estimate on the *original* 33-question design, which only makes sense given
this run doubles the three per-neighbour Nouls). A single-arm production shape
would land near CRMA-1215's original figure. Either way: **cost and latency
are non-issues at this volume**, confirming fit tests 1 and 2 hold at
production scale.

## (g) The vendor-family fix — validated 12/12

CRMA-1231's rule 4 flagged 12 cases where `sourceFamilyOf()`
(`agents/lib/promotion_gate.mjs`) miscounts a same-vendor pair as independent —
11 are the `gemini_*` vertical-shard bug (`agent_gemini_discovery` +/or
`gemini_food_drink`/`gemini_other`/`gemini_wellness` all read as one "gemini"
family under the corrected grouping, confirmed against the live distinct
`SOURCE_BREAKDOWN` keys), 1 involves `grok_live`. **All 12 correctly avoided
`stands_alone`** — `evidence_quality` judged the evidence as *not*
independently standing on all 12, purely from reading source names and signal
text, with no family count anywhere in `state`. This is the strongest
positive result in this run: it directly validates the map's central design
bet — teaching independence in words, not counts, closes the exact defect
CRMA-1220 measured (43 live trends promoted on same-vendor corroboration) —
on every case this set could test it against.

## (h) What this run does not resolve

- **The adopt-bar verdict.** 64% of cases are stuck behind the ET gap; the
  17-case scored sample is real but small and structurally biased toward the
  hardest band.
- **The near-synonym residual risk** — see (c). Still unsettled.
- **Cross-question interference** (one request per candidate vs one per
  pair) — not measured this run; every case here already ran the
  one-request-per-candidate shape, so there's no within-run comparison.
  Unmeasured, not zero.
- **`recurrence_blocked_merge` in practice** — mechanism exists, cut points
  are provisional, never fired.
- **`pair_sameness` as a routing confidence signal** — (b) found it runs
  backwards on this set; needs attention before CRMA-1223 leans on it.

## What unblocks the rest

One missing precondition: **`EXPLODING_TOPICS_API_KEY` reachable from a
harness environment.** Traced this session: production reads it as a plain
`process.env.EXPLODING_TOPICS_API_KEY` in
`promotion-agent-p_yKCmm9r/run_subagent/entry.js:657` -- **not** a Pipedream
connected account (no `authProvisionId` for it anywhere in
`promotion-agent-p_yKCmm9r/workflow.yaml`), **not** the macOS keychain, and
**not** GCP Secret Manager in `mcc-crm-automations` (checked all three; only
`typesafe-api-key` exists there, added by CRMA-1215). It is set as a
Pipedream project- or workflow-level environment variable, readable only from
inside the Pipedream dashboard/API, which cannot be reached from this session.

Options, cheapest first: (1) a human copies that Pipedream env var's value
into a local keychain entry (`security add-generic-password -s
exploding-topics-trend-tree-scoping -a "$USER" -w '<key>'`, mirroring the
`typesafe-trend-tree-scoping` precedent) for harness use -- five-minute human
task, unblocks everything; (2) replay against previously-recorded
`verify_exploding_topics` results if any are logged in production
(unconfirmed -- not checked this session); (3) mock a small hand-built set of
ET responses for just the 12 rule-4 and S07a cases to at least exercise the
composition path, clearly labeled synthetic. Until one of these lands,
CRMA-1222 cannot honestly close.
