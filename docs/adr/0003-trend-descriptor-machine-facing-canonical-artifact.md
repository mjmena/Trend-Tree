# Trend descriptor: a machine-facing canonical artifact, distinct from name and topic

**Status:** accepted (2026-06-29)

## Context

The enrichment record has three trend-text fields, and all of them are tuned
for a *human* reader:

- `TREND_NAME` (ADR-0001) is deliberately evocative — clarity-first but still a
  coined phrase, frozen at first enrichment, gated by `decode_pass`. Flavor.
- `summary_short` / `summary_long` are spec'd as **action-oriented** — output
  copy for strategists.
- `TREND_TOPIC` is the closest thing to a neutral machine string, but it is the
  *promotion-time* identity seed: coined cheaply by Cortex from the candidate,
  ≤80 chars, **frozen and never re-derived** (dedup + candidate lineage depend
  on it). It already (a) is machine-audience and (b) seeds the embedding via
  `FN_TREND_EMBED_DOC(TREND_TOPIC | summary_long | drivers | narrative)`.

What the record lacks is a **faithful, de-buzzworded representation of what the
trend *is*, authored for consumption by other systems** — the embedding,
external APIs, and the forthcoming Collections work. Names are flavor; we need
the soul, in a register meant for machines.

The forcing case is Exploding Topics (purchased; API key live locally). ET keys
on its own 1.1M-topic catalog by keyword, returning `{"result": …}` on a hit and
`{"message":"No topic found."}` (HTTP 200) on a miss. Querying it with the
evocative `TREND_NAME` is meaningless, and even `TREND_TOPIC` is hit-or-miss: a
live sample ranges from crisp noun-verb topics to vague category labels
("Food and Beverage Trends", "K-Beauty Trends", "Global Spice Surge"). The
catalog match rate — the thing the feasibility doc called the binding constraint —
is gated on having a *canonical query string*, not a marketing name.

## Decision

Introduce a first-class **trend descriptor**: a machine-facing canonical
artifact authored by the enrichment agent, stored as a nested object at
`FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:descriptor` with two authored members:

- **`statement`** — the faithful prose core (a tight 2–4-sentence paragraph:
  subject, specific behavior/product, distinguishing axis vs. siblings, domain).
  Becomes the **sole** input to `FN_TREND_EMBED_DOC`, replacing the 4-field
  concatenation. The substrate for semantic matching and Collections.
- **`query`** — a short canonical catalog/search term; the join key to external
  keyword APIs (first consumer: Exploding Topics), and the enrichment-grade
  generalization of `GTRENDS_KEYWORD`.

Properties:

- **Machine-facing** — the opposite register from `TREND_NAME`. Not a summary;
  no marketing flavor, no call-to-action.
- **Evolving on the ledger** (latest-non-null per trend), like `TREND_VECTOR` —
  *not* frozen. It moves with the vector drift time series; a sharper machine
  representation after more grounding is a pure improvement, and there is no
  human-visible rename to protect (the freeze rationale for `TREND_NAME` does
  not apply).
- **`statement` is the sole embed seed.** Focus beats volume for identity
  similarity — a fixed-size vector *averages* its input, so drivers/narrative
  dilute the identity signal. Cutover via a COALESCE fallback to the legacy
  recipe, gated on a **measured neighbor-quality check**.
- **No dedicated quality gate** (no `decode_pass` analog). Faithfulness is
  enforced by declarative noun-verb / specificity rules in-prompt (reusing the
  distillation candidate rubric) plus a self-emitted `specificity_score`
  telemetry field. The consumers provide the empirical check: an unfaithful
  `query` misses in ET; an unfaithful `statement` yields bad embedding
  neighbors. Add a reviewer pass only if those signals show systematic failure.
- **`query` is tuned against ET match rate** (owned API) — probe ET to learn
  what string shape its catalog rewards, then bake those rules into the
  `query`-authoring prompt (probe-informs-prompt).

## Empirical grounding (2026-06-29 probe)

A probe over 18 active trends against ET's fuzzy `/database-search` settled the
binding question — vocabulary mismatch vs. domain skew:

- Querying with the **compound** `TREND_TOPIC` / short head-term / `TREND_NAME`:
  **~6% match rate** (1/18), and the rare hits were junk ("Curated Clutter" →
  "Upchoose"; "AI-Powered Shopping" → "Smart shopping cart").
- Querying the same trends' **atomic core term**: **67% match rate** (10/15),
  with clean on-target hits (`snail mucin`, `PDRN`, `scalp serum`, `GLP-1`,
  `head spa`, `magnesium glycinate`).

Conclusion: **it's vocabulary mismatch, not domain skew** — ET covers
McClatchy's consumer trends; our strings were the wrong shape. The atomic
*misses* spec what to avoid: industry jargon (`retailtainment`, `agentic
commerce`), and fresh internet-slang neologisms (`looksmaxxing`,
`fibermaxxing`, `dirty soda`) that ET lags on.

This yields the `descriptor.query` authoring rule: **a single atomic,
consumer-vernacular noun (ingredient / product / practice a shopper would
search) — not the compound behavior, not coined marketing labels, not industry
jargon.** Probe-informs-prompt, realized.

(Operational note: ET is behind Cloudflare and silently 403s clients with a
default library User-Agent — set a browser UA, same class of gotcha as GDELT.)

## Considered options (and why rejected)

- **Re-derive / upgrade `TREND_TOPIC` in place.** Rejected: overloads the
  frozen dedup + candidate-lineage identity key. Topic must stay frozen.
- **A single flat string serving all consumers.** Rejected: ET wants a short
  keyword, the embedding wants prose — one string can't be optimal for both.
  And extracting the keyword from a sentence by adapter is the weak link;
  authoring it is a *judgment* task the researched agent does best.
- **A structured bundle with `entities[]` / `keywords[]` now.** Deferred as
  YAGNI; the nested object extends cleanly when a consumer actually needs them.
- **Fold in issue #40 (search keywords/aliases from `FCT_TREND_GSC_TERMS`).**
  Rejected: different lineage — #40 is *observed first-party search demand*;
  the descriptor is *authored from research*. The ET adapter can later draw on
  both, but they stay distinct concepts.
- **Embed more prose into the trend vector.** Rejected: a fixed-size embedding
  averages its input, so more text dilutes rather than sharpens identity
  similarity. The lever is faithfulness + focus, not volume.
- **Freeze the descriptor like `TREND_NAME`.** Rejected: freezing the substrate
  would kill the `TREND_VECTOR` drift-tracking that justifies keeping the vector
  on the ledger; and a machine field has no UX rename to protect.
- **A dedicated reviewer gate from day one.** Rejected on cheapest-revision-path
  grounds (same logic as ADR-0001's rejected `check_decode` tool); the
  descriptor is lower-stakes (machine-facing, evolving, recoverable) and the
  downstream metrics already close the loop.
- **Faked SQL/Cortex backfill of descriptors for live trends.** Rejected:
  manufactures a descriptor without the agent's grounding, defeating the
  faithfulness that is the entire point. Re-enrich for real, or fall back.
- **Full re-enrichment of every trend up front.** Rejected on cost; the
  COALESCE fallback lets dormant/retired trends keep their legacy embed doc.

## Consequences

- `FN_TREND_EMBED_DOC` changes to read `descriptor.statement` with a COALESCE
  fallback to the legacy `topic | summary_long | drivers | narrative` recipe.
  The legacy branch retires only after the neighbor-quality check passes.
- The enrichment agent emits `descriptor { statement, query }` plus a
  `specificity_score` on every run.
- **Migration: active-only re-enrichment** (`LIFECYCLE_STATUS IN
  ('NEW','GROWING','STABLE','RESURGENT')`) populates descriptors for live
  trends; the rest ride the fallback. Same scoping as ADR-0001's name sweep.
- `GTRENDS_KEYWORD` may eventually be superseded by `descriptor.query` (both are
  short machine query strings; the descriptor's is research-grade).
- Exploding Topics becomes the first `descriptor.query` consumer; its match rate
  is both an ET-utility metric and the empirical objective for `query` authoring.
- `docs/exploding-topics-feasibility.md` is **superseded** — the purchase is
  made; ET is now a tool to optimize against, not a decision to make.
