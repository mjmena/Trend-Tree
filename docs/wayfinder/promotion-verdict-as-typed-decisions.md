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
  **Request-shape gotchas:** a Noul's text field is `instructions`, **not** `question`, and its
  criteria keys are `true`/`false` — the `what`/`not_for` shape belongs to Choice **options**.
  Score requires `criteria`; Noul's is optional.
  _Source: docs.typesafe.ai + CRMA-1215 live calls, 2026-09-20._
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
  therefore at most 8 pairwise questions per candidate. **The observed distribution was never
  obtained** (expired SSO on CRMA-1218), so 0–8 is a code-derived bound, not a measured percentile —
  except that `MAX_NEIGHBOR_SIM` is null on 426 of 1,247 ledger rows, so roughly a third of
  candidates have no pool at all. _Source: CRMA-1217 / CRMA-1218 repo read; null count CRMA-1220,
  2026-09-20._
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
- **Promotion has never rejected a genuinely two-vendor candidate, and the family rule is why.**
  Of 1,247 token-bearing ledger rows, **345 rejections sit at one source family and 2 above it** —
  and those 2 are `agent_grok_discovery` + `grok_live`, one vendor the agent correctly caught.
  `sourceFamilyOf()` (`agents/lib/promotion_gate.mjs`) counts a **discovery agent** and an **agent
  search tool** from the same vendor as independent, and does the same for the `gemini_*` vertical
  shards: **43 live trends were promoted on same-vendor corroboration**, plus 18 merges. Filed
  separately as a production defect — it is live now, and this map ships after the extraction.
  _Source: CRMA-1220, 2026-09-20._
- **The hard pre-gate is already dormant.** Lead-side deterministic rejections by month: 191 Apr ·
  252 May · 356 Jun · 74 Jul · **0 Aug · 0 Sep**. ADR-0004 replaced its single-family arm with the
  oracle route, and the `cluster_size < 2` arm was dropped earlier because distillation enforces two
  signals by schema. The one surviving arm — one family **and** confidence or specificity below 0.5 —
  has not fired in ten weeks. _Source: CRMA-1220, 2026-09-20._
- **The corroboration oracle performs as ADR-0004 predicted; its input does not.** Since 2026-07-07
  across 898 candidates: 542 calls, 236 matches, **120 supplied the missing source family** (~48/month
  against the ~44 estimate). Its real ceiling is a **1,000-request monthly quota**, not the 60/min
  rate; current use is ~215/month. But `QUERY` is null on **698 of 898** (78%) while `TOPIC` is null
  on **zero**, and the match rate runs *against* ADR-0003's premise — 35.9% with a candidate query
  (n=131) vs 46.0% without (n=411), supplied-family rate 20.6% vs 22.6%. The keyword actually sent
  when `QUERY` was absent is unrecorded, so this is a flag, not a conclusion.
  _Source: CRMA-1220, 2026-09-20._
- **`RATIONALE` and `CONSIDERED_NEIGHBORS` are write-only — verified live, not just by repo read.**
  `GET_DDL` on the live `DT_TREND_DASHBOARD` does not reference `FCT_PROMOTION_LEDGER` at all (its
  one `RATIONALE` hit is `REASONED_FIT_RATIONALE`, a different table), and a scan of
  `MCC_PRESENTATION.INFORMATION_SCHEMA.VIEWS` for either column returns **zero rows**. The audit
  agent never references them; `docs/dashboard/data-contract.md` does not carry them. The only path
  out is `promotion-agent-p_yKCmm9r/respond/entry.js:31`, which echoes `rationale` into a response
  the lead folds straight back into the same row. Any format change is therefore free.
  `ACCOUNT_USAGE` is not authorized for this role, so an unknown external consumer querying the base
  table directly is formally unexcluded. The live table matches `sql/fct_promotion_audit.sql`
  exactly (20 columns, no drift), and the longest `RATIONALE` ever written is **1,231 chars** across
  2,265 rows — the 4,000-char truncation has never bitten.
  _Source: [CRMA-1224](https://mcclatchy.atlassian.net/browse/CRMA-1224), 2026-09-21._
- **The claim filter cannot see a parked candidate, so CRMA-1219's 3-attempt bound does not hold.**
  `promotion-p_xMC99jg/workflow.yaml:39-41` selects on `PROMOTED_AT IS NULL AND REJECTED_AT IS NULL
  AND (DEFERRED_UNTIL IS NULL OR DEFERRED_UNTIL <= CURRENT_TIMESTAMP())`. A park sets none of those,
  so the candidate returns to the pool on the next run (~6 h) and retries forever — the bound lives
  in the ledger, and the claim filter never reads the ledger. _Source: CRMA-1224, 2026-09-21._
- **CRMA-1222's live run reaches a well-powered adopt-bar measurement — 136 of 187 cases
  scored — and it fails the map's stated bar: 50.7% (69/136), against a bar of match-the-
  incumbent-7/7-equivalent.** `EXPLODING_TOPICS_API_KEY` (CRMA-1255) unblocked Request B; the
  oracle ran live against all 116 `needs_corroboration` cases. **85% of mismatches (57/67) trace
  to one mechanism: the ET oracle almost never fires.** 0 of 104 calls made with the `trend_topic`
  fallback matched ET at all (verified live and by hand — a genuine `HTTP 200 "No meta trends
  found"`, not a client bug); only `candidate_query` keywords (12 cases) ever matched, and only 4
  cleared the volume floor. `candidate_query` is null on 78% of candidates (CRMA-1220), so the
  oracle can mechanically rescue only the ~22% that carry one. **The 57 oracle mismatches split
  in two:** 38 are genuinely single-vendor-family (thin evidence — REJECT plausibly correct
  against an incumbent whose corroboration gate is known-dormant); **19 are two of
  `{chatgpt, gemini, grok}` — every one an AI-discovery-agent pair, never a directly-observed
  source** — Jev is reading two differently-branded LLM discovery agents as not independent of
  each other, which CRMA-1231's vendor-aware family fix would still count as 2 families and get
  wrong. **Whether that stricter read is correct or the rubric needs a carve-out is this map's
  live open question — not decided by this run.** The vendor-family fix (CRMA-1231 rule 4)
  independently validated 12/12, unaffected. Criteria vs bare Noul arms: negligible (zero flips
  ≥0.3 across 555 pairs). `pair_sameness` confidence runs **backwards** on this set (0.976 mean
  on contested cases vs 0.934 on easy ones) — a caution for CRMA-1223. The near-synonym residual
  risk is still unsettled — its two nearest replay-set instances both hit a separate empty-
  evidence gap (21/187 candidates), and CRMA-1217's own bare pair still lands unsettled (score
  1.24, confidence 0). Cost/latency at scale: $0.0547 for all 187 cases (Request A), oracle calls
  free. Full detail in `docs/wayfinder/assets/crma-1222-report.md`. _Source: CRMA-1222, 2026-09-22
  — not yet closed, pending the (a3) interpretive call._

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
- **The verdict is one Jev request per candidate, plus a conditional second.** Request A carries
  `state` = the candidate alone (trend topic, candidate query, every source name with its signal
  count, every signal) and at most 33 questions: `evidence_quality` (Score) once, plus per neighbour
  a `pair_sameness` Score and three Nouls — `is_same_recurring_topic`, `recurrence_deserves_own_row`,
  `is_narrower_instance`. **Each neighbour rides in its own question's structured `instructions`,
  never in shared `state`**, carrying its trend topic, summary and 3 sample signals — **no
  similarity, no heat, no age**. Request B fires **only** on `needs_corroboration`: one
  `oracle_match` Score per oracle result clearing the volume floor, carrying **only** the keyword.
  The 5-value `compare_topics` enum is **dropped** — code reconstructs the legacy labels from the
  Score plus the Nouls. `state` carries no `quality_flags`, `CONFIDENCE`, `SPECIFICITY_SCORE`,
  distillation verdict **or source-family count**; code still reads the verdict to derive
  `decision_category`, but the model never sees it.
- **Every Score level is named for its verdict, and named for the judgment — never for what promotion
  does next.** `evidence_quality`: `not_a_topic` / `needs_corroboration` / `stands_alone`.
  `pair_sameness`: `different_thing` / `unsettled` / `same_thing`. `oracle_match`:
  `different_concept` / `adjacent_not_same` / `same_concept`. **No ticket refers to a level by its
  index.** The rule is load-bearing because no single question determines the action — the recurrence
  Nouls override a merge — so a level named for an action would be a claim code can falsify. A Jev
  Score level has **no name field** (`criteria` is `Sequence[JSONContent]`; the response `legend` maps
  index → description), so the `verdict` name rides inside the free-form level object beside `what`
  and `not_for`.
- **`needs_corroboration` _is_ the "is corroboration necessary" judgment** — asked once, never twice,
  and judged from the source names **in words, with no family count in `state`**. This **removes
  `classifyCandidate()`'s reject arm and its source-family router**: code still groups source names
  into families to fill `state`, but the count decides nothing. **ADR-0004 stands unamended** — at
  `stands_alone` the oracle never runs, so it can never veto a candidate whose evidence already stands.
- **The composition rule is ordered, and reject precedes merge.** (1) `not_a_topic` →
  `REJECT`/`LOW_QUALITY`. (2) neighbours at `same_thing` → `MERGE_INTO_EXISTING`, target = highest
  `pair_sameness` **confidence** — **unless that neighbour's `is_same_recurring_topic` and
  `recurrence_deserves_own_row` are both high, which blocks the merge and sends the candidate to
  `PROMOTE_NEW`**; two or more clearing the bar means those two *trends* are duplicates — merge into
  the older and raise an operational flag, which this map does not try to fix. (3) `stands_alone` →
  `PROMOTE_NEW`. (4) `needs_corroboration` → code filters oracle results by the volume floor
  **before** asking; any `same_concept` → `PROMOTE_NEW`, else `REJECT`/`INSUFFICIENT_EVIDENCE`. Reject
  precedes merge because a merge attaches the candidate's signals to a live trend. **Routing always
  reads a Score's confidence, never a Choice's**, and `is_narrower_instance` blocks nothing on its
  own. The oracle keyword is the candidate query when present and the trend topic otherwise, **and
  which one was sent must be recorded**.
- **Scores round to the nearest level, and no threshold is fitted anywhere.** The level meaning sets
  the cut point. The only numbers this path needs — the Noul cut points and the confidence band —
  belong to [CRMA-1223](https://mcclatchy.atlassian.net/browse/CRMA-1223). The ET volume floor stays
  at **1000**, inherited from `agents/lib/exploding_topics.mjs:39` and unvalidated, and moves out of
  the model into code.
- **The rubric is six `DIM_LLM_PROMPT` rows, one per question**, keyed `promotion.jev.<question>` —
  the last segment **is** the Jev question key — with the definition JSON in `TEMPLATE`. The migration
  retires `promotion.subagent.decision_rubric`, `promotion.subagent.system` **and
  `promotion.lead.system`** (governed by the drift audit, read by no code), and bumps both manifest
  copies at `audit-agent-p_xMC9nm3/workflow.yaml:530` and `:578` in the same commit. All six rows ship
  in one statement — nothing enforces coherence between them.
- **The stored record is one ledger row per attempt, and it is fully typed.** Per-neighbour answers
  widen `CONSIDERED_NEIGHBORS` **in place** (no DDL): `pair_sameness` verdict + probabilities +
  confidence, the three Noul probabilities, the exact `instructions_sent`, and a derived legacy
  `judgment` so one query spans both eras. Everything else rides in a new `JUDGMENT_DETAIL` VARIANT —
  the `evidence_quality` answer, the `oracle_match` answers, and the per-request vendor ids. **Full
  width, always on, never sampled**: the neighbour pool changes as trends are promoted, so a sampled
  run cannot be reconstructed later. New columns: `RUN_OUTCOME` (`decided`/`failed`/`parked`),
  `DECISION_RULE`, `ORACLE_KEYWORD`, `ORACLE_KEYWORD_SOURCE` (`candidate_query`/`trend_topic`).
  `DECISION` becomes **nullable** — NULL is no verdict, never a sentinel, because a sentinel is how
  DEFER spread through six files. `ITERATION` re-points at the subagent's attempt, making CRMA-1219's
  retry bound a `COUNT(*)` with no counter to desync. `MODEL_USED` **loses its
  `DEFAULT 'claude-sonnet-4-6'`** and is NULL when no model ran, retiring CRMA-1216's zero-tokens
  hack. `OVERRODE_VERDICT` is **dropped** — derived, and it says nothing `DECISION_CATEGORY` does not.
- **`DECISION_RULE` records what the code did, and is the only non-derivable field on the row.**
  Five values, named for the judgment and never by index: `not_a_topic_reject`, `neighbour_merge`,
  `recurrence_blocked_merge`, `stands_alone_promote`, `oracle_decided`. The third is CRMA-1221's
  never-run path, visible the first time it fires. An audit that re-derives the composition rule in
  SQL reproduces any wrong rule in code; this field cannot.
- **`RATIONALE` is human-readable only, capped near 200 characters, and never parsed.** Its sole
  consumer is a person running an ad-hoc query; the queryable truth is the two VARIANTs. One template
  across all five rules — verdict, the fact that decided it, the number — reading in CRMA-1221's
  verdict names, never level indices.
- **A park is made to stick by `PARKED_AT` on `STG_TREND_CANDIDATES`, added to the claim filter.**
  `REJECTED_AT` is never reused for it — a park is not a verdict. `DEFERRED_UNTIL` retires. The audit
  agent gets a parked-candidate check, which is the operational alarm CRMA-1219 left empty.
- **CRMA-1222's replay scores against four different ground-truth rules, not one.** (1) The 7
  tombstone rows across 3 candidates (`AMBIGUOUS_TOPIC_JUDGMENT`) score against the candidate's own
  eventual `REJECT` — 3/3 converge, on a barely-larger neighbor pool, so this is a clean signal.
  (2) The 33 deliberate `NEEDS_MORE_SIGNAL` rows across 24 candidates are **not scored pass/fail at
  all** — CRMA-1219 measured that the hold gains no new evidence (cluster size and source count
  unchanged 27/27), so a later verdict may just be the same model answering twice (CRMA-1217: 90.8%
  plurality flip rate), not a better-informed one. Record agreement/disagreement as a labeled cohort
  and read mismatches by hand; the 15/24 that eventually rejected are the one unambiguous sub-signal
  inside this cohort (no new evidence → reject immediately is correct). (3) `evidence_quality`
  level 0 (reject on genuinely independent, multi-family evidence) has **zero production precedent**
  — every one of 422 historical subagent rejections was single-family — so the replay explicitly does
  **not** cover this path; a level-0 answer on a replay case is a hand-inspected finding, never a
  scored pass or miss. (4) Where `sourceFamilyOf()`'s live miscount defect (CRMA-1241, out of scope,
  unfixed in production) made the incumbent's own recorded answer wrong — one vendor double-counted
  as two families — score against a **re-derived, vendor-aware family count** for the affected replay
  cases, not against the ledger's recorded outcome; scoring against the buggy count would mark the
  typed path's correct answers as regressions.
  _Decided by [CRMA-1231](https://mcclatchy.atlassian.net/browse/CRMA-1231), 2026-09-21._

## Decisions so far

<!-- The index — one line per closed ticket.

     - [<closed ticket title>](link) — **Decided:** <the answer, one line>
       **Binds:** <what downstream work this constrains — or `nothing further`>

     `resolve` appends here. Do not hand-edit while a session is running. -->

- [Research: can Jev's primitives express promotion's judgments without losing distinctions](https://mcclatchy.atlassian.net/browse/CRMA-1217) — **Decided:** Yes, with the labels derived in code. Two Nouls beat the 5-value enum outright and are the recommended shape (`is_same_recurring_topic` ≥0.84 on all 8 recurrence pairs / ≤0.14 on all 6 others; `recurrence_deserves_own_row` splits temporal-same 0.14–0.24 from new-instance 0.80–0.88 with nothing between). ET corroboration is a 3-level Score, not a Noul. `decision_category` is derived in code, never asked. Verified on 35 live `jev-1.13.0` requests over 12 synthetic pairs.
  **Binds:** **Route on the Score's confidence, never the Choice's** — the single most important finding, and it contradicts the vendor docs: Choice confidence does NOT drop on hard cases (0.93 on the most ambiguous pair, 0.75–0.84 on a near-empty state) while Score confidence behaves as documented. Criteria wording is load-bearing: structured `what`+`not_for` got 6/6 at conf 0.75–1.00, one-sentence descriptions were unstable (2/3), and bare enum names — effectively what today's Gemini schema passes — COLLAPSE the temporal pair at conf 0.27 with the wrong label. A 5-level Score is separately UNSAFE (score is a probability-weighted mean and routing rounds, so a split between adjacent temporal levels lands between them; Score also aliases). `state` admits no decorative and no verdict-bearing fields: irrelevant prose cost 0.61→0.50 p and 0.51→0.38 confidence, and a debug id whose VALUE named an outcome biased 0.61→0.74 — so keep distillation's prior verdict OUT. Jev buys NO determinism (TypeSafe's own cookbook flips 2 of 8 at 90.8% plurality, the same shape as CRMA-733's 2-of-7), so only code-side derivation removes that noise. entity_alignment publishes NO accuracy (loads `known_same_as`, never scores against it) — a SHAPE template only, never evidence; its numbers pin jev-1.12. hierarchical_classification is not the template for `hierarchical_distinct` (fixed taxonomy, n=4). RESIDUAL RISK for CRMA-1222: the near-synonym pair — promotion's real MISSED_DUPLICATE/OVER_DEDUP failure mode — never settled across 11 calls, and `is_narrower_instance` false-positived on it at 0.82.

- [Research: fan-out mechanics against promotion's latency ceiling and variable pool size](https://mcclatchy.atlassian.net/browse/CRMA-1218)

- [TypeSafe account, API key, and published limits](https://mcclatchy.atlassian.net/browse/CRMA-1215)

- [Widen the promotion replay set across the full decision_category space](https://mcclatchy.atlassian.net/browse/CRMA-1216) — **Decided:** Built: 187 cases / 181 candidates covering 9 of 10 categories — OVER_DEDUP has NEVER fired in 5 months. Stratified on NEIGHBOUR SIMILARITY, not decision_category (CRMA-1217 derives category in code, so it is an artifact of the incumbent's schema; similarity is what predicts difficulty). Enriched not proportional: takes ALL 23 contested non-merges, ALL 27 cases above 0.80, ALL 7 turn-exhaustion DEFERs.
  **Binds:** The set lives at `docs/wayfinder/assets/crma-1216-replay-set.{tsv,sql,md}` — the README carries the band table to re-weight enriched results back to production rates, and the manifest carries `AUDIT_ID` per case. Four measurements from this ticket are recorded as **Established facts** above (the ~0.70 boundary and band table; OVER_DEDUP never fired and three categories starved; distillation's verdict near-constant; 1,017 ledger rows lead-side with `MODEL_USED` untrustworthy) — read them there, not here. What is **only** here: the harness at `scripts/replay/` lives on branch `wayfinder/gemini-3-7-flash-model-allocation`, **not** on `production` or this map's branch, and it cannot reach a DEFER row or replay an ET-rescue case — both tracked on [CRMA-1229](https://mcclatchy.atlassian.net/browse/CRMA-1229), which now blocks CRMA-1222. `e864045`'s self-neighbour cut is **confirmed at 687 cases** (450/450 self-created trends dropped, 237/237 merge targets kept, zero misclassification); `EXPLODING_TOPICS_API_KEY` remains an unverifiable environment precondition.

- [Decide: DEFER becomes bounded and visible](https://mcclatchy.atlassian.net/browse/CRMA-1219) — **Decided:** DEFER is REMOVED entirely from promotion's verdict set — the ticket asked how to bound it, production says it should not exist. The replacement rules are now a **Standing constraint**; the population and no-evidence measurements are **Established facts**. Read them there, not here.
  **Binds:** What is **only** here. Change sites for `/to-tickets`: `run_subagent/entry.js:189` (enum), `:210`/`:373-374`/`:393` (`defer_reason`), `:642`/`:699`/`:717` (the three fallbacks); `proc_promotion_apply.sql:76` (`ALLOWED_DECISIONS`), `:84` (`DECISION_ORDER`), `:163-164` (`overrode()` DEFER case), `:486`/`:520-531` (the mirrored-DEFER branch for followers — a leader can no longer defer, so it goes), `:560-573` (the DEFER branch), `:591` (`defer_count`); `eval_and_retrigger/entry.js:74`; `promotion-p_xMC99jg/workflow.yaml:41`/`:69` (the `DEFERRED_UNTIL` claim filter — safe to drop ONLY because the held population is zero, re-check immediately before shipping); `run_lead_agent/entry.js:494-496`; `seed_prompts_promotion.sql:83` (principle 6, as a migration PLUS the manifest bump at `audit-agent-p_xMC9nm3/workflow.yaml:530`/`:578`); `audit-agent-p_xMC9nm3/workflow.yaml:86-95` plus a new parked-candidate check. Supporting measurements: promotion runs ~6 h (55 runs/14 d, median gap 360 min), so a no-hold retry costs ~6 h not 48; the audit agent's `distillation_pending` check EXCLUDES held candidates by construction, so no alarm exists today. **VERIFICATION STATUS: decided, NOT proven** — no replay has shown what the agent decides on first look without DEFER, so CRMA-1229 → CRMA-1222 become a REGRESSION CHECK; if the 12 post-defer promotions collapse into rejections, revisit. `decision_category` moves from 10 values to 9. Rejected topics already resurface WITHOUT a hold — 8 of 15 deferred-then-rejected topics match a later-promoted trend at ≥0.80 cosine (arctic-embed-m on topic strings, NOT the pipeline's embedding space — directional only) via re-clustering in `distillation-revisit`, which yields a NEW fatter candidate with real new evidence. Premise-change notes are posted on CRMA-1223, CRMA-1229, CRMA-1231 and CRMA-1225.

- [Decide: the question set — which atomic questions the verdict decomposes into](https://mcclatchy.atlassian.net/browse/CRMA-1220) — **Decided:** One Jev request per candidate (evidence_quality Score + per-neighbour sameness Score and three Nouls, each neighbour in its own question's instructions), plus a conditional second request for oracle_match. `needs_corroboration` IS the 'is corroboration necessary' judgment, which removes classifyCandidate()'s reject arm and its source-family router. The 5-value enum is dropped and the labels derived in code. **Amended by CRMA-1221** on two points — the recurrence Nouls now override a merge, and `pair_action` is renamed `pair_sameness`; the Standing constraints carry the current rule.

- [Decide: the rubric, expressed as typed question definitions](https://mcclatchy.atlassian.net/browse/CRMA-1221) — **Decided:** All six question definitions written literally to docs/wayfinder/assets/crma-1221-jev-questions.json. One DIM_LLM_PROMPT row per question (JSON in TEMPLATE), rounding with no fitted threshold, and named verdicts replacing level indices. AMENDS CRMA-1220: the recurrence Nouls override a merge, and pair_action becomes pair_sameness.

- [Decide: what the typed path persists, and what RATIONALE carries](https://mcclatchy.atlassian.net/browse/CRMA-1224) — **Decided:** Per-neighbour answers widen CONSIDERED_NEIGHBORS in place; everything else goes in a new JUDGMENT_DETAIL VARIANT, full width and always on. DECISION becomes nullable (NULL = no verdict, never a sentinel), ITERATION re-points at the subagent's attempt, OVERRODE_VERDICT is dropped, MODEL_USED loses its stale default. RATIONALE is human-only, ~200 chars, never parsed. NEW FINDING: the claim filter cannot see a parked candidate, so CRMA-1219's 3-attempt bound does not hold — fixed by PARKED_AT on STG_TREND_CANDIDATES.

- [Make the replay lane reach DEFER rows and ET-rescue cases](https://mcclatchy.atlassian.net/browse/CRMA-1229) — **Decided:** Both mechanical fixes were already committed on wayfinder/gemini-3-7-flash-model-allocation (3d6c958): cases() keys --case on AUDIT_ID to reach a DEFER row instead of the QUALIFY-cut latest decision, and build() recomputes et_rescue via classifyCandidate with a hand-verified verbatim mirror of handle_request's prompt block instead of forcing it false.

- [Decide: what ground truth the known-bad replay cases are scored against](https://mcclatchy.atlassian.net/browse/CRMA-1231) — **Decided:** Four separate ground-truth rules, not one: (1) the 7 tombstone rows score against eventual REJECT, (2) the 33 deliberate NEEDS_MORE_SIGNAL rows are not scored pass/fail (labeled cohort only), (3) evidence_quality level 0 is explicitly uncovered by history and hand-inspected on fire, (4) same-vendor-miscounted cases score against a re-derived vendor-aware family count, not the buggy ledger value.

- [Get EXPLODING_TOPICS_API_KEY reachable from a harness environment](https://mcclatchy.atlassian.net/browse/CRMA-1255) — **Decided:** Martin retrieved the key from the Pipedream dashboard and added it to Keychain as `exploding-topics-trend-tree-scoping`, mirroring the `typesafe-trend-tree-scoping` precedent.
  **Binds:** Unblocked CRMA-1222's Request B (the ET oracle) — verified working, 116/116 live calls with zero auth failures.

## Not yet specified

<!-- The fog of war: in-scope decisions coming but not yet phraseable. -->

Empty. CRMA-1220 graduated the Cloud Run seam patch into a ticket, and the telemetry patch
was already covered by [CRMA-1224](https://mcclatchy.atlassian.net/browse/CRMA-1224) once the
question set was known.

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
- **Improving the candidate query distillation authors.** CRMA-1220 measured it missing on 78% of
  candidates and matching *worse* than its absence, against ADR-0003's premise. Authoring it is the
  distillation lane's job; promotion only consumes it. The typed path handles the gap with a
  documented fallback to the trend topic and by recording which keyword it sent, which is what makes
  a later investigation answerable.
- **Fixing `sourceFamilyOf()`'s vendor blindness.** Filed as its own CRMA issue — it is a live
  production defect affecting 43 promoted trends, and this map ships months later, after the Cloud
  Run extraction. The evidence is in **Established facts** above.
