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
- **`max_iterations: 6` has zero margin, and exhaustion silently becomes DEFER.** The
  incumbent already burns all 6 turns; when the loop ends with no terminal call,
  `run_subagent/entry.js:713-717` defaults to DEFER behind a bare fallback. **5 of 38**
  production DEFER rows came from that path.
  _Source: [CRMA-733](https://mcclatchy.atlassian.net/browse/CRMA-733), 2026-08-20._
- **The promised defer cap does not exist.** `sql/seed_prompts_promotion.sql:83` tells the
  model defers are capped at 3 and "the system tracks this"; nothing does. There is no
  `DEFER_COUNT` in the repo. `cand-6nm5r52smodzwq5t` deferred **7 times**, 2026-04-26 →
  2026-05-08. _Source: [CRMA-726](https://mcclatchy.atlassian.net/browse/CRMA-726) defect 9._
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
- **TypeSafe has no footprint in this repo.** No API key, no Secret Manager entry, no
  `CLAUDE.md` mention, no account, no pricing or rate-limit terms on record.
  _Source: repo search 2026-09-20._
- **Jev's documented hard limits.** It does **not** generate text. It does **not** do
  arithmetic or date reasoning — both must be precomputed in code and passed in.
  `P(yes) + P(no)` is **not** guaranteed to sum to 1 across separate Noul calls. Text-only,
  English-primary. Injected/adversarial content in `state` is not filtered. Fan-out is many
  questions in **one** call, so sub-questions do not multiply round-trips.
  _Source: docs.typesafe.ai, 2026-09-20._
- **Confidence is not the winning probability.** It is a measure of how concentrated the whole
  distribution is (e.g. `(3 × top_prob − 1) / 2` for 3 options). Choice and Score answers
  carry confidence; a bare **Noul does not** — its 0–1 probability *is* the whole signal.
  _Source: docs.typesafe.ai `/confidence`, 2026-09-20._
- **The `entity_alignment` cookbook is the nearest published template.** One 3-level Score
  ("different" / "closely related, may be same" / "same") plus 3 supporting Nouls over 450
  pairs. Decision rule is **round the score** — no threshold fitting; the semantic meaning of
  each level sets the cutoffs. Outcome: 80% unlinked, 11% curator queue, 9% auto-merged. It
  is **pairwise**, so code still chooses which pairs to ask about.
  _Source: docs.typesafe.ai cookbook, 2026-09-20._

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
  route to DEFER, as today. DEFER instead becomes **bounded and visible** — a real counter and a
  forced terminal verdict when it trips. This closes CRMA-726 defect 9 as a side effect.
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
  rationalise a wrong verdict, which was the original argument against the prose.
  > **Superseded 2026-09-20.** An earlier call in this same session was *"compose the verdict in
  > code, then have a cheap Gemini call narrate it."* Reversed the same day: the narrator is
  > removed entirely. The **distributions** are the rubric-development instrument — a rubric level
  > that returns flat splits across many candidates is provably badly drawn, which no prose shows.
- **Four fit tests, and any one of them fails the map.** (1) Fan-out holds across a
  **variable-sized** neighbor pool. (2) Added latency fits promotion's ceiling inside the
  dispatcher's synchronous chain. (3) The 5-value `compare_topics` enum expresses as one Choice
  **without losing the temporal-recurrence distinction**. (4) Confidence actually **separates**
  cases on our data rather than clustering high everywhere. (4) is the real risk and the least
  knowable from vendor docs.
- **The adopt bar:** match the incumbent's 7/7 on `decision` and `target_trend_id`, **and**
  eliminate the turn-exhaustion DEFER. Cost is a tiebreak only — this lane is already cheap.
  The same bar applies to every arm tested.

## Decisions so far

<!-- The index — one line per closed ticket.

     - [<closed ticket title>](link) — **Decided:** <the answer, one line>
       **Binds:** <what downstream work this constrains — or `nothing further`>

     `resolve` appends here. Do not hand-edit while a session is running. -->

## Not yet specified

<!-- The fog of war: in-scope decisions coming but not yet phraseable. -->

- **What the Cloud Run extraction must leave open so it does not foreclose this redesign.**
  The lift-and-shift ships first, so its seams decide how cheaply the typed path can be dropped in
  later — where the decision logic sits, what it is injected with, whether the tool loop is a
  replaceable module or welded to the handler. Sharpens once the verdict decomposition lands.
  Feeds CRMA-429's template and CRMA-537's sequence.
- **The cost and latency model at fan-out scale.** Today one candidate costs $0.0538 worst-case
  across ≤6 serial turns. A fanned-out design asks many more questions, in fewer calls, of a
  different vendor at unknown per-question pricing. Sharpens after the call-mechanics research and
  the prototype produce real numbers.
- **What telemetry the typed path must persist, and in what shape.** Promotion stores no turn
  telemetry today, and the redesign replaces turns with distributions and confidence — a different
  shape entirely. `FCT_TREND_LIFECYCLE_LEDGER` is the fleet's exemplar to copy from. Sharpens once
  the question set is known.
- **Whether the widened replay set needs a ground truth separate from the incumbent's verdicts.**
  The bar is parity with the incumbent, but the incumbent is known wrong on the turn-exhaustion
  DEFERs — so on those cases "match the incumbent" is the wrong target and something else has to
  say what right looks like. Sharpens once the widened set is built and its known-bad cases counted.

## Out of scope

<!-- Work ruled beyond the destination. Closed, never graduates. -->

- **A human review or curator surface.** Confidence-routing's third path would want one; this map
  cannot staff it, so DEFER carries that traffic instead. Ruled out at charter, 2026-09-20.
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
