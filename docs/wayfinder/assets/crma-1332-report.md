<!-- ticket: CRMA-1332 · map: CRMA-1214 -->

# CRMA-1332 prototype: a searchable keyword for the ET oracle

Live run, 2026-09-28, against `jev-1.13.0` and the real Exploding Topics
`/database-search`. Request B only, on CRMA-1222's 116 `needs_corroboration`
cases. Request A answers are reused from `crma-1222-results.jsonl`. The 12
cases with a `candidate_query` keep their CRMA-1222 oracle record, so only the
104 null-query cases get a new keyword. Scoring runs through the unchanged
`crma-1222-score.mjs` (it now takes `ORACLE_FILE` / `SCORECARD_FILE` from the
environment, and reproduces CRMA-1222's 69/136 with no override).

Code: `crma-1332-oracle.mjs` (harness), `crma-1332-score.mjs` (scorer),
`crma-1332-hand-keywords.json` (ceiling arm input). Raw output:
`crma-1332-oracle-<arm>.jsonl`, `crma-1332-scorecard.json`,
`crma-1332-et-cache.json`, `crma-1332-jev-select-cache.json`.

**Bottom line.** A short keyword makes the oracle fire, and its matches are
the right concept. But it does not rescue the multi-AI-agent group: **0 of 19
in every arm, including a hand-written ceiling.** The cause is not the
keyword. For most of those candidates ET tracks only the **parent** concept,
and `oracle_match` correctly rules a parent `adjacent_not_same`. So the
adopt-bar number from CRMA-1222 is **not** mostly an oracle artifact, and the
strict (a3) reading costs real throughput.

## The arms

| Arm | Keyword source | ET calls / keyword |
| --- | --- | --- |
| `trend_topic` | CRMA-1222 baseline: `candidate_query`, else the `trend_topic` sentence | 1 |
| `signal_frequency` | Code only. The 1–3 word n-grams from `trend_topic` + every `signal_text` that recur across the most texts, stopword-trimmed, two-word terms first. No model call. | up to 2 |
| `jev_selected` | Jev cannot generate text, so code proposes up to 30 n-grams and Jev ranks them: one Noul per phrase, "is `phrase` a name for `candidate.trend_topic` itself". Top 2 at p ≥ 0.5, else the top 1. | up to 2 |
| `hand_written_ceiling` | Claude wrote the best short ET terms by hand for the 25 unique multi-AI-agent candidates. Everything else reuses `jev_selected`. **A ceiling, not a production source.** | up to 2 |

`ORACLE_KEYWORD_SOURCE` therefore needs two new values beyond
`candidate_query` / `trend_topic`: `signal_frequency` and `jev_selected`. Each
record carries per-keyword detail (`keywords[]`), and each ET survivor carries
the keyword that found it (`from_keyword`).

## Results

| Arm | Adopt bar (136) | 1 family: matched / promoted (n=77) | multi-AI-agent: matched / promoted (n=19) | Null-query cases promoted (of 104) | Keyword calls with an ET result ≥ 1000 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `trend_topic` | **69** (50.7%) | 39 / 1 | 0 / 0 | 0 | 0 / 104 |
| `signal_frequency` | **72** (52.9%) | 42 / 11 | 0 / 0 | 10 | 151 / 208 |
| `jev_selected` | **73** (53.7%) | 43 / 6 | 0 / 0 | 5 | 24 / 122 |
| `hand_written_ceiling` | **73** (53.7%) | 43 / 6 | 0 / 0 | 6 | 51 / 146 |

The groups are the oracle-route cases inside the 136-case adopt-bar population,
split by vendor-aware family count (`familyDelta`). CRMA-1222 (a3) counted only
the mismatches, 38 and 19. The 1-family group is 77 cases because it also holds
the ledger-`REJECT` cases that the oracle route already matched. The
multi-AI-agent group is exactly two of `{chatgpt, gemini, grok}` in every case,
as CRMA-1222 found.

Cost: the whole re-run cost $0.007 in Jev (the Jev-selection request is
~$0.00005 per candidate). ET calls: 286 for the two automated arms, plus 44
for the ceiling and 7 probes. That is 337 against production's key, all cached
on disk.

## (a) The keyword works, and `signal_frequency` beats `jev_selected`

Only 1 of 116 cases promoted with the `trend_topic` sentence. `signal_frequency`
promotes 11 and `jev_selected` promotes 6.

`jev_selected` picks the **most specific** phrase: "adaptogen mushroom rtds",
"layering pdrn salmon", "taking chitosan supplements". ET misses those. Only 24
of its 122 keyword calls return a result above the floor. `signal_frequency`
picks cruder, broader terms ("creatine", "composters", "vagus"). ET returns
results for 151 of 208 calls, and `oracle_match` then does the precision work.
**The oracle keyword should be broad. `oracle_match` is the precision gate, and
it holds.**

`signal_frequency` also needs no model call. Its cost is ET calls: about two
per oracle case instead of one.

## (b) Hand check: the matches are the same concept

Every `same_concept` answer across the arms, deduplicated to 12 candidate ↔ ET
pairs:

| Candidate `trend_topic` | ET keyword (volume) | Same concept? |
| --- | --- | --- |
| Sparkling Protein Beverages | Sparkling protein water (5,400) | Yes (baseline) |
| Replacing creatine powders with snackable gummy formats | Creatine chews (2,900) | Yes |
| Topical NAD+ serums for cellular longevity | NAD serum (3,600) | Yes |
| Clinical biological age testing | Biological age testing (9,900) | Yes |
| Wearing light therapy glasses for sleep | Light therapy glasses (1,600) | Yes |
| Electric countertop composters | Electric kitchen composter (1,000) | Yes |
| Applying manga-inspired spiky lash styles | Manga lashes (33,100) | Yes |
| Pocket aromatherapy inhalers | Nasal Stick inhaler (4,400) | Yes, loosely — the same product format |
| Using dimmable candle warmer lamps | Candle Warmer Lamp (74,000) | Yes |
| Wearing vagus nerve stimulators | Vagus nerve stimulator (3,400) | Yes |
| The Wet Lash Look | Wet look lashes (4,400) | Yes |
| Vibration plates for at-home bone density training | Vibration plate (301,000); Waver vibration plate (1,300) | Yes for the generic term. **No** for "Waver", which is a brand — but the generic match alone decides the case |

So the precision is 11 of 12 answers exact and 1 wrong answer that changes no
verdict. The false negatives run the other way: `oracle_match` called the ET
keyword "Collagen coffee" `adjacent_not_same` for a collagen-RTD-coffee
candidate. The rubric is strict, not loose.

Three of the rescues (NAD serum, biological age testing, wet look lashes) are
candidates the incumbent **rejected**, and they score as new mismatches. ET
shows real search demand for each. Read those three as the typed path
possibly being right, not as regressions.

## (c) Why the multi-AI-agent group still fails

The ceiling arm asked: with the best keyword a person would write, does ET
corroborate these candidates? For the 25 unique candidates:

| Outcome | n | Examples |
| --- | ---: | --- |
| ET returns the **parent** concept; `oracle_match` rules it `adjacent_not_same` | 18 | "Water stacking" → Hydration Powder, Electrolyte powder · "Layering PDRN and exosome serums" → PDRN, Salmon DNA serum · "Telehealth peptide stacking" → Peptide therapy · "fiber-enriched instant beverages" → Prebiotic soda · "stress fitness adaptogen RTDs" → Adaptogen drink |
| ET has nothing above the floor | 6 | "grocery tourism", "savory cocktails", "nad nasal spray", "chitosan", "glp-1 protein", "probiotic feminine wash" |
| Rescued | 1 | "Relaxed wide-leg denim replacing skinny jeans" → Wide-leg jeans, Baggy jeans (this case sits outside the 19 scored ones) |

The AI discovery agents propose **narrow framings** of trends: a composite
("layering X and Y"), a use case ("for bone density"), or a coined name
("water stacking", "swangy"). ET tracks the parent category. Under
`oracle_match`'s own `not_for` rule — "a keyword that names the category the
candidate belongs to" — a parent is not corroboration, and Jev applies that
rule consistently. A better keyword cannot change this.

## What this decides

The ticket's fork: *if the oracle rescues a reasonable share of the
multi-AI-agent group, the adopt-bar number is mostly an oracle artifact; if it
still fails, the strict (a3) reading costs real throughput.*

**It still fails.** 0 of 19 scored, 1 of 25 at the hand ceiling. CRMA-1222's
blast radius stands: about 41.8% of historical subagent-decided promotions
(319 of 763) are multi-AI-agent-only, and under (a3) almost all of them will
reject.

The keyword source is a separate, settled improvement. `signal_frequency`
should replace the `trend_topic` fallback whatever the (a3) outcome. It is
cheap, it has no model call, and its matches pass the hand check. It lifts
the 1-family group, not the multi-AI-agent group.

## What this run does not resolve

- **Whether ET's parent concept should corroborate a narrow candidate.** That
  is a rubric change to `oracle_match` (`not_for`), and it has a real cost: it
  would count "Peptide therapy" as proof that "Telehealth peptide stacking" is
  its own trend.
- **The ET monthly quota.** CRMA-1220 states 1,000 requests per month;
  `docs/exploding-topics-api.md` says no monthly cap, and ET returns only
  per-minute headers (`x-ratelimit-limit: 60`). `signal_frequency` roughly
  doubles oracle ET calls per case, so this matters if the cap is real.
- **Whether the three incumbent-rejected rescues are right.** A person should
  read those three candidates.
