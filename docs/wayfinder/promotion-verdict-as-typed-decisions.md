<!-- map: CRMA-1214 -->

# Map: promotion's verdict as typed decisions (TypeSafe Jev)

## Destination

An **adopt-or-reject decision** on whether TypeSafe's **Jev** "System One" model can fit
promotion's decision architecture **at all**. This is an exploratory feasibility verdict,
not an assumed rebuild — the map is allowed to end in "no". If the verdict is adopt, it
also carries promotion's **rubric re-expressed as typed atomic questions** (Choice / Score
/ Noul) composed in application code.

Scoped to the **promotion agent only**. Designed now; ships **after** promotion's
lift-and-shift extraction to Cloud Run.

## Notes

- **Domain**: read `CONTEXT.md` before writing about signals, trends, candidates, or the
  neighbor pool. Tracker contract is `docs/agents/issue-tracker.md`.
- **Skills**: `/grilling` + `/domain-modeling` for decision tickets, `/research` for
  research tickets, `/prototype` for the prototype ticket, `pipedream-synced-project` for
  anything touching the current workflow.
- **Vendor docs**: [docs.typesafe.ai](https://docs.typesafe.ai/introduction); the index is
  at `/llms.txt`. The nearest template for the pairwise check is
  `cookbooks/entity_alignment`; the routing pattern is `patterns/confidence-routing`.
- **Treat every vendor number as directional.** All Jev evidence to date is TypeSafe's own
  cookbooks, on small samples (450 pairs, 60 filings), vendor-run. Nothing is independently
  verified. No load-bearing claim may rest on it.
- **Write the spec reusably, but do not generalise.** Three other agents share promotion's
  shape — a Gemini tool loop ending in a terminal typed judgment: the distillation
  cluster-agent, `lifecycle-agent`, and `lifecycle-attribution-agent`. Generalising is out
  of scope, but avoid promotion-specific framing that would block reuse later. CRMA-429
  paid for this lesson with a mid-map destination redraw.
- **Never commit this map to `production`.** A commit to the default branch is a Pipedream
  deploy of every changed workflow.

## Established facts

<!-- Measured state of the world. Falsified by RE-MEASUREMENT, never by a decision. -->

- **Promotion's decision surface is already four typed questions in a tool loop.**
  `compare_topics` takes a 5-value `my_judgment` enum (`same_topic`,
  `hierarchical_distinct`, `temporal_recurrence_same`, `temporal_recurrence_new_instance`,
  `different_topic`) plus a free-text `reasoning`. `propose_decision` is terminal and takes
  a 4-value `decision` (`PROMOTE_NEW | MERGE_INTO_EXISTING | REJECT | DEFER`), a 10-value
  `decision_category`, and a **required** prose `rationale`. Two other tools are pure
  fetches: `query_neighbor_details` and `verify_exploding_topics`.
  _Source: repo read 2026-09-20, `promotion-agent-p_yKCmm9r/run_subagent/entry.js:139-219`._
- **`verify_exploding_topics` asks the model to do arithmetic.** Corroboration requires
  "`absolute_volume` above a small floor" — a numeric comparison delegated to the LLM.
  _Source: `run_subagent/entry.js:171`, 2026-09-20._
- **The full DEFER population, whole-ledger.** 2,115 candidates judged; **40 DEFER rows across
  27 candidates (1.3%)**; **zero** held today and **zero** ever stranded. Two disjoint groups:
  **33 rows / 24 candidates** chose `NEEDS_MORE_SIGNAL` deliberately, and **7 rows / 3
  candidates** are machine tombstones stamped `AMBIGUOUS_TOPIC_JUDGMENT` — the model has never
  once chosen that category itself. All 3 tombstone candidates ended REJECT after 99–153 h.
  Outcomes by defer count: 1→20 (8P/12R), 2→5 (3P/2R), 3→1 (R), 7→1 (**P**).
  _Source: [CRMA-1219](https://mcclatchy.atlassian.net/browse/CRMA-1219), 2026-09-20 — whole
  ledger, extending CRMA-1216's gemini-pin window and CRMA-733's "5 of 38"._
- **The 48 h hold buys no evidence, and the promised cap never existed.** Across all 27
  deferred candidates, cluster size and source count are **unchanged in 27/27** between the
  first DEFER row and the final row — `STG_TREND_CANDIDATES` is written once and never grows,
  and lifecycle-attribution feeds **trends**, not candidates. Only the top neighbour moved, on
  2 of 27. **No deferred candidate has ever ended `MERGE_INTO_EXISTING`**, so the hold's reason
  for existing has never once paid. Meanwhile `sql/seed_prompts_promotion.sql:83` promises a
  3-defer cap that nothing enforces — `cand-6nm5r52smodzwq5t` deferred **7 times with 0 loop
  failures and then PROMOTED**. _Source: CRMA-1219, 2026-09-20; cap defect from
  [CRMA-726](https://mcclatchy.atlassian.net/browse/CRMA-726) defect 9._
- **`max_iterations: 6` has zero margin.** The incumbent burns all 6 turns, and the bare
  fallbacks at `run_subagent/entry.js:699` (crash) and `:717` (no terminal call) turn that into
  a verdict. _Source: repo read 2026-09-20._
- **Promotion's pin moved to `gemini-3.7-flash` on measured parity.** 7/7 identical
  `decision` and `target_trend_id` against the incumbent's re-run, schema clean, −17.2% cost
  at Jan-2027 rates. `decision_category` differed on 2 of 7 and **is noise** — on one case
  the incumbent's own re-run drifted from its own ledger record.
  _Source: [CRMA-733](https://mcclatchy.atlassian.net/browse/CRMA-733), 2026-08-20._
- **Cost is not a lever on this lane.** Worst production run in 21 days: **$0.0538** against
  a `budget_usd` of $0.15 — ~5× headroom even with the rate table wrong. The binding gate is
  `max_iterations`, not budget. _Source: CRMA-733, 2026-08-20._
- **Promotion stores no turn telemetry.** `FCT_PROMOTION_LEDGER.ITERATION` is the *lead's*
  retry counter (values 1 and 2 only), not the subagent's turn count — so the lane's one real
  failure mode is invisible in production today. `FCT_TREND_LIFECYCLE_LEDGER` is the fleet's
  exemplar: it already persists `TOOL_CALLS_JSON`, `STOP_REASON`, `MODEL_USED` and per-run
  cost. _Source: CRMA-733 / CRMA-734, 2026-08-20._
- **The ET-rescue path carries 28 of 60 promotions** in 21 days — not an edge case.
  _Source: CRMA-733, 2026-08-20._
- **A replay harness exists, and it was measuring an artifact until `e864045`.** Two defects,
  both fixed: a promoted candidate was returned as its own nearest neighbour (fired on **4 of
  7** cases), and `EXPLODING_TOPICS_API_KEY` was unset so both models rejected every
  single-family candidate. _Source: [CRMA-729](https://mcclatchy.atlassian.net/browse/CRMA-729)
  / CRMA-733, 2026-08-20._
- **The rubric is a governed prompt row.** `promotion.subagent.decision_rubric` is
  `DIM_LLM_PROMPT` **version 3**, and it appears in the audit agent's prompt-drift manifest
  at `audit-agent-p_xMC9nm3/workflow.yaml:530` and `:578` (both the `sql.value` and
  `sql.query` copies). _Source: repo read 2026-09-20._
- **An account and API key already exist.** The key is in the macOS keychain under service
  `typesafe-trend-tree-scoping`, account `mmena@mcclatchy.com` — naming that mirrors the
  `brightdata-api` / zone `trend_tree_scoping` precedent. Live Jev calls are possible now.
  **The Secret Manager entry now exists too** — `typesafe-api-key` in `mcc-crm-automations`
  (v1, 107 chars, verified), readable by `crm-runtime@` through its existing project-level
  `secretAccessor` binding, so no per-secret grant is needed. TypeSafe still has **no mention in
  `CLAUDE.md`**. _Closed by CRMA-1215, 2026-09-20._
- **Jev's documented hard limits.** It does **not** generate text. It does **not** do arithmetic or
  date reasoning — both must be precomputed in code and passed in. No structural invariant is
  guaranteed, so no cross-question arithmetic identity may be assumed (`P(yes) + P(no)` need not sum
  to 1 across separate Noul calls). Text-only, English-primary. Injected content in `state` is not
  filtered. Fan-out is many questions in **one** call, so sub-questions do not multiply round-trips.
  **Confidence is not the winning probability** — it measures how concentrated the whole
  distribution is (`(3 × top_prob − 1) / 2` for 3 options). Choice and Score carry it; a bare
  **Noul does not**, its 0–1 probability *is* the whole signal.
  _Source: docs.typesafe.ai, 2026-09-20._
- **No vendor cookbook is evidence — they are shape templates only.** `entity_alignment`, the
  nearest published template (one 3-level Score plus 3 supporting Nouls over 450 pairs, decided by
  **rounding the score**), loads the benchmark's own answer key and **never scores against it**; its
  80/11/9 figures are an outcome split, not a measurement. Every cookbook ships a `json_cache.json`
  that replays its numbers without calling the API, and those numbers pin `jev-1.12`. Take the
  shapes, never the accuracy. _Source: [CRMA-1217](https://mcclatchy.atlassian.net/browse/CRMA-1217),
  2026-09-20._
- **Jev does not buy determinism. TypeSafe's own consistency cookbook says so.** Picked labels
  flip inside a single condition — "**including TypeSafe**" — with 90.8% plurality agreement
  over 15 repeats and flips on 2 of 8 questions. That is the **same failure shape** as
  CRMA-733's `decision_category` drifting on 2 of 7. Only deriving a value in code removes
  that noise; asking a model for it does not.
  _Source: CRMA-1217, `cookbooks/consistency_choice_cookbook`, 2026-09-20._
- **The vendor's only published confidence measurement is 60 SEC filings** — 30 sure / 30 unsure,
  90% vs 40% correct, no clustering at the top. It covers no pairwise-sameness task, so fit test 4
  had to measure promotion's own shape; that live result governs. _Source: CRMA-1217, 2026-09-20._
- **The neighbor pool is hard-capped at 8, guarded three times over**: a similarity floor of
  cosine 0.50, a `ROW_NUMBER() <= 8` in the SQL, and a defensive `.slice(0, 8)` at
  `promotion-agent-p_yKCmm9r/handle_request/entry.js:163`. It is **not** variable-unbounded, which
  collapses most of the fan-out risk this map was charted to investigate. A total fan-out is
  therefore at most 8 pairwise questions per candidate.
  _Source: CRMA-1217 / CRMA-1218 repo read, 2026-09-20._
- **Promotion is NOT inside the dispatcher's synchronous chain.** It sits **upstream** and fires the
  dispatcher **fire-and-forget** (`promotion-p_xMC99jg/fire_enrichment_chain/entry.js:7-8`). Its
  latency ceiling is therefore **self-imposed, not inherited** — 0.555 s measured against a 240 s
  ceiling. Two of this map's charter-time framings assumed the opposite.
  _Source: [CRMA-1218](https://mcclatchy.atlassian.net/browse/CRMA-1218), 2026-09-20._
- **Batch-wide fan-out fits, but the docs predicted otherwise.** 15 candidates in one `state`
  measures 29.6k tokens / 1.065 s against the 32k cap, breaking only at 50 — CRMA-1218's own
  doc-derived estimate called 15 marginal, and measurement refuted it. That shape costs ~$0.0015
  per run; the recommended per-candidate shape costs less (see pricing below).
  _Source: CRMA-1218, 2026-09-20._
- **The error surface is polymorphic, and `error_type` is not always there.** Four shapes measured:
  `401` → object with `error_type`; `400` → object with `error_type` (capacity); `400` → a **bare
  string** (semantic); `422` → a **list** of Pydantic records (schema). So **422 = schema violation,
  400 = semantic or capacity**, and code **must type-check `detail` before reading `error_type`** —
  it is absent on two of the four. 400/401/422 all sit correctly outside the retryable set.
  **Keep the SDK's retry defaults and do not pin `httpStatuses`** — the default literal is
  `{408, 429, *range(500, 600)}`, so 529 is already covered. The hazard is the Python docs'
  **example override** `http_statuses={429, 500, 502, 503, 504}`, which silently drops it.
  The 529 path is still **unverified** — ~85 requests have never drawn a 429 or a 529.
  _Source: CRMA-1218 + [CRMA-1215](https://mcclatchy.atlassian.net/browse/CRMA-1215), 2026-09-20._
- **Pricing is $42/Btok input, output free — and promotion's real shape measures $0.000038 per
  candidate.** 904 input tokens for one candidate against 8 neighbour Nouls; **$0.00057 per
  15-candidate run**, 0.04% of the $1.50/chain budget. Rate limits are 250k tokens/s and 1,200
  rpm — but **no rate-limit headers exist on any response**, so the caps are invisible until the
  429 fires. `x-typesafe-request-id` is the only correlation handle the vendor returns.
  Budgets: 64k/request (state + all questions), 32k (state + longest question); Choice caps at 255
  options, Score at 2–10 levels. _Source: CRMA-1215 live measurement, 2026-09-20._
- **The decision boundary is ~0.70 cosine, and the contested band is narrow.** Across the
  1,109 replayable candidates, `MAX_NEIGHBOR_SIM` separates the decisions almost cleanly —
  PROMOTE tops out at **0.763** (only 2 cases ≥ 0.75), MERGE runs to 0.904, and above 0.82
  the incumbent merges every time but once. The contested 0.70–0.80 band holds 109 cases,
  of which only **23 went not-merge**. Separately, **28% of candidates (314) have no
  neighbour pool at all**, so the pairwise check is vacuous for them.
  | sim | PROMOTE | MERGE | REJECT |
  |---|---:|---:|---:|
  | none | 164 | 0 | 150 |
  | <0.60 | 193 | 22 | 174 |
  | 0.60–0.70 | 80 | 103 | 87 |
  | 0.70–0.80 | 13 | 86 | 10 |
  | ≥0.80 | 0 | 26 | 1 |
  _Source: CRMA-1216, 2026-09-20._
- **`OVER_DEDUP` has never fired, and three of the ten categories are structurally starved.**
  Production has produced **9 of the 10** declared `decision_category` values in five months.
  `CONFIRM_DUPE`, `OVER_DEDUP` and `CORRECTED_DEDUP_TARGET` all require distillation to emit
  `DUPLICATE_OF`, which it has done **7 times in 2,093 candidates (0.33%)** — and that branch
  *threw* until `148d3a1` ([CRMA-1029](https://mcclatchy.atlassian.net/browse/CRMA-1029))
  landed on 2026-09-08. Both surviving rows post-date the fix. No result may claim
  `OVER_DEDUP` coverage. _Source: CRMA-1216, 2026-09-20._
- **Distillation's verdict is `REAL_TREND` 99.7% of the time.** 1,132 of 1,135 gemini-pin
  decisions arrived on that verdict. It is a near-constant field, while promotion finds **235
  duplicates of its own** under it. The verdict carries almost no information — which is an
  argument to keep it out of `state` independent of the bias measurements.
  _Source: CRMA-1216, 2026-09-20._
- **1,017 of the 2,264 ledger rows are not subagent decisions**, and `MODEL_USED` cannot
  separate them: `proc_promotion_apply.sql:142` stamps a stale `'claude-sonnet-4-6'` literal
  on every lead-side row, including rows written last week. Discriminate on **zero tokens**.
  The lead decides `REJECT`/`LOW_QUALITY` (873) and `MERGE_INTO_CANDIDATE`/`INTRA_BATCH_DUPE`
  (42) deterministically, with no model call; 102 more are a 2026-04-28 backfill.
  _Source: CRMA-1216, 2026-09-20._
- **`jev-latest` is a moving alias and must be pinned.** `jev-latest` and `jev-preview` both resolve
  to `jev-1.13.0` today; the cookbooks' numbers pin `jev-1.12`. Production must name the explicit
  version, or a vendor bump moves the rubric underneath a governed `DIM_LLM_PROMPT` row with nothing
  to flag it. _Source: CRMA-1215, 2026-09-20._

## Standing constraints

<!-- Settled decisions in binding present tense. Overturned only by another decision. -->

All settled during charting, 2026-09-20. No tickets sit behind these.

- **This is its own map**, linked `Relates` to CRMA-429 and CRMA-726. It is charted separately
  because it changes *what questions get asked* — not the runtime (CRMA-429) and not the model
  pin (CRMA-726, closed as CRMA-733).
- **Design now, ship after the extraction.** Promotion moves to Cloud Run as a faithful
  lift-and-shift first, which keeps CRMA-429's reusable template honest. The Jev redesign lands
  as a second, replay-proven change on that runtime. Coupling runtime + vendor + architecture in
  one move would make any regression unattributable — CRMA-726's discipline was one variable per
  lane.
- **The destination is a decision; the spec is contingent on it.** The map may die at the vendor
  gate without ever producing a spec.
- **Scope is evidence-led, and the pairwise check is the proving ground.** `compare_topics` is
  already an enum, the `entity_alignment` cookbook nearly templates it, and it is where the
  turn-budget bug actually bites. Prove Jev there first; let that evidence decide whether the
  terminal verdict follows.
- **Promotion only.** Reuse is a Notes-level caution, not a commitment.
- **There is no human in the loop, and the map must not invent one.** Low-confidence candidates
  get a terminal verdict; nothing waits for a person.
- **DEFER does not exist. The verdict set is `PROMOTE_NEW | MERGE_INTO_EXISTING | REJECT`.**
  A machine no-decision is an **error**, never a verdict: it retries with no hold, bounded at 3
  attempts, then parks. A thin-but-plausible candidate is rejected as `INSUFFICIENT_EVIDENCE`,
  the one rejection carrying a revisit disposition. Never tell the model a defer or retry count.
  This closes CRMA-726 defect 9 outright — there is no defer left to cap.
  _Decided by [CRMA-1219](https://mcclatchy.atlassian.net/browse/CRMA-1219), 2026-09-20;
  supersedes the charter constraint that routed low-confidence candidates to DEFER._
- **No deterministic control arm.** The direction of travel is *away* from deterministic gates;
  the rubric is being developed to lean on reasoning, not thresholds on precomputed fields.
- **No data-handling or legal review is required.** Trend data is public and openly available;
  no McClatchy data is transmitted to TypeSafe. Vendor onboarding is still needed for an account,
  key, pricing and limits — but not as a privacy gate.
- **Jev question definitions live in `DIM_LLM_PROMPT`, not in code.** A Choice's option text and
  a Score's level wording *are* the rubric. Keeping them as rows preserves the daily prompt-drift
  audit (CRMA-469), keeps rubric iteration out of the deploy path, and honours the repo's
  contract that prompt changes ship as a `sql/update_prompts_*.sql` migration plus a manifest bump.
- **Rubric development is in scope for this map.** The map **decides** the rubric; `/to-tickets`
  ships the migration. This map makes **no live `DIM_LLM_PROMPT` edit** — a live edit changes
  production promotion behaviour immediately, and the map is still deciding whether the vendor works.
- **There is no narrator. Promotion becomes fully typed.** No model writes prose anywhere in the
  redesigned path. `FCT_PROMOTION_LEDGER.RATIONALE` **keeps its column** and carries a
  deterministic summary assembled in code from the answers and their distributions — e.g.
  `MERGE_INTO_EXISTING: 3/5 neighbors same_topic, top 0.91 conf on <trend_id>`. It cannot
  rationalise a wrong verdict, which was the original argument against the prose. The
  **distributions** are also the rubric-development instrument — a rubric level that returns flat
  splits across many candidates is provably badly drawn, which no prose would show.
- **The four fit tests are resolved, all against the live `jev-1.13.0` API. None kills the map.**
  **(1) Question cap PASSES** with ~350× headroom — 8 needed against a ~2,800 ceiling, and there is
  no silent truncation (3,000 returns `HTTP 400 max_tokens_exceeded`). **(2) Latency PASSES** at
  ~0.2% of budget — promotion's 8-question shape measures 0.555 s median, and 1→120 questions moves
  the median only 7 ms. **(3) The 5-value enum does survive as one Choice**, but only with
  structured `what`+`not_for` criteria; two Nouls beat it outright, so deriving the labels in code
  remains the recommendation. **(4) Confidence separation PASSES for Score and FAILS for Choice** —
  the map's most important finding, and it contradicts the vendor docs: **route on the Score's
  confidence, never the Choice's.** Detail and figures live on the tickets.
  _Source: [CRMA-1218](https://mcclatchy.atlassian.net/browse/CRMA-1218) (1, 2) and CRMA-1217
  (3, 4), 2026-09-20._
- **The residual risk is one specific case, not the architecture.** The near-synonym pair — which is
  promotion's real `MISSED_DUPLICATE` / `OVER_DEDUP` failure mode — **never settled across 11 calls**,
  and a supporting `is_narrower_instance` Noul false-positived on it at 0.82. That single case is what
  CRMA-1222 must resolve on the widened replay set. _Source: CRMA-1217, 2026-09-20._
- **Two measured rules govern what may enter `state`.** Irrelevant prose moved p(same_topic)
  0.61 → 0.50 and confidence 0.51 → 0.38. A debug id **whose value named an outcome** biased the
  answer 0.61 → 0.74. So `state` carries no decorative fields and no verdict-bearing fields — which
  independently argues for keeping **distillation's prior verdict out** of the payload, where today's
  prompt invites the model to override it. _Source: CRMA-1217 live validation, 2026-09-20._
- **The adopt bar:** match the incumbent's 7/7 on `decision` and `target_trend_id`, **and**
  never let a machine failure reach the ledger as a verdict. Cost is a tiebreak only — this
  lane is already cheap. The same bar applies to every arm tested. Because the incumbent's
  DEFER rows have no counterpart in the new three-value verdict set, scoring those cases needs
  a ground-truth rule — [CRMA-1231](https://mcclatchy.atlassian.net/browse/CRMA-1231).

## Decisions so far

<!-- The index — one line per closed ticket.

     - [<closed ticket title>](link) — **Decided:** <the answer, one line>
       **Binds:** <what downstream work this constrains — or `nothing further`>

     `resolve` appends here. Do not hand-edit while a session is running. -->

- [Research: can Jev's primitives express promotion's judgments without losing distinctions](https://mcclatchy.atlassian.net/browse/CRMA-1217) — **Decided:** Yes, with the labels derived in code. Two Nouls beat the 5-value enum outright and are the recommended shape (`is_same_recurring_topic` ≥0.84 on all 8 recurrence pairs / ≤0.14 on all 6 others; `recurrence_deserves_own_row` splits temporal-same 0.14–0.24 from new-instance 0.80–0.88 with nothing between). ET corroboration is a 3-level Score, not a Noul. `decision_category` is derived in code, never asked. Verified on 35 live `jev-1.13.0` requests over 12 synthetic pairs.
  **Binds:** **Route on the Score's confidence, never the Choice's** — the single most important finding, and it contradicts the vendor docs: Choice confidence does NOT drop on hard cases (0.93 on the most ambiguous pair, 0.75–0.84 on a near-empty state) while Score confidence behaves as documented. Criteria wording is load-bearing: structured `what`+`not_for` got 6/6 at conf 0.75–1.00, one-sentence descriptions were unstable (2/3), and bare enum names — effectively what today's Gemini schema passes — COLLAPSE the temporal pair at conf 0.27 with the wrong label. A 5-level Score is separately UNSAFE (score is a probability-weighted mean and routing rounds, so a split between adjacent temporal levels lands between them; Score also aliases). `state` admits no decorative and no verdict-bearing fields: irrelevant prose cost 0.61→0.50 p and 0.51→0.38 confidence, and a debug id whose VALUE named an outcome biased 0.61→0.74 — so keep distillation's prior verdict OUT. Jev buys NO determinism (TypeSafe's own cookbook flips 2 of 8 at 90.8% plurality, the same shape as CRMA-733's 2-of-7), so only code-side derivation removes that noise. entity_alignment publishes NO accuracy (loads `known_same_as`, never scores against it) — a SHAPE template only, never evidence; its numbers pin jev-1.12. hierarchical_classification is not the template for `hierarchical_distinct` (fixed taxonomy, n=4). RESIDUAL RISK for CRMA-1222: the near-synonym pair — promotion's real MISSED_DUPLICATE/OVER_DEDUP failure mode — never settled across 11 calls, and `is_narrower_instance` false-positived on it at 0.82.

- [Research: fan-out mechanics against promotion's latency ceiling and variable pool size](https://mcclatchy.atlassian.net/browse/CRMA-1218) — **Decided:** Both fit tests PASS on live measurement. Question cap is ~2,800 vs the 8 promotion needs (350x headroom) and there is NO silent truncation - 3,000 returns HTTP 400 max_tokens_exceeded. Latency is flat: 1 to 120 questions moves the median 0.529s to 0.536s, and promotion's 8-question shape measures 0.555s against a 240s ceiling.
  **Binds:** TWO TICKET PREMISES WERE WRONG: promotion is UPSTREAM of the dispatcher and fires it fire-and-forget (fire_enrichment_chain/entry.js:7-8), so its latency ceiling is SELF-IMPOSED not inherited; and the pool is hard-capped at 8 three times over (cosine 0.50 floor, ROW_NUMBER() <= 8, defensive .slice(0,8) at handle_request/entry.js:163), not variable-unbounded. Use the PER-CANDIDATE shape (one call, <=8 questions) - not for capacity but because accuracy falls as state grows with irrelevant content. Error handling MUST key on detail.error_type, NOT status: capacity AND semantic errors are both 400, not the SDK's implied 422, and detail is variously an object, a bare string, or a list. Pin httpStatuses to include 529 (docs say back off on it; the default 408/429/500-599 range excludes it) - UNVERIFIED, ~80 requests hit no 429/529. Cost is 0.1% of budget (~0.0015 USD per 15-candidate run vs 1.50 USD/chain). A doc-derived estimate was REFUTED by measurement (15-candidate batch predicted marginal against the 32k state cap, measured comfortable at 29.6k tokens/1.065s, breaks only at 50) - docs alone would have answered this map wrong. GAP: Snowflake pool-size distribution never obtained (expired SSO), so all pool figures are code-derived bounds, not observed percentiles.

- [TypeSafe account, API key, and published limits](https://mcclatchy.atlassian.net/browse/CRMA-1215) — **Decided:** Vendor is stood up and every published limit is now measured, not quoted. Secret Manager entry `typesafe-api-key` created in `mcc-crm-automations` (v1, 107 chars, verified); `crm-runtime@` already holds project-level secretAccessor so no per-secret grant is needed. Live model is `jev-1.13.0`. Pricing is $42/Btok input with output FREE — promotion's real 8-neighbour shape measures 904 input tokens = $0.000038/candidate, $0.00057 per 15-candidate run, 0.04% of the $1.50/chain budget.
  **Binds:** PIN THE EXPLICIT MODEL VERSION — `jev-latest` and `jev-preview` both alias to jev-1.13.0 today, so a vendor bump would move the rubric underneath a governed DIM_LLM_PROMPT row silently; cookbook numbers pin jev-1.12. CORRECTS CRMA-1218 ON 529: the default retryable set {408, 429, *range(500,600)} ALREADY INCLUDES 529 — do NOT pin httpStatuses; the real hazard is the Python docs' example override `http_statuses={429,500,502,503,504}` which silently drops it. Keep SDK defaults (maxRetries 2, backoff 500ms doubling to 5000ms, jitter 0.25, respectRetryAfter true). ALSO SHARPENS CRMA-1218 ON ERRORS: `detail` is polymorphic and `error_type` exists on only 2 of 4 measured shapes — 401 object w/ error_type, 400 object w/ error_type (capacity), 400 BARE STRING (semantic), 422 LIST of Pydantic records (schema). Type-check `detail` before reading `error_type`. 422 IS reachable: 422=schema violation, 400=semantic or capacity. NO RATE-LIMIT HEADERS EXIST — 250k tok/s and 1,200 rpm are invisible until the 429 fires; log `x-typesafe-request-id`, the only correlation handle. Timeout: SDK default 10.0s per call (RetryPolicy.timeout 30.0s is a separate total-budget across retries) vs promotion's measured 0.43-0.56s — keep the default. Budgets: 64k/request for state+all questions, 32k for state+longest question; Choice max 255 options, Score 2-10 levels. JAGGEDNESS BINDS THE RUBRIC: 'not a calculator' means `verify_exploding_topics`' absolute_volume-above-a-floor comparison MUST be precomputed in code; 'reads dates as text, not ordered quantities' means the temporal-recurrence distinction must not rest on the model ordering dates; 'structural invariants aren't guaranteed' generalises beyond P(yes)+P(no)!=1 — no cross-question arithmetic identity may be assumed when deriving labels in code; 'indirection' cautions against a negative `not_for` clause carrying a distinction alone; and the page itself concedes Noul and Choice scores are not comparable across primitives, corroborating CRMA-1217's route-on-Score-confidence rule. REQUEST-SHAPE GOTCHAS: a Noul's text field is `instructions` NOT `question`, and its criteria keys are `true`/`false` — NOT the `what`/`not_for` shape, which belongs to Choice OPTIONS; Score requires `criteria`, Noul's is optional.

- [Widen the promotion replay set across the full decision_category space](https://mcclatchy.atlassian.net/browse/CRMA-1216) — **Decided:** Built: 187 cases / 181 candidates covering 9 of 10 categories — OVER_DEDUP has NEVER fired in 5 months. Stratified on NEIGHBOUR SIMILARITY, not decision_category (CRMA-1217 derives category in code, so it is an artifact of the incumbent's schema; similarity is what predicts difficulty). Enriched not proportional: takes ALL 23 contested non-merges, ALL 27 cases above 0.80, ALL 7 turn-exhaustion DEFERs.
  **Binds:** The set lives at `docs/wayfinder/assets/crma-1216-replay-set.{tsv,sql,md}` — the README carries the band table to re-weight enriched results back to production rates, and the manifest carries `AUDIT_ID` per case. Four measurements from this ticket are recorded as **Established facts** above (the ~0.70 boundary and band table; OVER_DEDUP never fired and three categories starved; distillation's verdict near-constant; 1,017 ledger rows lead-side with `MODEL_USED` untrustworthy) — read them there, not here. What is **only** here: the harness at `scripts/replay/` lives on branch `wayfinder/gemini-3-7-flash-model-allocation`, **not** on `production` or this map's branch, and it cannot reach a DEFER row or replay an ET-rescue case — both tracked on [CRMA-1229](https://mcclatchy.atlassian.net/browse/CRMA-1229), which now blocks CRMA-1222. `e864045`'s self-neighbour cut is **confirmed at 687 cases** (450/450 self-created trends dropped, 237/237 merge targets kept, zero misclassification); `EXPLODING_TOPICS_API_KEY` remains an unverifiable environment precondition.

- [Decide: DEFER becomes bounded and visible](https://mcclatchy.atlassian.net/browse/CRMA-1219) — **Decided:** DEFER is REMOVED entirely from promotion's verdict set — the ticket asked how to bound it, production says it should not exist. The replacement rules are now a **Standing constraint**; the population and no-evidence measurements are **Established facts**. Read them there, not here.
  **Binds:** What is **only** here. Change sites for `/to-tickets`: `run_subagent/entry.js:189` (enum), `:210`/`:373-374`/`:393` (`defer_reason`), `:642`/`:699`/`:717` (the three fallbacks); `proc_promotion_apply.sql:76` (`ALLOWED_DECISIONS`), `:84` (`DECISION_ORDER`), `:163-164` (`overrode()` DEFER case), `:486`/`:520-531` (the mirrored-DEFER branch for followers — a leader can no longer defer, so it goes), `:560-573` (the DEFER branch), `:591` (`defer_count`); `eval_and_retrigger/entry.js:74`; `promotion-p_xMC99jg/workflow.yaml:41`/`:69` (the `DEFERRED_UNTIL` claim filter — safe to drop ONLY because the held population is zero, re-check immediately before shipping); `run_lead_agent/entry.js:494-496`; `seed_prompts_promotion.sql:83` (principle 6, as a migration PLUS the manifest bump at `audit-agent-p_xMC9nm3/workflow.yaml:530`/`:578`); `audit-agent-p_xMC9nm3/workflow.yaml:86-95` plus a new parked-candidate check. Supporting measurements: promotion runs ~6 h (55 runs/14 d, median gap 360 min), so a no-hold retry costs ~6 h not 48; the audit agent's `distillation_pending` check EXCLUDES held candidates by construction, so no alarm exists today. **VERIFICATION STATUS: decided, NOT proven** — no replay has shown what the agent decides on first look without DEFER, so CRMA-1229 → CRMA-1222 become a REGRESSION CHECK; if the 12 post-defer promotions collapse into rejections, revisit. `decision_category` moves from 10 values to 9. Rejected topics already resurface WITHOUT a hold — 8 of 15 deferred-then-rejected topics match a later-promoted trend at ≥0.80 cosine (arctic-embed-m on topic strings, NOT the pipeline's embedding space — directional only) via re-clustering in `distillation-revisit`, which yields a NEW fatter candidate with real new evidence. Premise-change notes are posted on CRMA-1223, CRMA-1229, CRMA-1231 and CRMA-1225.

## Not yet specified

<!-- The fog of war: in-scope decisions coming but not yet phraseable. -->

- **What the Cloud Run extraction must leave open so it does not foreclose this redesign.**
  The lift-and-shift ships first, so its seams decide how cheaply the typed path can be dropped in
  later — where the decision logic sits, what it is injected with, whether the tool loop is a
  replaceable module or welded to the handler. Sharpens once the verdict decomposition lands.
  Feeds CRMA-429's template and CRMA-537's sequence.
- **What telemetry the typed path must persist, and in what shape.** Promotion stores no turn
  telemetry today, and the redesign replaces turns with distributions and confidence — a different
  shape entirely. `FCT_TREND_LIFECYCLE_LEDGER` is the fleet's exemplar to copy from. Sharpens once
  the question set is known.

## Out of scope

<!-- Work ruled beyond the destination. Closed, never graduates. -->

- **A human review or curator surface.** Confidence-routing's third path would want one; this map
  cannot staff it. Ruled out at charter, 2026-09-20. That traffic was charted to DEFER; since
  CRMA-1219 removed DEFER it becomes a terminal `REJECT / INSUFFICIENT_EVIDENCE`, and the
  parked state is an operational alarm, not a curation queue.
- **Acting on the revisit disposition.** `INSUFFICIENT_EVIDENCE` marks a rejection as
  revisitable, but re-clustering it is the distillation lane's job
  (`distillation-revisit-p_o7CWWZl`), and this map is promotion-only. CRMA-1219 makes the
  revisit possible and measurable; wiring it is a separate effort. The evidence that would
  justify opening one is on that ticket — 8 of 15 deferred-then-rejected topics already
  resurface as a later-promoted trend at ≥0.80 cosine, with no hold.
- **A deterministic control arm** (SQL + thresholds on embedding distance, source-family count, ET
  volume). Cheap and tempting, but the rubric is deliberately moving away from deterministic gates.
  Ruled out at charter, 2026-09-20.
- **Generalising the pattern to the cluster-agent, lifecycle, or lifecycle-attribution agents.**
  Same shape, explicitly not this map's problem. See the reuse caution in Notes.
- **Executing promotion's move to Cloud Run.** That is CRMA-429 phase 2, sequenced by CRMA-537.
- **Shipping the rubric migration to `DIM_LLM_PROMPT`.** The map decides the rubric; `/to-tickets`
  ships the SQL and the manifest bump.
- **A vendor privacy or legal review.** Not required — public trend data only, no McClatchy data
  transmitted. Ruled out at charter, 2026-09-20.
