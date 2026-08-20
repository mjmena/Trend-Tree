<!-- map: CRMA-726 -->

# Gemini 3.7 Flash — per-lane model allocation across the agent fleet

## Destination

A replacement spec that supersedes [CRMA-471](https://mcclatchy.atlassian.net/browse/CRMA-471),
deciding **per lane** whether each in-scope model pin moves to `gemini-3.7-flash` or stays.
Handed to `/to-tickets`. The map does not carry execution.

## Notes

- **Domain**: read `CONTEXT.md` before writing about signals, trends, or the descriptor.
  Tracker contract is `docs/agents/issue-tracker.md`.
- **Skills**: `pipedream-synced-project` for anything touching a workflow or a deploy;
  `/domain-modeling` when the model-pin vs registry-driven distinction gets its glossary entry.
- **One instrument, built inside the map.** The replay harness is a `task` ticket, not a
  deliverable. This is a deliberate, scoped exception to plan-don't-do: nine decision
  tickets are unanswerable without it. Nothing else in this map executes.
- **Never commit this map to `production`.** A commit to the default branch is a Pipedream
  deploy of every changed workflow.

## Established facts

<!-- Measured state of the world. Falsified by RE-MEASUREMENT, never by a decision. -->

- **18 live model pins across the workflows** — 9 on `gemini-3.1-pro-preview` (audit,
  daily-digest, cluster-agent, distillation lead, distillation subagent, enrichment,
  lifecycle subagent, lifecycle-attribution subagent, promotion); 5 on
  `gemini-3-flash-preview` (4 verticals + prompt-tester default); 3 Anthropic
  (`run_name_reviewer` and `run_revisit_subagent` on `claude-sonnet-4-6`,
  `generate_search_terms` on `claude-haiku-4-5-20251001`); 1 on `grok-4-latest`.
  `agents/lib/*.mjs` holds two more as reference copies, not deployed.
  _Source: repo inventory, verified 2026-08-20._
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
- **No shutdown date is published** for `gemini-3-flash-preview`, `gemini-2.5-flash`, or
  `gemini-3.1-pro-preview`. Preview ids here do get retired eventually (`gemini-2.0-flash`
  went 2026-06-01) but no clock is running today.
  _Source: ai.google.dev/gemini-api/docs/deprecations, 2026-08-20._
- **No official 3.7 Flash vs 3.1 Pro head-to-head exists.** Google's model card compares
  3.7 Flash only against 3.6 Flash and Claude Sonnet 5, beating Sonnet 5 on all four
  published rows (FrontierCode, DeepSWE, Terminal-bench, GDM-MRCR). Head-to-head figures
  circulating on aggregator sites are absent from Google's own docs and disagree between
  providers — treat as unverified. _Source: DeepMind model card + aggregator survey, 2026-08-20._
- **The nine Pro loops already run `thinking_level: "medium"`. The four verticals run
  single-shot at `temperature 0.3` with no thinking parameter at all.** The 3.7 Flash
  thinking floor therefore lands entirely on the verticals.
  _Source: repo inventory, verified 2026-08-20._
- **Google has split the API surface.** `ai.google.dev/gemini-api/docs/*` now documents a
  new **Interactions API** (`POST /v1beta/interactions`). The
  `v1beta/models/{model}:generateContent` path every workflow here uses is moved to
  `/docs/generate-content/*` and labelled **"(Legacy)"**. `gemini-3.7-flash` is supported on
  generateContent and no sunset is published, but `gemini-3-pro-preview` went release to
  shutdown in ~3.5 months. _Source: [CRMA-727](https://mcclatchy.atlassian.net/browse/CRMA-727) research, 2026-08-20._
- **`temperature` is deprecated** as of 2026-07-21; the migration checklist says to strip
  `temperature`, `top_p`, and `top_k`. Every lane here still sends it.
  _Source: [CRMA-727](https://mcclatchy.atlassian.net/browse/CRMA-727) research, 2026-08-20._
- **No official source states whether undeclared schema fields are dropped, for either
  model.** There is no documented behavioural delta between 3.1 Pro and 3.7 Flash, and the
  structured-output support table does not list 3.7 at all.
  [CRMA-722](https://mcclatchy.atlassian.net/browse/CRMA-722) remains the only hard evidence
  and it is empirical. A bare `{type:"object"}` passes contents through unvalidated, which is
  why the audit agent's shallow schema survived and enrichment's deeply-typed
  `propose_enrichment` is the more exposed one.
  _Source: [CRMA-727](https://mcclatchy.atlassian.net/browse/CRMA-727) research, 2026-08-20._

## Standing constraints

<!-- Settled decisions in binding present tense. Overturned only by another decision. -->

- **The motive is capability, not cost.** A lane moves because it does the job better.
- **Cost is a non-regression constraint, not a gate.** A lane may move when quality improves
  and cost does not materially rise; a large cost rise needs a deliberate "yes, worth it".
  No numeric threshold — the rate tables disagree with each other and fixing them is not
  this map's job.
- **Scope is the 9 Pro pins, the 5 `gemini-3-flash-preview` pins, and the 3 Anthropic pins.**
  Grok is out: `grok-live-search` is X-only live search, so the model *is* the data source.
- **Evidence is offline replay.** Historical inputs pulled from the ledgers, fired at the
  candidate model, compared side by side against what the incumbent actually produced,
  judged per lane, with human review of the diff. Not shadow-running, not sequential A/B.
- **Allocation is per-lane and `stay` is the default.** A lane moves only when replay shows
  it better. Uniformity is not a goal.
- **The switch targets Pipedream now.** It does not wait for
  [CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429); model ids are configuration
  and travel with the code to Cloud Run.
- **CRMA-471 closes as superseded only when the replacement spec lands** — not before. Its
  slice structure, gate design, and registry-migration pattern are worth lifting.
- **Rate-table hygiene rides in the spec, not on the map.** It is not a decision, but the
  spec must say what happens to the 13 tables or an implementer ships a wrong cost number.
- **The three live defects found by [CRMA-727](https://mcclatchy.atlassian.net/browse/CRMA-727)
  are held for the eventual epic, not filed separately.** They are defects on today's
  `gemini-3.1-pro-preview` setup and bite whether or not any lane moves, but filing them as
  lone tickets scatters work that belongs in one place. The spec **must** carry them as
  remediation items, and `/to-tickets` turns them into stories under the epic:
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

  Related and also held: **`temperature` was deprecated 2026-07-21** and every lane still
  sends it. Full hazard list with sources is on CRMA-727.
- **The budget-gate trap binds any lane that moves.** If a model swaps but its `RATES_PER_M`
  stays at Pro's $2.00/$12.00 while running Flash's $0.75/$3.75, the in-loop `budget_usd`
  gate trips ~3× early, before the terminal `propose_*` call. Audit fails loudly; promotion
  silently defaults to DEFER, lifecycle silently emits an empty decisions array so status
  freezes, and enrichment returns null. Every lane ticket that answers "move" must pair the
  pin change with its rate-table correction in the same slice.

## Decisions so far

<!-- `resolve` appends here. Do not hand-edit while a session is running. -->

- [Research: gemini-3.7-flash API deltas and migration hazards vs gemini-3.1-pro-preview](https://mcclatchy.atlassian.net/browse/CRMA-727) — **Decided:** Migration risk sits in the call sites, not the model: 14 hazards with a six-line pre-flight per call site; three are live defects on today's 3.1 Pro setup, and whether undeclared schema fields are dropped is undocumented for BOTH models, so only replay can answer it.
  **Binds:** Every lane that answers 'move' pairs the pin change with its RATES_PER_M fix in the same slice (the budget gate trips ~3x early otherwise). The thinking floor lands entirely on the four discovery verticals. CRMA-729's harness must measure field-dropping empirically per lane, deepest schemas first.

- [Decide: sequencing an enrichment model change against the descriptor embedding work (ADR-0003)](https://mcclatchy.atlassian.net/browse/CRMA-728) — **Decided:** The two efforts split: CRMA-463 proceeds now (its comparison is already run, green, and NOT confounded - the sweep postdates the Sonnet->Gemini move), while CRMA-464 waits for CRMA-735 because deleting the legacy embed-doc branch is the one irreversible act.
  **Binds:** CRMA-735 does not wait for the descriptor work - it waits for the harness. CRMA-729 must carry a descriptor-neighbor axis (embed candidate descriptor.statement, compare top-k neighbors, scratch table only, never the ledger) and must read the live enrichment prompt from DIM_LLM_PROMPT, since no repo file holds the active v7 template. CRMA-464's gate is a re-run of the comparison at full active-set coverage under the settled model.

## Not yet specified

- **Interaction effects.** If several lanes move, does the composite pipeline degrade even
  where each lane passed replay in isolation? Cannot be phrased sharply until we know which
  lanes actually move.
- **Prompts tuned for Pro.** Every prompt in the registry was written against a Pro model.
  A lane may fail replay because of the prompt, not the model. Prompt rewrites are out of
  scope today; whether that holds depends on how many lanes fail for that reason.
- **If Gemini 3.5 Pro ships mid-effort**, the per-lane question reopens for the loops that
  chose `stay`. No announced date, so nothing to plan against yet.
- **Whether the replay harness outlives the map** as a permanent regression instrument
  rather than a throwaway. Decide once it exists and we know what it cost to build. Now
  leaning permanent: [CRMA-728](https://mcclatchy.atlassian.net/browse/CRMA-728) gave it a
  second standing consumer outside this map — the descriptor neighbor-quality comparison,
  which [CRMA-464](https://mcclatchy.atlassian.net/browse/CRMA-464) must re-run at full
  active-set coverage and which exists today only as prose.
- **Whether the fleet should move to the Interactions API at all.** `generateContent` is now
  labelled Legacy. That question is larger than a model pin and could subsume this map — but
  it cannot be phrased sharply until someone measures what the new surface costs to adopt
  across 18 call sites. Graduates once CRMA-729's harness shows how much of a call site a
  model swap actually touches.
- **Whether `functionCallingConfig: VALIDATED` replaces `AUTO`.** All five agent loops pin
  `AUTO`, opting out of the mode Google says reduces malformed function calls. Relevant to
  every lane, but the trade-off is unmeasured and it interacts with Search grounding, where
  mixing grounding with `functionDeclarations` forces `VALIDATED` and is still Preview.

## Out of scope

- **[CRMA-725](https://mcclatchy.atlassian.net/browse/CRMA-725) — lanes that compute no cost
  at all.** A real bug, but it blocks a cost argument and the motive here is capability.
- **`grok-live-search`.** Swapping `grok-4-latest` removes the X lane rather than improving
  reasoning. A separate effort if ever.
- **Prompt template rewrites and temperature retunes.** Exactly one variable changes per lane.
- **Execution of the conversion.** The map ends at the spec.
- **GCP migration sequencing.** Owned by
  [CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429).
