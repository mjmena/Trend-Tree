# Singular trend name, clarity-first register, frozen on `FCT_TRENDS`

**Status:** accepted (2026-05-27); structure section revised same-day after
adversarial consult on the original two-beat mandate.

## Context

Through 2026-05 the enrichment agent emitted a **pair** of names per trend
(`TREND_NAME_B2C`, a creative-poetic consumer name; `TREND_NAME_B2B`, a
descriptive industry-register name), each frozen on `FCT_TRENDS` at first
enrichment. ATLAS defaulted to the B2C name with the B2B name available
alongside.

Strategist feedback consolidated through the 2026-05-26 Trend Agent Sync was
that the displayed name **wasn't communicating what the trend actually
represents**. The creative-poetic register (e.g., "Plush Architecture",
"Mouth-Breather"-class candidates that the corporate-media floor caught)
prioritised texture over comprehension; the descriptive register was closer
but landed too short to carry context. The product positioning shifted away
from naming-as-creative-output toward **naming-as-clarity** — a strategist
should be able to read the name and immediately understand the core of the
trend.

An empirical audit of 60 recent B2C names (2026-05-27 adversarial consult)
confirmed the failure mode and located it precisely: ~40 of 60 names were
substance-led but undecodable — a strategist shown only the name could not
identify the trend. Names like "Ocean Dust" (seaweed seasoning), "Beam &
Burn" (red-light yoga), "Charm & Carabiner" (anti-theft jewelry) all named
a *thing* but the metaphor was a slice or a mood, not the trend's core
noun. A separate, smaller failure class (~4–6 of 60) had a category-of-
change word as the leading noun ("Stealth Adaptive", "Clinical Intimate
Wellness", "Mushroom Modernism").

## Decision

Replace the dual emission with a **single canonical `FCT_TRENDS.TREND_NAME`**
column. The new convention:

- **Register: clear coined phrase.** Sits between today's B2B (descriptive,
  evocative) and B2C (creative-poetic), favouring "the metaphor teaches"
  over "the metaphor decorates." The corporate-media floor (sales-deck-safe,
  no crude / aggressive / insult-coded names) still applies verbatim.
- **Binding rule: `decode_pass`.** A strategist seeing only the name (no
  topic, no card context) must be able to identify the trend's core
  subject. Enforced at the reviewer step via a **two-call test**:
  - Decoder call — model sees `{name}` only and writes one sentence: "I
    think this trend is about X."
  - Verifier call — model sees `{decoder_guess, actual_topic}` and returns
    `decode_pass: bool` + a short reason.
  When `decode_pass = false`, the reviewer emits an alternate that either
  (a) sharpens the first beat to name the trend's core noun, or (b) adds a
  qualifier beat to anchor the metaphor.
- **Structure: emergent, not mandated.** One beat suffices when the first
  noun names the trend's core substance (e.g., "Tallow Renaissance",
  "Cottage Cheese Comeback", "Breathstride" — known-goods from production).
  A second qualifier beat is required when the first beat is metaphoric or
  non-self-locating (e.g., "Liquid Room Architecture for Hybrid Living",
  "Tactile Maximalism in the Loneliness Era"). **Two-beat is an outcome of
  failing decode_pass with a metaphoric first beat, not a structural rule.**
  Length: 2–8 words preferred, no hard cap.
- **Tier-1 hard rule (mechanical, no LLM judgment):** the first-beat noun
  may not be a category-of-change word — `architecture, maximalism,
  minimalism, wellness, modernism, movement, era, wave, mode, aesthetic,
  vibe, paradigm, philosophy`. These describe the *shape* of a cultural
  shift, not the substance of it; they belong (if anywhere) in the qualifier
  beat. Mechanical reject before any LLM call.
- **In-prompt critique (Layer 3) gets a new axis.** Replace `whimsy` with
  `decode_score` (0–10, floor of 7). Distinctiveness and specificity stay;
  whimsy is dropped because it actively rewarded the "decorative metaphor"
  pattern that produced the undecodable names. The agent self-predicts
  decode_score during candidate ranking; the Layer 4 two-call reviewer is
  the authoritative gate.
- **Storage: frozen on `FCT_TRENDS`** at first enrichment, same
  `WHERE TREND_NAME IS NULL` guard pattern as today's B2B/B2C fields.
  Re-enrichments emit candidates to
  `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:name_candidates_considered` (with
  decode_score and decode_pass recorded) but cannot overwrite the canonical
  name.
- **Migration: active-only re-enrichment.** Trends in
  `LIFECYCLE_STATUS IN ('NEW','GROWING','STABLE','RESURGENT')` are
  re-enriched once to populate `TREND_NAME`. Dormant / retired trends keep
  their legacy B2C/B2B values; `DT_TREND_DASHBOARD.TREND_NAME` falls back
  through `COALESCE(TREND_NAME, TREND_NAME_B2C, TREND_NAME_B2B,
  TREND_TOPIC)`. Decode_pass binds at write-time; no audit-time sweep over
  the active set. A separate one-time backfill job (out of scope here) can
  re-evaluate legacy enriched trends if surface quality drifts.
- **Prompt seeding: no static examples.** The
  `enrichment.agent.naming_guidance` prompt drops both the "Examples of
  bad output" and "Examples of good output" blocks — purely declarative
  rules + decode_pass enforcement. (Marty's standing preference; reinforced
  by the audit, which showed the existing good examples were all single-
  beat and would have biased the agent against the conditional-second-beat
  rule.) The anti-cliché soft list is slimmed: removed `moment, movement,
  era, wave, season, take, trend` (legitimate qualifier-beat words);
  retained `glow-up, vibe, energy, mode, drop, thing, life, world, story,
  daily, ritual` (worn-out trend-blog patterns regardless of position).

## Considered options (and why rejected)

- **Mandate two-beat structure unconditionally** (the original
  formulation). Rejected after the empirical audit: all six known-good
  outputs in the live `naming_guidance` prompt ("Cottage Cheese Comeback",
  "Tongue-Scraper Glow-Up", "Sleepy Girl Mocktail", "Tallow Renaissance",
  "Walk & Warrior", "Breathstride") are single-beat, and forcing a
  qualifier on any of them ("Tallow Renaissance for Seed-Oil Avoidance")
  makes them worse. The conditional decode_pass rule preserves these wins
  while still demanding a qualifier where the metaphor can't self-locate.
- **Substance-vs-category as the sole rule** (intermediate formulation
  during the consult — first beat must name a substance/practice/tool,
  never a category-of-change). Rejected as *necessary but not sufficient*:
  the 60-name audit showed substance-vs-category caught only ~4–6 of 60
  failures, while ~40 of 60 were substance-led but undecodable. The rule
  survives as the cheap mechanical Tier-1 guard above, but it doesn't carry
  the binding test on its own.
- **Reviewer-only enforcement of decode_pass** (no in-prompt
  `decode_score` axis). Rejected because the agent would keep generating
  "Ocean Dust"-class candidates that get reviewer-rejected, raising
  regeneration cost; cheaper to push the gradient into Layer 3 with the
  agent self-predicting decode_score, even if imperfect.
- **`check_decode` as a tool the agent can call iteratively** (Marty's
  question during the consult). Rejected as YAGNI: duplicates the reviewer's
  work, adds new failure modes (topic-leak risk if the tool isn't carefully
  scoped), and is only worth building once empirical reviewer-rejection
  rate proves to be a real cost. Revisit if reviewer rejects >30% of
  primary emissions.
- **Add `alternate_label` for an A/B test against the legacy B2C-style
  name.** Rejected because the decision *is* the philosophy pivot — the
  challenger register (creative-poetic) is the one we already concluded was
  failing. The A/B was comparing "the thing we believe is right" against
  "the thing we believe is wrong"; we'd discount the result either way.
  Burns a schema column on a hypothesis nobody holds.
- **Add `pill_label` for short UI chips.** Deferred. Kathryn owed an exact
  character count; we chose not to schema a field on TBD requirements.
  Pill-fit shortening can be added later as either an enrichment-time field
  or a push-time transform (Marcelo's path) — both routes remain open
  because no schema lock-in landed.
- **Evolving on `FCT_TREND_ENRICHMENT_LEDGER` (like `TREND_VECTOR`).**
  Rejected because the original "evolving" rationale was the A/B test, which
  was dropped. Names are human-consumed; silent rename of a trend card
  across re-enrichments is a UX regression, not a feature. Vector drift on
  the ledger is justified because the drift signal is the value; for names,
  drift is noise.
- **Full re-enrichment of every trend (including DORMANT/RETIRED).**
  Rejected on cost — at ~$0.40/run and active-set sizing, the active-only
  sweep is bounded; dormant/retired trends aren't surfaced on ATLAS anyway,
  so the COALESCE fallback through B2C/B2B is sufficient.
- **Backfill `TREND_NAME` from existing `TREND_NAME_B2C`.** Rejected as
  schema-consistent but register-inconsistent — every legacy trend would
  carry the creative-poetic name we just decided was wrong.
- **Plain descriptive register (e.g., "Modular Adaptable Furniture").**
  Rejected because it collapses into `SUBCATEGORY` and removes the reason
  the enrichment agent exists; a strategist already sees the subcategory
  chip on the card.

## Consequences

- `FCT_TRENDS` carries three name columns (`TREND_NAME`, `TREND_NAME_B2C`,
  `TREND_NAME_B2B`) for the foreseeable future. The latter two are
  fallback-only — no new code emits or consumes them. They can be dropped
  once every active trend has a `TREND_NAME` and dashboard consumers tolerate
  the simplified COALESCE.
- `DT_TREND_DASHBOARD.TREND_NAME` is now a real stored field with a fallback
  chain, not the pure-COALESCE column it was before. Update `CONTEXT.md`
  glossary entry for [trend name] to reflect the new semantics — done.
- The 4-layer naming refinement (interleaved thinking → tool loop →
  in-prompt 5-candidate critique → reviewer) stays intact; only the
  *output shape* changes. `name_candidates_considered` collapses from
  `5 b2b + 5 b2c` to ~5 single-audience candidates.
- The candidate pool stays on the ledger and is available as the data
  source for a future ATLAS name-picker UI (per Marty 2026-05-27: "I'll
  reach out about surfacing names"). That product surface is out of scope
  here.
- A new responsibility lands on the reviewer: the two-call `decode_pass`
  test. This is the most expensive new component (~$0.01 extra per emit
  at reviewer-scale, immaterial against the existing ~$0.40/run enrichment
  cost). If the test proves noisy in practice, it can be re-tuned without
  re-running the schema migration — the binding rule is isolated behind
  the cheapest revision path.
- Telemetry: emit `decode_pass` (bool) and `decode_score` (int, agent's
  self-prediction) into `FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD` on every
  emit, alongside `name_candidates_considered`. Lets downstream query
  "what fraction of active trends have decode_pass = false?" and decide
  whether a sweep is warranted.
