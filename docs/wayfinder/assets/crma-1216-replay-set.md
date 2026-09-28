<!-- ticket: CRMA-1216 · map: CRMA-1214 -->

# The widened promotion replay set

Built for [CRMA-1216](https://mcclatchy.atlassian.net/browse/CRMA-1216) — the
instrument every later ticket on map [CRMA-1214](https://mcclatchy.atlassian.net/browse/CRMA-1214)
measures against. It replaces the 7 stratified cases CRMA-729 built for a model-pin
swap, which are too thin to evaluate a new rubric on a new decision substrate.

- **`crma-1216-replay-set.tsv`** — the set. 187 cases, 181 distinct candidates.
- **`crma-1216-replay-set.sql`** — the generator. Read-only, deterministic.

Regenerate with:

```sh
snow sql -c claude --format json -f docs/wayfinder/assets/crma-1216-replay-set.sql
```

Sampling orders by `MD5(CANDIDATE_ID)`, so the same ledger state returns the same
set. New production rows can only **add** to a stratum that is under quota; they
never reshuffle what is already there.

## What the set is drawn from

The replayable universe is **1,109 candidates** — every promotion decision the
subagent actually made on the `gemini-3.1-pro-preview` pin, 2026-04-29 to
2026-09-20.

`FCT_PROMOTION_LEDGER` holds 2,264 rows. Three groups are **not** subagent
decisions and are excluded, because there is no model call to replay:

| Excluded | Rows | Why |
| --- | ---: | --- |
| `REJECT` / `LOW_QUALITY`, zero-token | 873 | `run_lead_agent` Pass 1 auto-reject. The comment says it plainly: "no LLM dispatch, $0". |
| `PROMOTE_NEW` / `BACKFILL` | 102 | One-day 2026-04-28 backfill. |
| `MERGE_INTO_CANDIDATE` / `INTRA_BATCH_DUPE` | 42 | `run_lead_agent` Pass 2 intra-batch dedup, decided deterministically from precomputed pair similarity. |

**Do not filter those out by `MODEL_USED`.** `proc_promotion_apply.sql:142`
defaults a missing `model_used` to the literal `'claude-sonnet-4-6'`, so every
lead-side row is stamped with a model that never ran — including rows written
last week. The reliable discriminator is **zero tokens**, which the generator
uses. `MODEL_USED = 'gemini-3.1-pro-preview'` is trustworthy in the positive
direction only.

## How it is stratified, and why not by `decision_category`

The ticket asked for stratification across the ten `decision_category` values.
The set covers all nine that exist, but **the primary axis is neighbour
similarity**, for two reasons.

First, `decision_category` is an output the typed path will not ask for —
CRMA-1217 already decided it is derived in code. Stratifying on it stratifies on
an artifact of the incumbent's schema.

Second, similarity is what actually predicts difficulty. The bands separate the
decisions almost cleanly, and the whole contested zone is narrow:

| Max neighbour similarity | PROMOTE | MERGE | REJECT | total |
| --- | ---: | ---: | ---: | ---: |
| no neighbours | 164 | 0 | 150 | 314 |
| < 0.60 | 193 | 22 | 174 | 389 |
| 0.60–0.70 | 80 | 103 | 87 | 270 |
| **0.70–0.80 — contested** | **13** | **86** | **10** | **109** |
| ≥ 0.80 | 0 | 26 | 1 | 27 |

The decision boundary sits at ~0.70. Above 0.82 the incumbent merges every time
but once. **28% of candidates have no neighbour pool at all**, so the pairwise
check is vacuous for them — a proportional sample would spend a quarter of its
runs testing nothing.

The set is therefore **enriched, not proportional**. Re-weight to production
rates using the table above when a result needs to be a production estimate.

## The strata

Take-all strata are marked ∀. Quota'd strata sample deterministically.

| Stratum | n | Pool | What it is for |
| --- | ---: | ---: | --- |
| `S01_turn_exhausted` | 7 ∀ | 7 | Every turn-exhaustion DEFER ever written. **3 distinct candidates**, deferred 2–3 times each. |
| `S02_defer_needs_signal` | 12 | 19 | Genuine model-chosen DEFERs. |
| `S03_dedup_branch` | 2 ∀ | 2 | The entire lifetime output of the `DUPLICATE_OF` rubric branch. |
| `S04_over_reject_promote` | 2 ∀ | 2 | Promotion overriding distillation toward reject. |
| `S05_reject_needs_signal` | 4 ∀ | 4 | `REJECT` carrying the `NEEDS_MORE_SIGNAL` reason. |
| `S06_ge080_all` | 27 ∀ | 27 | The unambiguous-duplicate anchor — and the one `REJECT` at 0.8214 that breaks the pattern. |
| `S07_contested_not_merge` | 23 ∀ | 23 | **The over-dedup probes.** High similarity where the incumbent still refused to merge. The closest production comes to an `OVER_DEDUP` case. |
| `S07a_et_earned_2nd` | 16 | 120 | Exploding Topics supplied the missing second source family. |
| `S07b_confirm_reject` | 12 | 63 | Reject agreeing with distillation. |
| `S08_contested_merge` | 30 | 86 | The merges inside the contested band. |
| `S09_b060_070_*` | 24 | 270 | Base rate just below the boundary, 8 per decision. |
| `S10_lt060_*` | 16 | 389 | Base rate well below the boundary. |
| `S11_none_*` | 12 | 314 | No neighbour pool — the vacuous-pairwise control. |

Counts by `decision`: `MERGE_INTO_EXISTING` 70, `PROMOTE_NEW` 49, `REJECT` 49,
`DEFER` 19.

Counts by `decision_category`: `MISSED_DUPLICATE` 68, `CONFIRM_NEW` 49,
`LOW_QUALITY` 29, `NEEDS_MORE_SIGNAL` 16, `CONFIRM_REJECT` 14,
`AMBIGUOUS_TOPIC_JUDGMENT` 7, `OVER_REJECT_PROMOTE` 2, `CONFIRM_DUPE` 1,
`CORRECTED_DEDUP_TARGET` 1.

Five candidates appear more than once — as a DEFER row and again as the terminal
decision that followed it, and one of them across three DEFER rows. That is
deliberate: they are different questions asked against different neighbour pools.

## Three things the set cannot do

**`OVER_DEDUP` has never fired.** The `propose_decision` enum declares ten
categories; production has produced nine. `OVER_DEDUP` means "distillation said
duplicate, promotion says genuinely new", and it has zero instances in five
months. `S07_contested_not_merge` is the substitute — the same judgment reached
without distillation's prompting — but it is not the same case, and no result on
this set may be reported as covering `OVER_DEDUP`.

**The whole dedup branch is starved, and will stay starved.** `CONFIRM_DUPE`,
`OVER_DEDUP` and `CORRECTED_DEDUP_TARGET` all require distillation to emit
`DUPLICATE_OF`. It has done so **7 times in 2,093 candidates (0.33%)**. Worse,
the branch was *broken* until 2026-09-08: the subagent only tested
`startsWith("DUPLICATE_OF_")` and threw on the bare string
([CRMA-1029](https://mcclatchy.atlassian.net/browse/CRMA-1029), fixed in
`148d3a1`). Both surviving rows post-date that fix. Three of the rubric's ten
categories sit behind an input that fires twice a year.

**ET-rescue cases cannot replay faithfully today.** 20 cases in the set have
`ET_WAS_SECOND_SOURCE = true`, and 127 were ET-rescue-routed. The harness forces
`et_rescue: false` — its own note calls ET routing "a lead-side classification
the harness does not replay". The column is carried here so the gap is
measurable, not so it is hidden. `EXPLODING_TOPICS_API_KEY` must also be set, or
`verify_exploding_topics` returns "treat the candidate as un-corroborated" and
the model obeys it.

## Harness changes this set requires

The harness lives on branch `wayfinder/gemini-3-7-flash-model-allocation`, at
`scripts/replay/`. It is **not** on `production` and not on this map's branch.

`lanes/promotion.mjs`'s `cases()` ends with:

```sql
QUALIFY ROW_NUMBER() OVER (PARTITION BY p.CANDIDATE_ID ORDER BY p.DECIDED_AT DESC) = 1
```

That keeps only each candidate's **latest** decision, and **DEFER is never a
candidate's terminal state** — every deferred candidate is re-decided later. So
the clause silently erases all 26 DEFER rows in production, including all 7
turn-exhaustion cases. Asking for one by `--case` does not help: it returns that
candidate's final decision instead. The set carries 19 of those DEFER rows and
none of them is reachable through `cases()` as written.

All three turn-exhausted candidates ended in `REJECT`:

| Candidate | DEFERs | Terminal |
| --- | --- | --- |
| `cand-kvggp06bmrgg2o4j` | 07-11, 07-13, 07-15 | `REJECT` / `LOW_QUALITY` 07-17 |
| `cand-x6gub4aomrp0ovow` | 07-17, 07-19 | `REJECT` / `CONFIRM_REJECT` 07-21 |
| `cand-ycc57ov5mtlagofq` | 09-03, 09-05 | `REJECT` / `CONFIRM_REJECT` 09-07 |

The fix: key `cases()` on **`AUDIT_ID`**, which the manifest carries, instead of
re-deriving a row from `CANDIDATE_ID`.

## The `e864045` fixes, re-checked at scale

The ticket asked whether both hold on the widened set.

**Self-neighbour cut — holds, exactly, across 687 cases.** The cut drops trends
inserted inside the deciding run's apply window (`CHAIN_ID`, −5 min). Every
candidate with a `PROMOTED_TO` was tested:

| Decision | n | inside cut (dropped) | outside cut (kept) |
| --- | ---: | ---: | ---: |
| `PROMOTE_NEW` | 450 | **450** | 0 |
| `MERGE_INTO_EXISTING` | 237 | 0 | **237** |

A perfect split, with no misclassification. Both halves matter: the 450
self-created trends must be dropped, and the 237 merge targets must be kept —
they are the correct answer for those cases, and a cut that caught them would
make every merge case unanswerable. The original fix was measured on 7 cases;
it survives 687.

**`EXPLODING_TOPICS_API_KEY`** is an environment precondition, not a property of
the data, so the widened set cannot confirm it. Check it before each run.
