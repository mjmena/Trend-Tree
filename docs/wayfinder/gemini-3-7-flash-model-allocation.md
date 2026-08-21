<!-- map: CRMA-726 -->

# Gemini 3.7 Flash — migrating the agent fleet

> **Destination redrawn 2026-08-20.** This map began as a per-lane allocation question —
> *for each pin, does a drop-in swap to 3.7 Flash beat the incumbent?* Two lanes answered
> "no", and in both cases the loss traced to the call shape and to Pro-era prompts rather
> than to the model being worse at the task. The effort is now a **migration**: the target
> is 3.7 Flash, and the question is what it takes to get there. See **What the redraw
> changed** below before reading anything written earlier.

## Destination

A **migration spec** for moving the agent fleet to `gemini-3.7-flash` — naming, per lane,
the prompt changes, call-shape changes, and telemetry needed to make the lane viable on
3.7, or the evidence that the lane cannot get there. Supersedes
[CRMA-471](https://mcclatchy.atlassian.net/browse/CRMA-471). Handed to `/to-tickets`.
The map does not carry execution.

## Notes

- **Domain**: read `CONTEXT.md` before writing about signals, trends, or the descriptor.
  Tracker contract is `docs/agents/issue-tracker.md`.
- **Skills**: `pipedream-synced-project` for anything touching a workflow or a deploy;
  `/domain-modeling` when the model-pin vs registry-driven distinction gets its glossary entry.
- **One instrument, built inside the map.** The replay harness is a `task` ticket, not a
  deliverable. This is a deliberate, scoped exception to plan-don't-do. Nothing else in this
  map executes — including the prompt and call-shape changes the destination now covers.
  The map decides what they must be; `/to-tickets` ships them.
- **Never commit this map to `production`.** A commit to the default branch is a Pipedream
  deploy of every changed workflow.

## What the redraw changed

<!-- Read this before trusting anything written under the old destination. -->

**In scope now, out of scope before:** prompt rewrites, call-shape changes (thinking level,
structured output, `maxOutputTokens`, response parsing), and the choice of API surface.
The old constraint "exactly one variable changes per lane" bounded the *comparison*; it no
longer bounds the *work*.

**The default flipped.** `stay` was the default and a lane moved only if replay showed it
better. Now 3.7 Flash is the target and a lane stays only if it cannot be made to work.

**Re-opened:** [CRMA-730](https://mcclatchy.atlassian.net/browse/CRMA-730) closed as "all
five `gemini-3-flash-preview` pins STAY" on drop-in evidence. Its **measurements stand** and
are recorded on the ticket; its allocation verdict does not.
[CRMA-731](https://mcclatchy.atlassian.net/browse/CRMA-731) was re-scoped mid-flight for the
same reason, with its full drop-in comparison recorded on the ticket.

**Unchanged and still binding:** everything under Established facts, the eight held defects,
the harness, and [CRMA-727](https://mcclatchy.atlassian.net/browse/CRMA-727)'s 14 hazards.

## Established facts

<!-- Measured state of the world. Falsified by RE-MEASUREMENT, never by a decision. -->

- **17 live model pins across the workflows** — 8 on `gemini-3.1-pro-preview` (audit,
  daily-digest, cluster-agent, distillation subagent, enrichment, lifecycle subagent,
  lifecycle-attribution subagent, promotion); 5 on
  `gemini-3-flash-preview` (4 verticals + prompt-tester default); 3 Anthropic
  (`run_name_reviewer` and `run_revisit_subagent` on `claude-sonnet-4-6`,
  `generate_search_terms` on `claude-haiku-4-5-20251001`); 1 on `grok-4-latest`.
  `agents/lib/*.mjs` holds two more as reference copies, not deployed.
  **The "distillation lead" pin is NOT live** — `distillation-p_mkCBBqb/run_lead_agent/entry.js`
  pins `gemini-3.1-pro-preview` at line 577, but `distillation-p_mkCBBqb/workflow.yaml`
  has no `run_lead_agent` namespace. The lead clusters in SQL and dispatches to the shared
  cluster agent; the file is dead code. This shrinks CRMA-732's scope.
  _Source: repo inventory 2026-08-20, corrected by [CRMA-729](https://mcclatchy.atlassian.net/browse/CRMA-729) re-measurement 2026-08-20._
- **`gemini-3.7-flash` silently drops the head of its answer on grounded calls.** With
  `tools: [{google_search:{}}]` and `temperature` only — production's exact shape — the model
  emits its fence and then begins mid-object, the array opener absent. Measured on the **raw
  API**, ~**1 call in 5**. Token accounting is exact (4,647 + 1,423 + 3,191 = 9,261), so
  nothing is lost in transit; `parts.length` is 1, so it is **not** a client-extraction bug;
  `groundingMetadata` is present with segment offsets indexing into the already-truncated
  text; `finishReason` is `STOP`. Matched A/B over 24 calls: `includeThoughts` off 9/12
  clean, on 10/12 — **not a fix**, and its failures rule out a thought/answer boundary
  explanation. Per-model: `gemini-2.5-flash` 0, `gemini-3-flash-preview` 0/6,
  `gemini-3.6-flash` 4/5 (forum), `gemini-3.7-flash` ~1 in 5.
  _Source: [CRMA-731](https://mcclatchy.atlassian.net/browse/CRMA-731) raw-API capture, 2026-08-20._
- **`candidatesTokenCount` EXCLUDES thinking tokens**, on both `gemini-3.1-pro-preview` and
  `gemini-3.7-flash`. Measured by arithmetic against the API's own `totalTokenCount`:
  `prompt 13 + candidates 8 + thoughts 140 = total 161` (Pro) and
  `13 + 10 + 147 = 170` (3.7 Flash). This **confirms CRMA-727 defect 2** and makes the
  comment at `agents/lib/gemini_loop.mjs:150` — "candidatesTokenCount already includes
  thinking tokens — do NOT add thoughtsTokenCount" — factually wrong at all five call sites
  that copy it. The understatement is large, not marginal: a real enrichment replay booked
  2,713 thinking tokens against 2,425 output tokens.
  _Source: [CRMA-729](https://mcclatchy.atlassian.net/browse/CRMA-729) live measurement, 2026-08-20._
- **`FCT_TREND_ENRICHMENT_LEDGER.MODEL_USED` is mislabelled.** Every row for the last 21 days
  reads `claude-sonnet-4-6` while `PAYLOAD:agent_telemetry.model` reads
  `gemini-3.1-pro-preview`. The telemetry is the truthful one — enrichment **does** run
  Gemini, so `CLAUDE.md`'s "lone Anthropic holdout" line is stale. Not cosmetic:
  `audit-agent-p_xMC9nm3/workflow.yaml:323,347` groups per-model cost by that column, so the
  audit agent attributes enrichment spend to the wrong vendor.
  _Source: [CRMA-729](https://mcclatchy.atlassian.net/browse/CRMA-729) re-measurement, 2026-08-20._
- **Only the four `discovery-p_5VCPP3N` lanes are registry-driven.** Everywhere else
  `DIM_LLM_PROMPT.MODEL` is telemetry and the code const wins at runtime.
  _Source: repo inventory + `CLAUDE.md:129`, verified 2026-08-20._
- **13 hardcoded per-million rate tables, no shared constant.** Twelve price
  `gemini-3.1-pro-preview` at $2.00/$12.00; `daily-digest-p_vQCkwgV/generate_intro/entry.mjs:26-27`
  prices the same pinned model at $1.25/$10.00, under-reporting that lane ~40%.
  _Source: repo inventory, verified 2026-08-20._
- **Several lanes compute no cost at all** — the five `ingestion/LLM/*` workflows,
  `grok-live-search`, `generate_search_terms`, and all four `discovery-p_5VCPP3N` steps
  emit raw token counts only. This is [CRMA-725](https://mcclatchy.atlassian.net/browse/CRMA-725)
  seen from the code side. _Source: repo inventory, verified 2026-08-20._
- **`gemini-3.7-flash` is GA**, released 2026-08-13. 1,048,576 input tokens, 65,536 output,
  knowledge cutoff March 2026. Structured output, function calling, and Search grounding
  all supported. _Source: ai.google.dev/gemini-api/docs/models, DeepMind model card, 2026-08-20._
- **Pricing**: $0.75 in / $3.75 out per 1M through 2026-12-31, then $1.50 / $7.50 from
  2027-01-01. Batch API is a flat 50% discount. Context caching $0.075/1M plus
  $0.50/1M/hour storage. Search grounding $14 per 1,000 requests after 5,000 free per
  month, shared across all Gemini 3.x models. _Source: ai.google.dev/gemini-api/docs/pricing, 2026-08-20._
- **`gemini-3.1-pro-preview` is still the newest Pro model**, released 2026-02-19 and still
  preview six months on. Gemini 3.5 Pro was announced but has not shipped. At $2.00/$12.00
  (≤200k prompt), 3.7 Flash is ~2.7× cheaper in and ~3.2× cheaper out, with no long-prompt
  price tier. _Source: ai.google.dev/gemini-api/docs/models + deprecations, 2026-08-20._
- **Thinking cannot be turned off on `gemini-3.7-flash`.** The parameter is `thinking_level`;
  legal values are `low` / `medium` / `high`, default `medium`. Unlike 3.6 Flash it does not
  expose `minimal`. Every call bills thinking tokens at the output rate.
  _Source: ai.google.dev/gemini-api/docs/thinking, 2026-08-20._
- **No shutdown date is published** for `gemini-3-flash-preview`, `gemini-2.5-flash`,
  `gemini-3.1-pro-preview`, or `gemini-3.7-flash`. `gemini-3-flash-preview` is not on the
  deprecations page at all. Preview ids here do get retired eventually (`gemini-3-pro-preview`
  went release to shutdown in ~3.5 months) but no clock is running today.
  _Source: ai.google.dev/gemini-api/docs/deprecations, re-confirmed by [CRMA-756](https://mcclatchy.atlassian.net/browse/CRMA-756), 2026-08-20._
- **`generateContent` is officially "now considered legacy" but "fully supported", with no
  sunset date published anywhere.** Moving to the Interactions API is therefore a choice, not
  a deadline. _Source: [CRMA-756](https://mcclatchy.atlassian.net/browse/CRMA-756), 2026-08-20._
- **The Interactions API returns real publisher URLs** in `url_citation.url`; the legacy
  surface returns `vertexaisearch.cloud.google.com` redirects and has **no documented way**
  to get publisher URLs. Interactions carries its own trap: `output_text` excludes text
  blocks separated by non-text content, so grounded runs must walk `steps` manually.
  _Source: [CRMA-756](https://mcclatchy.atlassian.net/browse/CRMA-756), 2026-08-20._
- **Structured output combined with Search grounding is Preview**, and explicitly names
  `gemini-3.7-flash`. The structured-output support table omitting 3.7 is a stale table,
  contradicted by the model's own capability page. `functionCallingConfig` accepts
  `AUTO`/`ANY`/`NONE`/`VALIDATED`; `VALIDATED` is the **implicit default** the API switches to
  when functionDeclarations are combined with built-in tools or structured outputs.
  _Source: [CRMA-756](https://mcclatchy.atlassian.net/browse/CRMA-756), 2026-08-20._
- **`temperature` is deprecated** as of 2026-07-21; the migration checklist says to strip
  `temperature`, `top_p`, and `top_k`. Every lane here still sends it.
  _Source: [CRMA-727](https://mcclatchy.atlassian.net/browse/CRMA-727) research, 2026-08-20._
- **No official source states whether undeclared schema fields are dropped, for either
  model.** [CRMA-722](https://mcclatchy.atlassian.net/browse/CRMA-722) remains the only hard
  evidence and it is empirical. A bare `{type:"object"}` passes contents through unvalidated,
  which is why the audit agent's shallow schema survived and enrichment's deeply-typed
  `propose_enrichment` is the more exposed one.
  _Source: [CRMA-727](https://mcclatchy.atlassian.net/browse/CRMA-727) research, 2026-08-20._
- **No lane in this repo declares a `responseSchema`.** The only structured-output
  declaration anywhere is `responseMimeType: "application/json"` at
  `daily-digest-p_vQCkwgV/generate_intro/entry.mjs:155`. Every deep schema is a
  `functionDeclarations` **parameter schema on a terminal emit tool**, so that is the surface
  hazard H8 actually applies to. `propose_enrichment` declares **39 leaf paths** and remains
  the most exposed lane; `propose_audit_report` is the shallow contrast.
  _Source: [CRMA-729](https://mcclatchy.atlassian.net/browse/CRMA-729) call-site survey, 2026-08-20._
- **The nine Pro loops already run `thinking_level: "medium"`. The four verticals run
  single-shot at `temperature 0.3` with no thinking parameter at all.**
  _Source: repo inventory, verified 2026-08-20._
- **The four verticals run at ~a third of nominal yield, and the model pin is not why.**
  ~60% of proposed trends die on `resolveAndVerify` — candidate 60%, incumbent 63%, fired
  the same day against the same prompts. Production corroborates from its own IP: the
  prompt asks for 10–15 trends and `gemini_wellness` stored 2–5 per run on each of the last
  14 days. Held as **defect 5** below.
  _Source: [CRMA-730](https://mcclatchy.atlassian.net/browse/CRMA-730) paired replay +
  `STG_EXTERNAL_SIGNALS` yield query, 2026-08-20._
- **On the verticals, 3.7 Flash was worse on usable citations** — live AND deep-link 16% vs
  26% — because it cites bare homepages that pass URL verification and get stored with no
  evidence behind them. The feared thinking-floor cost never materialised: 0–721 thinking
  tokens, sub-cent either way. Measured as a **drop-in**, Pro-era prompt held constant.
  _Source: [CRMA-730](https://mcclatchy.atlassian.net/browse/CRMA-730), 2026-08-20._
- **On the ungrounded distillation lead, 3.7 Flash emits cleanly and dedups where 3.1 Pro
  does not.** Five historical clusters, both models fired today on identical inputs: 5/5
  `finishReason: STOP`, no fields lost, no missing required fields, 8–9 of 9 declared leaf
  paths populated, and undeclared keys inside the bare-`{type:"object"}` `source_breakdown`
  survived every run. Topic quality is a wash — both models independently coined
  "coolcationing" and both landed on "cottage cheese flatbread". The separation is tool use:
  3.1 Pro ran the identical minimal sequence 5/5 (`query_signals_window →
  query_trend_neighbors → propose_trend_candidate`, 4 turns) and never called
  `validate_dedupe_pair`, `query_trend_metrics`, or `validate_url_canonical`; 3.7 Flash
  called `validate_dedupe_pair` in 3/5 and returned `DUPLICATE_OF ea7cffc2` on a trend the
  incumbent's own proposal had created. **No head truncation appeared — this lane sends no
  `google_search`.** _Source: [CRMA-732](https://mcclatchy.atlassian.net/browse/CRMA-732)
  replay with `--rerun-incumbent`, 2026-08-20._
- **The extra turns are what invert the cost.** 3.7 Flash ran 4–7 turns against the
  incumbent's flat 4, re-sending a growing context: $0.1196 vs $0.1987 across five cases —
  40% cheaper today, but **+20% against 3.1 Pro at the 2027-01-01 rates**. The extra turns
  are the dedup calls, so the premium buys a guardrail that does not currently run.
  `candidates_excludes_thinking` reconciled on all ten runs; deployed cost math understates
  this lane 20–27%. _Source: [CRMA-732](https://mcclatchy.atlassian.net/browse/CRMA-732), 2026-08-20._
- **`STG_TREND_CANDIDATES` self-reported `specificity_score` is not a decision axis.** Across
  357 rows in 30 days it never leaves 0.7–1.0, mean 0.90, and 357 of 359 carry
  `VERDICT = REAL_TREND`. The model grades its own homework, so the judgeable rubric is the
  prose bar and worked examples in `distillation.lead.system` v7, not the number.
  _Source: [CRMA-732](https://mcclatchy.atlassian.net/browse/CRMA-732), 2026-08-20._
- **The distillation lane's real work is small clusters.** Only four candidates in the last
  21 days carried more than 5 supporting signals, and the largest carried 7; 3-signal
  clusters dominate. Volume is 3–6 sessions and 7–21 candidates a day, 3–10 promoted.
  _Source: [CRMA-732](https://mcclatchy.atlassian.net/browse/CRMA-732), 2026-08-20._
- **The grounded-lane noise floor is large.** On `discovery.gemini.search` the incumbent's own
  usable-citation rate moved 45% → 32% (15 → 11 of ~33) between two runs an hour apart. A lane
  decision on a grounded lane needs a gap bigger than that.
  _Source: [CRMA-731](https://mcclatchy.atlassian.net/browse/CRMA-731), 2026-08-20._
- **`STG_LLM_PROMPT_LOGS` has no writer anywhere in the repo** — DDL only. Per-lane before/after
  by prompt version cannot be run. The observable substitute is
  `STG_EXTERNAL_SIGNALS.METADATA:source_model_full`, which carries the exact model id (verified
  21 days), alongside `rerank_score` (stable 0.653–0.698) and yield (9–28 signals/day).
  _Source: [CRMA-731](https://mcclatchy.atlassian.net/browse/CRMA-731), 2026-08-20._
- **The discovery lane discards unresolvable grounding-redirect citations.** 17 of ~67
  incumbent proposals across two runs cited a `vertexaisearch.cloud.google.com` URL that did
  not resolve, dropped at `canonicalize_and_validate/entry.js:199`. Same family as defect 5.
  By contrast `gemini-3-flash-preview` lost 38% to dead 404s and 3.7 Flash produced four
  fabricated deep links in one shard — a dropped redirect is recoverable downstream, a
  fabricated URL is not.
  _Source: [CRMA-731](https://mcclatchy.atlassian.net/browse/CRMA-731), 2026-08-20._
- **On the promotion gate, 3.7 Flash and 3.1 Pro decide identically, and the incumbent is
  the one that fails.** Seven historical candidates stratified across every decision class,
  both models fired today: **7/7 identical `decision` and identical `target_trend_id`** on
  every merge. `decision_category` differs on 2 of 7 and is noise — on one case the
  incumbent's own re-run drifted from its own ledger record while 3.7 Flash matched it.
  Schema clean 7/7 (10 declared leaf paths, no fields lost, none missing required, nothing
  undeclared emitted). Turns 3–6 against the incumbent's 3–6, so **this lane does not show
  the turn inflation that inverted distillation's cost**: −58.6% today and **−17.2% at the
  2027-01-01 rates**, worst case $0.0690 against a $0.15 budget.
  _Source: [CRMA-733](https://mcclatchy.atlassian.net/browse/CRMA-733) replay with
  `--rerun-incumbent`, 2026-08-20._
- **The silent-DEFER failure mode is already live on `gemini-3.1-pro-preview`.** On the
  hardest replayed candidate the incumbent burned all 6 turns on ET lookups and never
  called `propose_decision` (`emission: null`, `finish: max_iterations`); 3.7 Flash on the
  identical input emitted a clean REJECT. Production carries **5 of 38 DEFER rows** from
  that fallback path, all `gemini-3.1-pro-preview`. **Production stores no subagent turn
  count** — `FCT_PROMOTION_LEDGER.ITERATION` is the lead's retry counter (values 1 and 2
  only) — so the lane's one real failure mode is invisible today.
  _Source: [CRMA-733](https://mcclatchy.atlassian.net/browse/CRMA-733), 2026-08-20._
- **The promotion replay was measuring an artifact until 2026-08-20.** Two harness defects,
  both fixed in `e864045`. (1) A candidate the incumbent PROMOTED is now itself a row in
  `FCT_TRENDS` and returned as its own nearest neighbour, so the replay asked "is this
  candidate a duplicate of itself?" — it fired on **4 of 7 cases**, including MERGE and
  REJECT cases. The cut is the promotion **run**: `PROC_PROMOTION_APPLY` writes `DECIDED_AT`
  *after* inserting the trend, so a `PROMOTED_AT >= DECIDED_AT` filter excludes nothing.
  (2) `EXPLODING_TOPICS_API_KEY` was unset, so `verify_exploding_topics` returned "treat the
  candidate as un-corroborated" and both models rejected every single-family candidate —
  and **28 of 60 promotions in 21 days run through that ET-rescue path**.
  _Source: [CRMA-733](https://mcclatchy.atlassian.net/browse/CRMA-733), 2026-08-20._

## Standing constraints

<!-- Settled decisions in binding present tense. Overturned only by another decision. -->

- **The target is `gemini-3.7-flash`, and the question per lane is what it takes to get
  there.** A lane stays only when the work required is shown to be infeasible or not worth
  it — not merely because a drop-in swap lost.
- **A lane may change its prompt, its call shape, and its parsing.** What it may not change
  is the job the lane does. A rewritten prompt that quietly redefines the lane's output
  contract is a different lane, not a migrated one.
- **Cost is a non-regression constraint, not a gate.** A large cost rise needs a deliberate
  "yes, worth it". No numeric threshold — the rate tables disagree with each other and fixing
  them is not this map's job. **3.7 Flash pricing is introductory through 2026-12-31 and
  doubles on 2027-01-01**; size any cost argument against the January number.
- **Scope is the 9 Pro pins, the 5 `gemini-3-flash-preview` pins, and the 3 Anthropic pins.**
  Grok is out: `grok-live-search` is X-only live search, so the model *is* the data source.
- **Evidence is offline replay.** Historical inputs pulled from the ledgers, fired at the
  candidate model, compared side by side against what the incumbent actually produced,
  judged per lane, with human review of the diff. Not shadow-running, not sequential A/B.
- **The instrument exists, and every lane ticket uses it.** `scripts/replay/` on this
  branch — `node scripts/replay/replay.mjs <lane> --model gemini-3.7-flash`. Ten lanes, one
  per lane ticket. A lane decision cites a run artifact under `scripts/replay/out/`, not an
  impression. Read `scripts/replay/README.md` **before** reading a diff: each lane carries
  named limits, and a decision made without them is a decision made on an artifact of the
  harness. Grounded lanes compare **re-run vs re-run** — the harness does this automatically
  for any lane declaring `requiresRerun`.
- **The grounded head-truncation blocks every grounded lane.** Until there is a call shape
  that returns a complete answer, no grounded lane can move. That is
  [CRMA-757](https://mcclatchy.atlassian.net/browse/CRMA-757), and both grounded lane tickets
  are blocked on it.
- **The switch targets Pipedream now.** It does not wait for
  [CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429); model ids are configuration
  and travel with the code to Cloud Run.
- **CRMA-471 closes as superseded only when the replacement spec lands** — not before. Its
  slice structure, gate design, and registry-migration pattern are worth lifting.
- **Rate-table hygiene rides in the spec, not on the map.** It is not a decision, but the
  spec must say what happens to the 13 tables or an implementer ships a wrong cost number.
- **The live defects found while mapping are held for the eventual epic, not filed
  separately.** They bite whether or not any lane moves, but filing them as lone tickets
  scatters work that belongs in one place. The spec **must** carry them as remediation items,
  and `/to-tickets` turns them into stories under the epic:
  1. **`functionResponse` carries no `id`** at `agents/lib/gemini_loop.mjs:192`,
     `audit:356`, `enrichment:717`, `promotion:574`, `lifecycle-subagent:437`. Google's docs
     are now normative that results map back by `id`. Failure mode is swapped tool results
     when one turn calls the same tool twice — silent, not a 400.
  2. **Cost math reads `candidatesTokenCount` only** at the same five sites, but response
     pricing is output tokens *plus* thinking tokens. A third independent reason the cost
     telemetry undercounts, alongside CRMA-725 and the daily-digest rate table.
  3. **Four new `finishReason` values are treated as clean stops** —
     `MISSING_THOUGHT_SIGNATURE`, `TOO_MANY_TOOL_CALLS`, `MALFORMED_RESPONSE`, `ESCALATION`.
     The loops assign `stop_reason = finishReason` and break, so these land as silent
     no-emission.
  4. **`FCT_TREND_ENRICHMENT_LEDGER.MODEL_USED` records the wrong model** (see Established
     facts). Added by [CRMA-729](https://mcclatchy.atlassian.net/browse/CRMA-729). It matters
     because the audit agent groups per-model cost by that column, so the fleet's own cost
     report is wrong about which vendor enrichment spend belongs to.
  5. **~60% of what the four verticals propose dies on `resolveAndVerify`** and is dropped
     before it reaches `STG_EXTERNAL_SIGNALS` (see Established facts). Added by
     [CRMA-730](https://mcclatchy.atlassian.net/browse/CRMA-730). Model-independent, so no
     pin choice fixes it. The verticals emit about a third of what they should whatever model
     runs them. The spec must carry the URL-death fix or the lane stays starved.
  6. **The discovery Gemini lane silently loses shards.** `discover_gemini/entry.js:114`
     reads only `parts[0].text`, and `gemini-2.5-flash` returned two parts in 2 of 6 sweep
     calls — production drops the second part's proposals. The step sends no
     `maxOutputTokens` and 2.5 Flash hit `MAX_TOKENS` in 1 of 6, losing the shard.
     `entry.js:144-147` swallows a failed shard and the lane only errors when all six fail;
     `shards_succeeded` reaches the HTTP response but is never persisted. Net: this lane can
     lose a third of its yield with nothing in the warehouse showing it. Added by
     [CRMA-731](https://mcclatchy.atlassian.net/browse/CRMA-731). **This one is also a
     prerequisite** — until it is fixed, no model change on this lane can be evaluated.
  7. **The distillation candidate `query` is null and the tool schema has no slot for it.**
     `propose_trend_candidate` (`distillation-cluster-agent-p_YyC89Ke/run_lead_agent/entry.js`)
     declares nine properties and `query` is not among them, yet `commit_candidates`
     (`distillation-p_mkCBBqb/workflow.yaml:145`) selects `cand.j:query::STRING` and the v7
     prompt tells the agent to author one per candidate. The model was emitting it as an
     **undeclared** argument, and that has decayed to nothing: main path 30 of 130 rows over
     14 days, falling to **0 since 2026-08-18**; revisit path 0 of 49, ever. `BUCKET` is null
     on all 179 rows for the same reason. ADR-0004's atomic query is the join key an external
     keyword catalog is looked up by, so the channel is silently starved. Added by
     [CRMA-732](https://mcclatchy.atlassian.net/browse/CRMA-732). **This one is also a
     prerequisite** — CRMA-756 showed `VALIDATED` is the implicit default when
     `functionDeclarations` meet built-in tools, so a swap could hard-drop what today merely
     limps. Declaring `query` ships in the same slice as the pin change.
  8. **The distillation lane persists no run trace at all.** `REASONING_TRACE` is null on
     179 of 179 rows in 14 days, from two independent causes. Per candidate,
     `c.reasoning_trace` is `undefined` because the tool schema has no such property
     (`run_lead_agent/entry.js:771`). Run-level, the trace **is** built, capped, and POSTed
     across the wire (`entry.js:790` → `respond/entry.js:38`), then dropped by
     `distillation-p_mkCBBqb/parse_cluster_result/entry.mjs`, which passes through only
     `proposed_candidates`. No model id, per-run cost, turn count, or dispatch count is
     stored anywhere. Added by [CRMA-732](https://mcclatchy.atlassian.net/browse/CRMA-732).
     This is the "detection, not rollback" constraint biting a specific lane.

  9. **The promotion prompt promises a defer cap that does not exist, and the lane
     silently DEFERs when the agent runs out of turns.** Two mechanisms that
     compound. `sql/seed_prompts_promotion.sql:83` tells the model *"cap defers at 3
     per candidate (the system tracks this and will eventually force REJECT)"* —
     nothing tracks it. There is no `DEFER_COUNT` anywhere in the repo and
     `STG_TREND_CANDIDATES` carries only `DEFERRED_UNTIL` and `DEFER_REASON`; one
     candidate has deferred **7 times** (`cand-6nm5r52smodzwq5t`, 2026-04-26 →
     2026-05-08). Separately, when the loop exhausts `max_iterations` without a
     terminal call, `run_subagent/entry.js:713-717` defaults to DEFER behind a bare
     `console.log`. That is not hypothetical: **5 of 38 production DEFER rows carry
     `AMBIGUOUS_TOPIC_JUDGMENT` with rationale "agent did not call
     propose_decision"**, all five `gemini-3.1-pro-preview`, clustered on two
     candidates that each looped. A candidate the agent cannot resolve therefore
     re-enters the queue every 48h forever, costing a run each time and never
     reaching a verdict. Added by
     [CRMA-733](https://mcclatchy.atlassian.net/browse/CRMA-733). Model-independent —
     no pin choice fixes it.

  Related and also held: **`temperature` was deprecated 2026-07-21** and every lane still
  sends it. Full hazard list with sources is on CRMA-727.
- **The budget-gate trap binds any lane that moves — but check the headroom before
  calling it the lane's real gate.** If a model swaps but its `RATES_PER_M` stays at
  Pro's $2.00/$12.00 while running Flash's $0.75/$3.75, the in-loop `budget_usd` gate
  trips ~3× early, before the terminal `propose_*` call. Audit fails loudly; promotion
  silently defaults to DEFER, lifecycle silently emits an empty decisions array so status
  freezes, and enrichment returns null. Every lane ticket that answers "move" must still
  pair the pin change with its rate-table correction in the same slice — the cost
  telemetry is wrong otherwise.
  **Measured on promotion, the gate does not trip.** That lane was named as where the
  trap bites first, on the strength of having the tightest budget in the fleet ($0.15).
  Its worst production run in 21 days cost $0.0538, leaving ~5× headroom even with the
  rates wrong. The gate that actually bit was **`max_iterations`**, and it has zero
  margin. Size the headroom per lane rather than assuming the tightest budget is the
  first to fail. _Source: [CRMA-733](https://mcclatchy.atlassian.net/browse/CRMA-733)._
- **Detection, not rollback, is the binding cost of a switch.** Proven on the one lane where
  rollback is nearly free: no per-model cost telemetry, drop counters shared across all three
  discovery lanes, and failed shards swallowed silently, against a baseline that already
  swings 9–28 signals/day. A cheap undo is not a cheap experiment. Any lane that moves needs
  its before/after observable **before** it moves.

## Decisions so far

<!-- `resolve` appends here. Do not hand-edit while a session is running. -->

- [Research: gemini-3.7-flash API deltas and migration hazards vs gemini-3.1-pro-preview](https://mcclatchy.atlassian.net/browse/CRMA-727) — **Decided:** Migration risk sits in the call sites, not the model: 14 hazards with a six-line pre-flight per call site; three are live defects on today's 3.1 Pro setup, and whether undeclared schema fields are dropped is undocumented for BOTH models, so only replay can answer it.
  **Binds:** Every lane that moves pairs the pin change with its RATES_PER_M fix in the same slice (the budget gate trips ~3x early otherwise). CRMA-729's harness must measure field-dropping empirically per lane, deepest schemas first.

- [Decide: sequencing an enrichment model change against the descriptor embedding work (ADR-0003)](https://mcclatchy.atlassian.net/browse/CRMA-728) — **Decided:** The two efforts split: CRMA-463 proceeds now (its comparison is already run, green, and NOT confounded - the sweep postdates the Sonnet->Gemini move), while CRMA-464 waits for CRMA-735 because deleting the legacy embed-doc branch is the one irreversible act.
  **Binds:** CRMA-735 does not wait for the descriptor work - it waits for the harness. CRMA-729 must carry a descriptor-neighbor axis (embed candidate descriptor.statement, compare top-k neighbors, scratch table only, never the ledger) and must read the live enrichment prompt from DIM_LLM_PROMPT, since no repo file holds the active v7 template. CRMA-464's gate is a re-run of the comparison at full active-set coverage under the settled model.

- [Build the offline replay harness for per-lane model comparison](https://mcclatchy.atlassian.net/browse/CRMA-729) — **Decided:** Built: scripts/replay/ replays real historical inputs at any model across ten lanes (one per lane ticket), reusing each workflow's own SQL, the deployed entry.js tool schemas and dispatchers, and DIM_LLM_PROMPT — plus the CRMA-728 descriptor axis writing to a scratch table only.
  **Binds:** H8 is measured against functionDeclarations tool-arg schemas, NOT responseSchema — no lane in the repo declares one. Three re-measurements change map facts: candidatesTokenCount EXCLUDES thinking (gemini_loop.mjs:150 is wrong, CRMA-727 defect 2 confirmed); enrichment ledger MODEL_USED is mislabelled claude-sonnet-4-6 (a 4th defect for the epic, and the audit agent groups cost by it); distillation lead entry.js is dead code so the fleet has 17 live pins, not 18.

- [Research: what gemini-3.7-flash supports for API calls](https://mcclatchy.atlassian.net/browse/CRMA-756) — **Decided:** No primary source documents a STOP-with-partial-text failure, so the head-truncation is undocumented behaviour; `generateContent` is "legacy" but fully supported with NO published sunset, so moving surface is a choice; the Interactions API returns real publisher URLs in `url_citation.url` where the legacy surface only returns vertexaisearch redirects.
  **Binds:** `groundingSupports[].segment` offsets are per-part BYTE offsets, not character offsets into a joined string — any code that concatenates parts then slices is wrong. Structured output combined with grounding is Preview and names 3.7 explicitly, so CRMA-757 can test it. `VALIDATED` is the implicit default when functionDeclarations meet built-in tools, which the five loops' pinned `AUTO` currently overrides. Price the migration against the 2027-01-01 doubling, not today's introductory rate.

- [Decide: the distillation cluster-reasoning loops](https://mcclatchy.atlassian.net/browse/CRMA-732) — **Decided:** The lead pin (cluster-agent entry.js:453) MOVES to gemini-3.7-flash; the subagent pin splits out to CRMA-759 for lack of evidence. 5/5 clean emissions, no schema loss, topic quality a wash - but 3.7 Flash ran the dedup tools 3/5 where 3.1 Pro ran them 0/5 and proposed a trend it had already promoted.
  **Binds:** Cost is +20% vs Pro at Jan-2027 rates (extra turns eat the per-token win) and that trade is accepted deliberately. Seven changes ship in ONE slice with the pin: RATES_PER_M to 0.75/3.75, DECLARE query on propose_trend_candidate (blocker - QUERY is null on 100% of rows since 2026-08-18 and VALIDATED may hard-drop undeclared args), add thoughtsTokenCount, strip temperature, functionResponse ids, new finishReason values, and persist the run trace. CRMA-757 does NOT block this lane - it is ungrounded.

- [Decide: the promotion gate loop](https://mcclatchy.atlassian.net/browse/CRMA-733) — **Decided:** The promotion pin (run_subagent/entry.js:425) MOVES to gemini-3.7-flash. 7/7 identical decisions and merge targets vs the incumbent re-run, schema clean, and -17.2% cost even at the Jan-2027 rates.
  **Binds:** The budget-gate trap does NOT bind this lane (max production cost $0.0538 vs a $0.15 budget, ~5x headroom) - the real gate is max_iterations: 6, which has ZERO margin: the incumbent 3.1 Pro already burns all 6 turns and silently DEFERs on 5 of 38 production DEFER rows. Ships in one slice with RATES_PER_M 0.75/3.75, thoughtsTokenCount, strip temperature, functionResponse ids, new finishReason values, PLUS persist turns/stop_reason (no turn telemetry exists) and raise max_iterations or make the no-decision fallback loud.

- [Decide: the lifecycle and lifecycle-attribution loops](https://mcclatchy.atlassian.net/browse/CRMA-734) — **Decided:** Both lifecycle pins MOVE to gemini-3.7-flash at thinking_level medium: 9/9 identical status calls (incl. the irreversible DORMANT->RETIRED) and 4/4 identical attribution picks vs the incumbent re-run, schema clean throughout - but only after fixing a harness defect that fed the candidate the incumbent's own answer on 100% of cases.
  **Binds:** The budget-gate trap DOES bind this lane where it did not bind promotion: budget_usd 0.06 vs a 0.026 mean, and 1/9 runs trips it if RATES_PER_M stays at Pro. Fixing CRMA-727 defect 2 (thoughtsTokenCount) RE-TRIPS it at Jan-2027 rates, so pin + rate fix + thinking-token fix + a budget_usd RAISE are one indivisible slice. Cost -47.4% now / +5.3% Jan-2027, accepted; thinking_level stays medium (low is untested and this lane makes an irreversible RETIRED call). max_iterations 8 has ~2x headroom. Any lifecycle or attribution diff produced before 050a8b0 must be discarded. Lifecycle is the fleet's telemetry EXEMPLAR - it already persists TOOL_CALLS_JSON, STOP_REASON, MODEL_USED and cost - so the fleet-wide telemetry gap should copy its ledger shape.

- [Solve the grounded head-truncation on gemini-3.7-flash](https://mcclatchy.atlassian.net/browse/CRMA-757) — **Decided:** No call shape returns a complete grounded answer: truncation fires ONLY on grounded runs (14/14 truncations grounded, 0/9 ungrounded) at 41.1% of grounded calls across BOTH API surfaces, so grounded lanes cannot move to 3.7 Flash.
  **Binds:** The tool-channel shape is a FAKE WIN (45/45 whole answers but grounds 0/16 - functionDeclarations suppress google_search entirely); the Interactions API shows the same defect (9/25) AND returns 0 publisher URLs vs 123 vertexaisearch redirects, refuting CRMA-756's lead, so CRMA-758 loses both its arguments and keeps only Interactions' 100% grounding rate vs generateContent's 77.5%. CRMA-730 and CRMA-731 are unblocked with their answer forced to STAY. Structured output DOES combine with grounding on 3.7 (entry.js:7-9 cites a memory file that does not exist), and built-in tools + functionDeclarations need toolConfig.includeServerSideToolInvocations.

## Not yet specified

- **What a 3.7-shaped prompt looks like.** Every prompt in the registry was written against a
  Pro-era model, and two lanes have now failed a drop-in in ways that may be prompt-fixable —
  bare-homepage citations on the verticals, fabricated deep links on discovery. Whether there
  is one general rewrite pattern or nine lane-specific ones is unknown until a lane tries.
  The registry-driven lane is the cheapest place to learn it.
- **Whether the migration ships per lane or as a fleet cutover.** The old map assumed per-lane
  allocation. A migration might instead land one shared call-layer fix and move many lanes at
  once. Cannot be phrased sharply until CRMA-757 shows how much of a call site the fix touches.
- **Telemetry the migration needs to be verifiable at all.** Three instances:
  defect 6 (discovery loses shards silently), defect 8 (distillation persists no run trace),
  and CRMA-733's finding that promotion stores no subagent turn count while `max_iterations`
  is its binding gate. **The "every loop lane is missing it" framing is now falsified.**
  CRMA-734 found `FCT_TREND_LIFECYCLE_LEDGER` already persists `TOOL_CALLS_JSON`,
  `STOP_REASON`, `MODEL_USED` and per-run cost — the fleet's only recorded tool trace. So
  this is not a gap to design a shape for; it is a shape to **copy from lifecycle** to the
  lanes that lack it. What is still unsharp is the mechanism: whether that becomes one
  shared call-layer change or a per-lane ledger fix depends on CRMA-757.
- **Interaction effects.** If several lanes move, does the composite pipeline degrade even
  where each lane passed replay in isolation?
- **If Gemini 3.5 Pro ships mid-effort**, the question reopens for the loops. No announced
  date, so nothing to plan against yet.
- **Whether `functionCallingConfig: VALIDATED` replaces `AUTO`.** All five agent loops pin
  `AUTO`, overriding what CRMA-756 shows is the API's implicit default when functionDeclarations
  meet built-in tools. Relevant to every loop lane; the trade-off is unmeasured. Defect 7 is
  the first live instance of what rides on it — a lane depending on an **undeclared**
  argument surviving the call — so the fleet-wide question is now "which other lanes read a
  field their tool schema never declared?", still too coarse to ticket.

## Out of scope

- **[CRMA-725](https://mcclatchy.atlassian.net/browse/CRMA-725) — lanes that compute no cost
  at all.** A real bug, but it is its own effort.
- **`grok-live-search`.** Swapping `grok-4-latest` removes the X lane rather than improving
  reasoning. A separate effort if ever.
- **Redefining what a lane does.** Prompts and call shapes are in scope; the lane's output
  contract is not.
- **Execution of the migration.** The map ends at the spec.
- **GCP migration sequencing.** Owned by
  [CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429).
