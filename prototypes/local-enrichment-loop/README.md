# PROTOTYPE — local enrichment loop (CRMA-438) — THROWAWAY

**Do not deploy. Do not merge to `production`.** This directory is a throwaway
prototype answering one question for the GCP-extraction map
([CRMA-429](https://mcclatchy.atlassian.net/browse/CRMA-429)):

> Does a local iteration loop for the enrichment agent actually feel
> meaningfully better than the Pipedream loop — edit → rerun latency, debugger
> attach, unit-testability of the prompt builders?

It ports `run_enrichment_agent` (Gemini 3.1 Pro agent loop) and
`run_name_reviewer` (Sonnet 4.6 two-stage reviewer) out of their Pipedream
steps in `enrichment-p_xMC995w/`, plus the five prefetch SQL queries from
`workflow.yaml`, into a plain Node 20 CLI. **Zero npm dependencies** — global
`fetch`, `node:test`, and the `snow` CLI for Snowflake (reuses your existing
`-c claude` auth).

What the port deliberately changes (the ergonomics under test):

- The step files' inlined helpers become real modules under `src/lib/` —
  the cross-file imports Pipedream forbids. Prompt builders and the Tier-1
  name check are pure functions with unit tests (`npm test`, no creds needed).
- Snowflake prefetch results can be captured once (`--capture`) and replayed
  offline (`--fixture`) — sub-second edit → rerun, deterministic, and no
  warehouse in the loop.
- `node --inspect-brk src/run.mjs …` gives a real debugger over the agent loop.

What it does NOT do (production stays untouched):

- No `$.respond()`, no write workflow, no ledger writes.
- The `tag_signals` UPDATE step is **not** ported — the prototype never writes
  to Snowflake. (Live ingest tool calls still go through the shared Pipedream
  tool endpoints, which persist signals exactly as they do for any prod agent
  run; the session id carries a `proto-sess-` prefix so those rows are
  identifiable.)

## Run it

```sh
# unit tests — no credentials needed
npm test

# capture prefetch fixtures for one trend (needs snow CLI auth only)
node src/run.mjs <trend_id> --capture --dry-run

# full local run against real Snowflake + real LLM keys
export GEMINI_API_KEY=...        # agent loop (Gemini 3.1 Pro)
export ANTHROPIC_API_KEY=...     # name reviewer (Sonnet 4.6)
node src/run.mjs <trend_id>

# fast offline rerun from fixtures (the edit→rerun loop under test)
node src/run.mjs <trend_id> --fixture

# debugger
node --inspect-brk src/run.mjs <trend_id> --fixture

# knobs
node src/run.mjs <trend_id> --budget 0.10 --max-iter 4 --skip-reviewer
```

Output: the enrichment record + telemetry JSON to stdout and
`out/<trend_id>.json`; per-phase wall-clock timings to stderr.

## Container

`Dockerfile` packages the same CLI (`docker build -t enrich-proto . &&
docker run -e GEMINI_API_KEY -e ANTHROPIC_API_KEY enrich-proto <trend_id>
--fixture`). Note: fixtures must be captured before `docker build` (they're
copied into the image; `--capture` inside the container would need snow CLI
auth mounted). No container runtime was installed on the authoring machine —
build verified separately, see the ticket thread.
