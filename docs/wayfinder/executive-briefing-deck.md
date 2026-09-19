<!-- map: CRMA-1199 -->

# Executive briefing deck for Trend Tree

## Destination

A finished, self-contained executive HTML deck (~12 slides) presenting Trend Tree — its use cases, how it works, current state and integrations, and future plans — checked into the repo and published as a private Artifact link. Built for live presentation by Martin, legible when forwarded.

## Notes

- **Subject and audience.** The deck is a dive into Trend Tree itself — what it produces, for consumers like ATLAS. The audience is executives with partial exposure: they saw the May "AI Forward Award" 5-minute showcase, so the deck spends its time on how it works and where it is going, not on re-earning attention. Informational — the deck carries no ask.
- **The tree image is the organizing visual.** A tree-shaped funnel — many signals in, promotion candidates in the middle, a trend at the top — inspired the project's name and scope. It does not exist as an asset yet; creating it is part of this effort, and it should double as the deck's section map.
- **Reuse, don't restart.** Reuse the styling of the showcase deck (`Martin Mena_Trend Tree_filled.pptx`, repo root) and its worked-example pattern — but with a **newer trend** than Plot-Driven PTO, and a structure built fresh for briefing length.
- **Execution is in-map.** The destination is the deck file itself, so the final build ticket produces the deliverable rather than a spec.
- **Skills.** Decision tickets run `/grilling` + `/domain-modeling`. The deck build and the tree visual consult `dataviz` and `artifact-design`. Standing preference: prose recommendations with reasoning, never multiple-choice option cards.
- **Vocabulary.** `CONTEXT.md` is binding — signal, source, publisher, trend topic vs. trend name, ATLAS vs. `DT_TREND_DASHBOARD`.

## Established facts

- The May showcase deck exists at the repo root: `Martin Mena_Trend Tree_filled.pptx` (5 slides, "AI Forward Award" template, Plot-Driven PTO example). The unfilled `Martin Mena_Trend Tree.pptx` variant carries stale claims — a GPT-4/Claude cross-model cascade and $0.45/trend — superseded by the single Gemini 3.1 Pro agent and the measured $0.15/run median. Verified 2026-09-19 by reading the slide XML.
- No tree image asset exists in the repo (searched 2026-09-19; `docs/images/` holds only `atlas-flow.mmd`/`.svg`).
- Median enrichment cost: $0.15/run across 167 runs, 30 days to 2026-08-20 (`CLAUDE.md`; only ~half the ledger rows carry a cost value — CRMA-442).

## Standing constraints

- The deck ships as **one self-contained HTML file in the repo**, plus a private Artifact link published from the same file for sharing.
- Built for live presentation, but every slide must explain itself — Martin expects the deck to be forwarded.
- Target length: ~12 content slides (title, use-case framing ×2, tree overview, how-it-works by layer ×3, worked example, current state + integrations ×2, future plans ×2, close) — the starting shape, refined by the outline ticket.

## Decisions so far

<!-- The index — one line per closed ticket. Enough to judge relevance, then open
     the link for the detail the ticket already holds. Never the reasoning,
     alternatives, or evidence.

     - [<closed ticket title>](link) — **Decided:** <the answer, one line>
       **Binds:** <what downstream work this constrains — or `nothing further`>

     `resolve` appends here. Do not hand-edit while a session is running. -->

## Not yet specified

- How the presenter narration is carried for forwarded readers — visible notes, a toggle, or per-slide captions. Depends on the outline and the build approach.
- Per-slide imagery beyond the tree visual — ATLAS screenshots, digest samples, dashboard numbers as charts. Depends on the outline.
- A review loop before the real audience — dry run, trusted-colleague pass — and the final distribution list.

## Out of scope

- Editing or refreshing the May showcase PPTX — it is a source of styling and narrative, not a deliverable.
- Building new pipeline features, dashboards, or docs to make the deck look better.
- Publishing the deck into Confluence — the ATLAS space carries stakeholder docs, not this briefing.
