<!-- ticket: CRMA-1222 · map: CRMA-1214 -->

# CRMA-1222 prototype: the pairwise duplicate check on the widened replay set

Live run against `jev-1.13.0`, 2026-09-21/22, over all 187 cases in the CRMA-1216
widened replay set — Request A (the pairwise check) plus Request B (the
Exploding Topics oracle, CRMA-1255 unblocked this on 2026-09-22). Code:
`crma-1222-jev-client.mjs`, `crma-1222-family.mjs`, `crma-1222-build-cases.mjs`,
`crma-1222-run.mjs`, `crma-1222-oracle.mjs`, `crma-1222-score.mjs`. Raw
per-case answers: `crma-1222-results.jsonl` (Request A),
`crma-1222-oracle-results.jsonl` (Request B). Full scorecard:
`crma-1222-scorecard.json`.

**Bottom line: this run reaches a real, well-powered adopt-bar measurement —
136 of 187 cases scored, not the earlier 17 — and the result is a genuine
fail against the map's stated adopt bar (match the incumbent ~7/7-equivalent):
50.7% (69/136).** But the failure is not uniform, and the dominant failure
mode (85% of mismatches) traces to one mechanism worth reading carefully
before it decides the verdict: **the ET oracle almost never succeeds**, and
when it can't, `needs_corroboration` collapses to `REJECT` by design. Whether
that collapse is *correct* (the typed path being properly conservative
against an incumbent whose corroboration gate is known-dormant) or *too
strict* (a rubric miscalibration) is a real interpretive fork — see (a3).
This is not mine to call unilaterally; it needs your read.

## Bucket breakdown (187 cases)

| Bucket | n | What it means |
| --- | ---: | --- |
| `normal` (scored on adopt bar) | 136 | Neither source-data-gap nor a CRMA-1231 special class |
| `source_data_gap` | 21 | `STG_TREND_CANDIDATES.SOURCE_BREAKDOWN` / `SUPPORTING_SIGNAL_IDS` are empty **today** for these candidates, even though the historical decision had real evidence |
| `rule4_family_mismatch` | 12 | Same-vendor-miscounted by `sourceFamilyOf()` — scored against the corrected family count, not the ledger |
| `rule2_needs_signal` | 12 | CRMA-1231 rule 2 — labeled cohort, not scored pass/fail |
| `rule1_tombstone` | 5 | CRMA-1231 rule 1 — the 3 turn-exhaustion candidates' DEFER rows, scored against eventual REJECT |
| `rule3_level0` | 1 | `not_a_topic` with real (non-empty) evidence — hand-inspect only, zero production precedent |
| `et_unavailable` | 0 | Fully resolved this pass |

## (a1) The ET oracle almost never fires — and this is the real story

116 of 187 cases (62%) rounded `evidence_quality` to `needs_corroboration`
and needed Request B. Run live against the real `/database-search` API:

- **115 of 116 resolved REJECT / INSUFFICIENT_EVIDENCE.** Only 1 resolved
  PROMOTE_NEW (`cand-zsfynoogmsmiohzo`, keyword "sparkling protein",
  `same_concept` at 0.48 confidence against "Sparkling protein water").
- **By keyword source: 0 of 104 `trend_topic`-fallback calls matched ET at
  all** (`total > 0`) — verified live and by hand (a raw call for "Wearable
  Cooling Accessories" returns the genuine ET miss sentinel `{"message":"No
  meta trends found."}"`, HTTP 200 — not a client bug). **5 of 12
  `candidate_query` calls matched, 4 cleared the 1000-volume floor.**
- This is a **mechanical, not a judgment, bottleneck**. `/database-search` is
  a keyword-lookup service; it needs a short, atomic term. `candidate_query`
  is null on 78% of candidates (CRMA-1220), so 104 of 116 oracle calls fired
  on a multi-word descriptive sentence by construction, and ET's fuzzy search
  cannot place those. The oracle path, as specified, can only ever rescue the
  ~22% of candidates that carry a real `candidate_query`.

## (a2) Adopt-bar scorecard — 136 cases, 69/136 matched (50.7%)

Well under the adopt bar. Mismatch breakdown by decision rule:

| Ledger → Composed | n | Rule |
| --- | ---: | --- |
| PROMOTE_NEW → REJECT | 34 | `oracle_decided` (ET found nothing) |
| MERGE_INTO_EXISTING → REJECT | 23 | `oracle_decided` (ET found nothing) |
| MERGE_INTO_EXISTING → PROMOTE_NEW | 7 | `stands_alone_promote` |
| REJECT → PROMOTE_NEW | 2 | `stands_alone_promote` |
| REJECT → MERGE_INTO_EXISTING | 1 | `neighbour_merge` |

**57 of 67 mismatches (85%) are the oracle route** — `evidence_quality`
correctly (per its own rubric) judged the evidence as single-origin, the
oracle then failed to corroborate (almost always because it had nothing
searchable to try), and composition rule 4 sent the case to REJECT. The other
10 are the same `stands_alone`-vs-`same_thing` disagreement pattern the
17-case sample already showed.

## (a3) The oracle mismatches split into two very different stories

Not all 57 are the same finding. Splitting by the vendor-aware family count
(`familyDelta`, CRMA-1231 rule 4's own re-derivation):

| | n | What it looks like |
| --- | ---: | --- |
| **1 vendor family** (genuinely single-origin) | 38 | Thin evidence — often one signal from one agent. e.g. `cand-7oz872e5msrlmbou` "Mass Market HOCl Skin Sprays", `agent_chatgpt_discovery:1`, ledger MERGE_INTO_EXISTING. REJECT here looks like the typed path correctly declining evidence the incumbent's known-dormant corroboration gate let through — the same class as the 43-promoted-on-same-vendor-corroboration defect CRMA-1220 measured, just not the specific miscounting bug. |
| **2+ vendor families** | 19 | **Every single one is exactly two of `{chatgpt, gemini, grok}`** — the three AI-discovery-agent brands. Never Bluesky, Google Trends, Amazon, or an editorial outlet. e.g. `cand-79raryadmr3l3g19` "Purchasing directly from sponsored carousels inside conversational AI chats", `agent_chatgpt_discovery:3` + `gemini_other:1`, ledger PROMOTE_NEW. |

**The 19-case group is a genuinely new finding, not an oracle-starvation
artifact.** `evidence_quality`'s instructions never mention vendor identity —
the rubric asks whether "the accounts reached the topic independently of
each other." On these 19 cases, Jev is reading two *differently-branded* LLM
discovery agents as **not independent of each other**, because both are the
same *kind* of evidence-generation mechanism (an LLM inferring a trend from
its own training/search), not a directly-observed signal like a real
Bluesky post or a Google Trends spike. CRMA-1231's rule 4 fix (vendor-aware
family counting) would count `chatgpt` + `gemini` as 2 independent families —
and still be wrong by this stricter reading. **This is a question the map
has not addressed: should "two AI discovery agents from different vendors"
count as independent corroboration at all?** If Jev's read is right, this is
the typed path finding a *second*, deeper instance of the same defect class
CRMA-1220 measured — one the "fixed" family-counter still misses. If Jev's
read is too strict, `evidence_quality`'s instructions need a carve-out. This
needs your judgment, not a default.

## (b) Fit test 4 — confidence separation (unchanged by the oracle merge)

| | n | mean `evidence_quality` confidence | mean top-`pair_sameness` confidence |
| --- | ---: | ---: | ---: |
| known-easy (`S06_ge080_all`, `S11_none_*`) | 39 | **0.709** | 0.934 |
| known-ambiguous (`S07_contested_not_merge`, `S08_contested_merge`) | 53 | **0.571** | 0.976 |

`evidence_quality`'s confidence separates in the right direction (easy cases
read 14 points more confident than ambiguous ones). **`pair_sameness`'s
confidence does not separate, and runs backwards**: contested cases score
*higher* mean top-pair confidence (0.976) than unambiguous ones (0.934). A
genuine caution for CRMA-1223: routing on `pair_sameness` confidence alone
may not discriminate hard pairs the way the map hoped.

## (c) The near-synonym residual risk — still NOT resolved

Unaffected by the oracle run (these hit `not_a_topic`, never
`needs_corroboration`). The two closest real-world instances of CRMA-1217's
residual-risk class in this replay set (`cand-gyzc2tofmteds12q` /
`cand-kbzkbavbmtdo1pum`, both "cottage cheese...") both landed in
`source_data_gap` — empty `SOURCE_BREAKDOWN`/`SUPPORTING_SIGNAL_IDS` in
`STG_TREND_CANDIDATES` today. **CRMA-1217's original `cottage cheese ice
cream` vs `cottage cheese frozen dessert` pair, run bare with no supporting
evidence, still lands unsettled** (score 1.24, confidence 0). The residual
risk stands exactly where it stood: **unsettled**. This ticket does not
close it.

## (d) Criteria vs bare-instructions arm (unaffected by the oracle merge)

Measured over every neighbour pair fired in both arms (555 pairs per noul):

| Noul | mean \|Δ\| | max \|Δ\| | flips ≥0.3 |
| --- | ---: | ---: | ---: |
| `is_same_recurring_topic` | 0.013 | 0.25 | 0 |
| `recurrence_deserves_own_row` | 0.052 | 0.19 | 0 |
| `is_narrower_instance` | 0.046 | 0.29 | 0 |

Criteria make almost no measured difference — zero pairs crossed a
0.3-magnitude band. Confirms CRMA-1217's finding (the nouls were clean
*without* criteria) at scale.

## (e) Recurrence-override firing rate — zero (unaffected)

`recurrence_blocked_merge` never fired across all 187 cases. Unobserved, not
confirmed absent — CRMA-1223 should treat this as an unexercised mechanism.

## (f) Cost and latency — real numbers, oracle included

- Request A: **$0.0547** for the whole 187-case run, $0.000292/candidate mean.
- Request B (oracle): **116 ET calls** (free — no per-call ET pricing data
  captured this session) **+ 4 Jev `oracle_match` calls** (negligible
  cost, well under $0.0001 total — 1-5 questions each, tiny state).
- **Cost and latency remain non-issues at production volume.** Confirms fit
  tests 1 and 2 hold.

## (g) The vendor-family fix — validated 12/12 (unaffected by the oracle merge)

CRMA-1231's rule 4 flagged 12 cases where `sourceFamilyOf()` miscounts a
same-vendor pair as independent (11 `gemini_*` vertical-shard, 1
`grok_live`). **All 12 correctly avoided `stands_alone`** — teaching
independence in words, not counts, closes the exact defect CRMA-1220
measured on every case this set could test it against. See (a3) for the
*second*, broader instance of the same defect class this run also surfaced.

## (h) Rule 1 (tombstones) and Rule 2 (`NEEDS_MORE_SIGNAL`) — now fully resolved

**Rule 1: 3/5 match.** The 3 rows for `cand-kvggp06bmrgg2o4j` (previously
unscored) now resolve REJECT via the oracle, matching the eventual REJECT —
3/3. The other 2 (`cand-x6gub4aomrp0ovow`) still resolve `stands_alone` →
PROMOTE_NEW against an eventual REJECT, unaffected by this pass — still worth
a human look (CRMA-1219's regression check, in the direction it didn't
anticipate: a turn-budget casualty that, given its *full* neighbour pool
instead of the zero neighbours the exhausted incumbent saw, reads as
confidently real).

**Rule 2: 2/12 agree — unchanged, but now fully resolved rather than mostly
unscored.** Per CRMA-1231 this cohort is explicitly *not* scored pass/fail
(a hold buys zero new evidence per CRMA-1219, so a later verdict may just be
model noise). Still worth naming plainly: **all 10 of the previously-unscored
rows in this cohort resolved REJECT via the oracle, against candidates the
incumbent eventually promoted.** Read alongside (a1) — this is the same
mechanical oracle-starvation pattern, not new evidence about the cohort
itself.

## What this run does not resolve

- **The interpretive question in (a3)** — the map's actual next decision.
- **The near-synonym residual risk** — see (c). Still unsettled.
- **Cross-question interference** (one request per candidate vs one per
  pair) — not measured this run.
- **`recurrence_blocked_merge` in practice** — mechanism exists, never fired.
- **`pair_sameness` as a routing confidence signal** — (b) found it runs
  backwards; needs attention before CRMA-1223 leans on it.
- **Whether a shorter, code-derived keyword (rather than the raw
  `trend_topic` sentence) would let the oracle actually fire** on the 78% of
  candidates with no `candidate_query` — untested; would require a design
  change, not a re-run.
