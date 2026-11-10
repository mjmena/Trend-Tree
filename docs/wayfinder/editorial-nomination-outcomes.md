<!-- map: CRMA-1719 -->

# Map: editorial nomination outcomes for ATLAS

## Destination

A **spec**, `docs/prd/editorial-nomination-outcomes.md`, that extends the editorial-trend-ingest
spec ([CRMA-1660](https://mcclatchy.atlassian.net/browse/CRMA-1660),
`docs/prd/editorial-trend-ingest-endpoint.md`). It covers three things: how ATLAS reads the
outcome of each editorial nomination, the `nomination_id` on the `editorial` signal rows, and how
ATLAS dev tests without writing production rows. The workflow document for Jason Smith ships
early, as a ticket on this map. The map stops before the build.

## Notes

- **Sources.** Marcelo Freitas, Slack DM 2026-11-04 and 2026-11-05 (outcome readback,
  `nomination_id` on signals, a dry run). Trend Hunter Tools Sync, 2026-11-05: Jason Smith asked
  for a workflow document and may want editorial trends in a separate tab instead of a tag.
- **Domain.** Read `CONTEXT.md` first. The terms are **editorial trend**, **editorial
  nomination** and **trend origin**. ATLAS and the meeting say "nominated trend"; `CONTEXT.md`
  lists that phrase under _Avoid_, so this map does not use it.
- **This map reopens a closed boundary.** The CRMA-1424 map and the CRMA-1660 spec ruled out a
  status route, a `nomination_id` → `TREND_ID` link and `dry_run`. Read that spec's
  **Out of Scope** before a decision here overturns it, and say so in the resolution.
- **Skills.** `/grilling` + `/domain-modeling` for decision tickets, `/research` for research
  tickets.
- **Put each decision as prose with a recommendation and its reasoning.** No multiple-choice
  cards.
- **Never commit this map to `production`.** A commit to the default branch is a Pipedream
  deploy.

## Established facts

<!-- Measured state of the world. Falsified by RE-MEASUREMENT, never by a decision.
     Every line carries its source and the date it was verified. -->

- **The trend-origin tag exists in code.** `DT_TREND_DASHBOARD.TREND_ORIGIN` is `DISCOVERED` or
  `EDITORIAL`, read from the category on the trend's `PROMOTE_NEW` row. A nomination that merges
  into a discovered trend leaves it `DISCOVERED`.
  _Source: `sql/dt_trend_dashboard.sql:413,466`, `docs/dashboard/data-contract.md:177`,
  2026-11-06. Not yet verified live._
- **The endpoint returns only `202 {nomination_id, dropped_urls}` on success.** No route reports
  what happened after the `202`.
  _Source: `docs/prd/editorial-trend-ingest-endpoint.md` (Response table), 2026-11-06._
- **`nomination_id` is the candidate's `CANDIDATE_ID` and the Cloud Tasks task name.** The
  nomination itself (`nominated_by`, brief) lands in `FCT_PROMOTION_LEDGER.NOMINATION`.
  _Source: same spec (Request table, Records), `sql/alter_fct_promotion_ledger_add_nomination.sql`,
  2026-11-06._
- **ATLAS builds on a mock and sends no real editorial nominations until this is settled.**
  _Source: Marcelo Freitas, Slack DM, 2026-11-05._

## Standing constraints

<!-- Settled decisions in binding present tense. Overturned only by ANOTHER DECISION. -->

- **One map covers both asks.** Marcelo's outcome readback and Jason's workflow question share
  the ATLAS ↔ editorial-ingest seam. (Charting session, 2026-11-10.)
- **ATLAS polls; Trend Tree sends no callback.** (Marcelo's own terms, accepted in charting,
  2026-11-10.)
- **The tag-or-tab display is an ATLAS decision that Jason Smith and Marcelo Freitas own.** This
  map only confirms that `TREND_ORIGIN` supports both. (Charting session, 2026-11-10.)

## Decisions so far

<!-- The index — one line per closed ticket.

     - [<closed ticket title>](link) — **Decided:** <the answer, one line>

     `resolve` appends here. Do not hand-edit while a session is running. -->

## Not yet specified

<!-- The fog of war. Graduates into tickets as the frontier advances. -->

- **What Jason's reply changes.** If he picks a separate tab, a merge into a discovered trend
  may need its own visibility. The workflow document's reply decides whether a ticket follows.
- **Operator visibility of failed nominations.** The CRMA-1660 spec counts editorial candidates
  with no ledger row after one hour in the audit agent. Whether the outcome readback replaces or
  feeds that count waits on the outcome states.
- **Docs to update.** `docs/dashboard/data-contract.md` and its ATLAS Confluence mirror, for any
  new column or view the readback decision adds.
- **Retention.** How long an outcome row stays readable, once the readback surface is chosen.

## Out of scope

<!-- Work ruled beyond the destination. Closed, never graduates. -->

- **The tag-or-tab display in ATLAS.** It is ATLAS UI (`insights-agent`), owned by Jason Smith
  and Marcelo Freitas; `TREND_ORIGIN` already supports both.
- **Notifications to the person who nominated.** ATLAS builds them on top of the readback.
- **The Harbor persona documentation** (the other action from the 2026-11-05 sync). It is a
  separate effort about Harbor and the CSA, not about editorial nominations.
