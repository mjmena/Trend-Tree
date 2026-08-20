# Offline replay harness

Fires real historical inputs at a chosen model and puts the result beside what
the pipeline actually produced. Built for [CRMA-729][729] to unblock the nine
per-lane model decisions under [CRMA-726][726].

This is an **instrument, not a deliverable**. It does not score a lane and it
does not recommend a switch. It shows the diff; the lane ticket decides.

```sh
node scripts/replay/replay.mjs enrichment --model gemini-3.7-flash --limit 3
node scripts/replay/replay.mjs --help
bash scripts/replay/smoke.sh          # dry-run every lane, no model calls
node --test scripts/replay/lib/*.test.mjs
```

## What you need

- `snow` CLI on the `claude` connection. The harness only **reads** production.
  Its one write is the descriptor scratch table below.
- A Gemini key in the macOS keychain as `gemini-api`, or `GEMINI_API_KEY`.
- Nothing else. There is no `package.json` in this repo and the harness installs
  nothing — bare `node`, plus `python3` with PyYAML to read `workflow.yaml`.

An Anthropic key is **not** required. The one Anthropic lane reads its incumbent
from the ledger and fires only the candidate.

## The lanes

| Lane | Ticket | Incumbent | What makes it different |
| --- | --- | --- | --- |
| `enrichment` | [CRMA-735][735] | `gemini-3.1-pro-preview` | Deepest schema in the fleet — 39 declared leaf paths. Carries the descriptor axis. |
| `promotion` | [CRMA-733][733] | `gemini-3.1-pro-preview` | Tightest budget (`$0.15`). Where the budget-gate trap bites first. |
| `lifecycle` | [CRMA-734][734] | `gemini-3.1-pro-preview` | Highest volume in the fleet. The only lane with a recorded tool trace. |
| `attribution` | [CRMA-734][734] | `gemini-3.1-pro-preview` | Asymmetric errors — a false positive silently inflates heat. |
| `distillation` | [CRMA-732][732] | `gemini-3.1-pro-preview` | Shared by distillation *and* revisit; decides what counts as a trend. |
| `audit` | [CRMA-736][736] | `gemini-3.1-pro-preview` | Shallow schema — the contrast case for the H8 measurement. |
| `verticals` | [CRMA-730][730] | `gemini-3-flash-preview` | No thinking parameter at all — where 3.7 Flash's thinking floor lands. |
| `discovery` | [CRMA-731][731] | `gemini-2.5-flash` | The only registry-driven lane: moving it is an `UPDATE`, not a deploy. |
| `daily-digest` | [CRMA-738][738] | `gemini-3.1-pro-preview` | Only lane using `responseMimeType`; its rate table disagrees with the other twelve. |
| `name-reviewer` | [CRMA-737][737] | `claude-sonnet-4-6` | The Anthropic pin with a persisted incumbent record. |

## How a replay is built

The harness is deliberately paranoid about replaying *the code that actually
runs*, because a lane decision is only as good as the input it was made on.

1. **Inputs come from the workflow's own SQL.** `lib/workflow.mjs` reads
   `workflow.yaml`, takes the `snowflake-execute-sql-query` step bodies, and
   re-binds them to a historical id. Edit a step and the replay follows. A
   placeholder the lane cannot bind is a hard error, never an empty string — an
   unbound `WHERE` returns no rows, and no rows reads exactly like "this trend
   had no signals".
2. **Tool schemas and dispatchers come from the deployed step file.**
   `lib/entry_module.mjs` loads the real `entry.js`, shimming
   `defineComponent` so the module evaluates outside Pipedream. `agents/lib/*`
   is a *reference copy* that the repo itself warns can drift, so importing it
   would replay something other than production.
3. **Prompts come from `DIM_LLM_PROMPT`, never the repo.** This is the
   [CRMA-728][728] trap: `sql/update_enrichment_system_v7_descriptor.sql` patches
   v6 with a surgical `REPLACE()`, so no file holds the live v7 enrichment
   template. Every run prints the prompt versions it used.
4. **The incumbent side is read, not regenerated** — the map's standing
   constraint. Use `--rerun-incumbent` to also fire the incumbent today, which
   separates a model change from a world change.

## Reading the output

**Schema coverage** answers CRMA-727 hazard H8 empirically, per lane. No
official source says whether undeclared schema fields are dropped, for *either*
model, so the harness measures the emitted payload field by field — the
[CRMA-722][722] method. `fields lost` and `missing required` are the ones that
should stop a switch.

> One correction to how the ticket framed H8: **no lane in this repo declares a
> `responseSchema`.** Every deep schema is a `functionDeclarations` parameter
> schema on a terminal emit tool, so that is what gets measured.

**Accounting** prints cost twice, because the two live sources disagree.
`agents/lib/gemini_loop.mjs:150` says `candidatesTokenCount` already includes
thinking tokens; CRMA-727 defect 2 says it does not. The harness reports both
and marks which reconciles against the API's own `totalTokenCount`. Measured
across every loop run so far, the answer is **`candidates_excludes_thinking`** —
the deployed comment is wrong and production under-reports its own cost. When a
call returns zero thinking tokens the test proves nothing and says so.

**`--descriptor-neighbors`** is the [CRMA-728][728] axis, on the enrichment lane.
It embeds the candidate's `descriptor.statement` with the same Cortex model that
produced `TREND_VECTOR`, finds its nearest live trends, and compares them with
the incumbent statement's. A statement can read well and still embed badly;
this is the only place that shows up.

It writes to `MCC_RAW.MARKETING_DEV.TMP_REPLAY_DESCRIPTOR_NEIGHBORS` — a
**scratch** table. It never writes an enrichment ledger and never updates a
`TREND_VECTOR`.

It also makes [ADR-0003][adr3]'s comparison re-runnable. That ADR describes the
method in prose but its "Reproduce" section points at two temp tables and "see
#54 working notes", with no SQL. [CRMA-464][464]'s gate is a re-run of that
comparison at full active-set coverage, so the SQL in
`lib/descriptor_neighbors.mjs` outlives this map.

**Per ADR-0003, a lower mean cosine is not automatically a regression** — the
legacy multi-field embed doc inflated similarity through shared boilerplate.
Judge neighbour overlap and identical-#1 first.

## What it cannot do

Named plainly, because a limit you know about is a caveat and a limit you don't
is a wrong decision.

- **Grounded lanes are not reproducible.** `verticals` and `discovery` search
  the live web from a prompt dated today. Their ledger rows are background;
  compare both models fired now (`--rerun-incumbent`).
- **`audit` has no historical binding.** Its prefetch is always "the last 24
  hours", so it audits today's pipeline whichever model runs it.
- **`daily-digest` persists nothing.** The intro goes to Braze, so there is no
  incumbent record at all.
- **Live tools move.** `ingest_*` tools hit the same endpoints production uses,
  so a replayed run sees today's Bluesky and GDELT, not the incumbent's.
- **URL liveness is checked from a laptop.** Publishers that block this IP will
  read as dead links; confirm before counting that against a lane.
- **`distillation` reconstructs its cluster hint.** The real Louvain grouping
  from `PROC_CLUSTER_SIGNAL_SUBSET` is not persisted, so the replay presents one
  historical candidate's signals as a single community. It answers "what does
  the model propose given these signals?", not "would it have found this cluster
  in the firehose?".
- **`attribution` sees a shrunken pool.** Signals the incumbent already
  attributed are excluded by the anti-join. Compare acceptance *rate*.
- **Two prompt bodies are reimplemented, not imported** — enrichment's and
  lifecycle's user-message formatting live inside `run()` and cannot be loaded.
  Both are line-for-line copies with the source lines cited in the adapter.

## Adding a lane

A lane is one file in `lanes/` exporting `name`, `summary`, `incumbentModel`,
`ticket`, and three functions:

- `cases({limit, caseId})` — pick historical cases, each with an `incumbent`.
- `build(case)` — assemble the model input. Return `mode: "loop"` with
  `tools`/`dispatchTool`/`terminalTool`, or `mode: "single"` with
  `contents`/`parse`.
- `compareRows(incumbent, candidate, result)` — the axes a human judges on.

Optionally export `requiresRerun` (the incumbent record is not comparable) or
`descriptorStatements` (opt into the descriptor axis).

Run `bash scripts/replay/smoke.sh` after any workflow change. It dry-runs every
lane against real Snowflake and the live registry, makes no model calls, and
catches the failure that actually bites: a step renamed or re-bound underneath a
lane adapter.

## Findings this harness produced while being built

Recorded here because each one changes something a lane ticket would otherwise
assume. All are on [CRMA-729][729] in full.

1. **`candidatesTokenCount` excludes thinking tokens**, on both models,
   confirmed by arithmetic against `totalTokenCount`. CRMA-727 defect 2 holds;
   the deployed comment asserting the opposite is wrong.
2. **The enrichment ledger's `MODEL_USED` column is mislabelled.** It reads
   `claude-sonnet-4-6` on every recent row while `agent_telemetry.model` reads
   `gemini-3.1-pro-preview`. Enrichment really does run Gemini —
   `CLAUDE.md`'s "lone Anthropic holdout" line is stale, and the audit agent
   reads that column for its per-model cost report.
3. **`distillation-p_mkCBBqb/run_lead_agent/entry.js` is dead code.** The
   workflow has no `run_lead_agent` namespace, so its pin is not live and the
   fleet has 17 live pins, not 18.

[726]: https://mcclatchy.atlassian.net/browse/CRMA-726
[728]: https://mcclatchy.atlassian.net/browse/CRMA-728
[729]: https://mcclatchy.atlassian.net/browse/CRMA-729
[730]: https://mcclatchy.atlassian.net/browse/CRMA-730
[731]: https://mcclatchy.atlassian.net/browse/CRMA-731
[732]: https://mcclatchy.atlassian.net/browse/CRMA-732
[733]: https://mcclatchy.atlassian.net/browse/CRMA-733
[734]: https://mcclatchy.atlassian.net/browse/CRMA-734
[735]: https://mcclatchy.atlassian.net/browse/CRMA-735
[736]: https://mcclatchy.atlassian.net/browse/CRMA-736
[737]: https://mcclatchy.atlassian.net/browse/CRMA-737
[738]: https://mcclatchy.atlassian.net/browse/CRMA-738
[722]: https://mcclatchy.atlassian.net/browse/CRMA-722
[464]: https://mcclatchy.atlassian.net/browse/CRMA-464
[adr3]: ../../docs/adr/0003-trend-descriptor-sweep-sample.md
