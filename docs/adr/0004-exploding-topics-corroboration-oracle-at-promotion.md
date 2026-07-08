# Exploding Topics as a corroboration oracle: earning the second source family at promotion

**Status:** accepted (2026-07-06)

## Context

The promotion hard gate (`promotion-p_xMC99jg/run_lead_agent`) rejects a
candidate — **before any LLM dispatch, at $0** — when it fails either of two
rules:

- `cluster_size < 2` (orphan signals), and
- `source_families < 2` (single-platform bursts: "product velocity, not trends").

The second rule encodes the **two-independent-sources doctrine** (CONTEXT.md,
[Source]). It is the load-bearing guard: it turns away ~170 candidates/month
*solely* for lacking a second independent source family, and the
breadth-recovery analysis (`docs/exploding-topics-breadth-recovery.md`) shows a
high-quality core of ~44/month among them (high confidence **and** multiple
supporting signals) — genuinely promising trends whose only flaw is that just
one source has noticed them *yet*.

Exploding Topics is purchased and live. ADR-0003 gave us the string shape ET
rewards: an **atomic, consumer-vernacular** query matches ET ~67% vs. ~6% for a
compound topic/name. That unlocks ET as an **independent second opinion** on
exactly the single-family candidates the gate turns away.

The forcing constraint: `descriptor.query` (ADR-0003) is authored at
**enrichment**, which runs *after* promotion — so it does not exist at the gate.
An ET lookup at promotion needs a query string that exists at *candidate* time.

## Decision

Introduce Exploding Topics as a **corroboration oracle** at the promotion gate:
a positive ET verdict earns the missing second **source family** for a
single-family candidate. **The two-source doctrine stays intact** — ET does not
replace it; ET is a non-signal way to *clear* it. ET is not a [Source] and never
writes to `FCT_SIGNALS` / `SOURCE_BREAKDOWN`.

Mechanism:

- **Candidate query.** The distillation subagent authors a short atomic
  consumer-vernacular `query` alongside each candidate `topic` (same rule as
  `descriptor.query`, the candidate-lineage precursor to it), persisted to
  `STG_TREND_CANDIDATES.QUERY`.
- **Gate change (lead agent).** Drop the redundant `cluster_size < 2` check —
  distillation already enforces ≥2 supporting signals (schema `minItems: 2` +
  a hard code guard), so the gate check can never fire. Single-family candidates
  with `confidence ≥ τ AND specificity ≥ τ` are **routed into the subagent
  loop** instead of $0-rejected; low-quality single-family candidates are still
  hard-rejected.
- **ET as an agent tool.** The promotion subagent (already an agentic Gemini
  tool-loop) gains a `verify_exploding_topics` tool. The agent calls ET with
  `candidate.query`, **judges** whether the returned topic is genuinely the same
  concept (guarding ET's fuzzy match) and has meaningful `absolute_volume`, and
  if so counts ET as source #2 and promotes. ET's `classifications`
  (`exploding`/`regular`/`peaked`) and `growth` are **recorded but non-gating** —
  the gate asks "is this a real movement independent parties recognize," not "is
  it currently surging" (that is prediction's and lifecycle's job, post-promotion).
- **Additive-only, structurally.** Because ET can only *supply* a missing source
  family, it can never veto a candidate that already has two real families. A
  miss is a no-op (no rescue), a `peaked` verdict never removes a candidate from
  the pool. The subagent prompt carries this as an explicit constraint (the same
  agent handles multi-family candidates, so it must never reject one on a bad ET
  reading).
- **Storage, two homes.** (a) The *decision record* — `STG_TREND_CANDIDATES`
  columns `QUERY`, `ET_CORROBORATION` (VARIANT), `ET_WAS_SECOND_SOURCE`
  (BOOLEAN) — for audit and lift measurement. (b) The *trend intelligence* — a
  per-trend append-only `FCT_TREND_ET_LEDGER` (agent-owned-ledger pattern, like
  `FCT_TREND_ENRICHMENT_LEDGER` / `_PREDICTION_LEDGER`), seeded at promotion from
  the candidate's ET snapshot, holding the refreshable
  volume/growth/classifications for eventual ATLAS surfacing via
  `DT_TREND_DASHBOARD`.

## Considered options (and why rejected)

- **Confidence-only gate (retire the two-source doctrine).** Drop the source
  rule entirely; gate purely on `confidence`. Deferred, not rejected — it makes
  an *uncalibrated* self-assessed score the sole mechanical guard on the funnel,
  which requires calibrating `confidence` against outcomes first. Parked as the
  likely next move once ET-rescue data exists to calibrate against.
- **ET as a deterministic gate check (`total > 0` ⇒ second source).** Rejected:
  `/database-search` is fuzzy and returns near-matches; a blind `total > 0`
  manufactures false corroboration. Deciding "is this the same concept" is a
  judgment the agent should own.
- **Route *all* single-family candidates into the loop (no pre-filter).**
  Rejected on cost — ~170 LLM loops/month vs. ~44 with the
  `confidence ≥ τ AND specificity ≥ τ` pre-filter (specificity doubles as a
  proxy for "will this even produce a usable ET query").
- **Provider-neutral `FCT_TREND_EXTERNAL_DEMAND_LEDGER`.** Rejected as YAGNI —
  an ET-specific ledger now; add a sibling ledger if a second oracle arrives.
- **Put ET in `SOURCE_BREAKDOWN` / call it a "source".** Rejected: corrupts the
  [Source] glossary term (a Source writes to `FCT_SIGNALS`) and double-counts a
  non-signal.
- **Keep the `cluster_size < 2` gate.** Noted as redundant with distillation's
  ≥2-signal enforcement; removed for clarity, not behavior.

## Consequences

- Estimated **+15–40% promoted trends/month** (breadth-recovery doc),
  measurable directly via `STG_TREND_CANDIDATES.ET_WAS_SECOND_SOURCE` joined to
  trend survival.
- `confidence` and `specificity_score` become **load-bearing** as the routing
  pre-filter — today's SOFT-flag scores now gate the single-family bucket.
  They remain uncalibrated; the deferred confidence-only gate would depend on
  calibrating them, and the ET-rescue log is the data that enables it.
- Distillation now authors a `query` for **every** candidate (one cheap extra
  emission field), most of which never reach ET — accepted for lineage
  cleanliness (it is the precursor to `descriptor.query`).
- `FCT_TREND_ET_LEDGER` accrues from day one; the `DT_TREND_DASHBOARD` columns
  and ATLAS card that surface it are a **separate later slice**, so history
  exists when the frontend is built.
- The ET adapter, candidate `query`, and ledger are forward-compatible with a
  fuller agentic-verification revamp (promotion agent with more external tools)
  and with a #56-style validation-oracle re-use of the same ledger.
