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

- **The trend-origin tag is live.** `DT_TREND_DASHBOARD.TREND_ORIGIN` is `DISCOVERED` or
  `EDITORIAL`, read from the category on the trend's `PROMOTE_NEW` row: 700 `DISCOVERED`, 1
  `EDITORIAL`. A nomination that merges into a discovered trend leaves it `DISCOVERED`, and no
  dashboard column marks the merge.
  _Source: Snowflake and `sql/dt_trend_dashboard.sql:413,466`, CRMA-1720, 2026-11-10._
- **No real editorial nomination has run.** The only two runs are the CRMA-1660 smoke tests on
  2026-10-26 (one new trend, one merge into a live trend). Revision
  `trend-tree-editorial-ingest-00003-vax` serves 100% of traffic, still tagged `candidate`.
  _Source: Snowflake, Cloud Run logs, `gcloud`, CRMA-1720, 2026-11-10._
- **Three of four outcomes read back by `nomination_id` today.** New trend and merge: the
  `FCT_PROMOTION_LEDGER` row with `CANDIDATE_ID` = `nomination_id` gives `TARGET_TREND_ID`.
  Merge into a `RETIRED` trend also writes a `RESURGENT` lifecycle row with `CHAIN_ID` =
  `nomination_id` (never run live).
  _Source: CRMA-1720 findings, 2026-11-10._
- **Snowflake cannot tell a nomination that gave up from one that is still retrying.** The queue
  retries up to 100 times with a 3600 s max backoff and has no dead-letter queue. A task that
  gives up leaves nothing, or signals plus an unpromoted candidate, or a failed-attempt ledger
  row.
  _Source: `gcloud tasks queues describe`, code read, CRMA-1720, 2026-11-10._
- **An `editorial` signal row already carries its `nomination_id`** in `METADATA.nomination_id`
  (`STG_EXTERNAL_SIGNALS` and `FCT_SIGNALS`) and in `STG_EXTERNAL_SIGNALS.AGENT_SESSION_ID`. The
  exception: a URL already ingested keeps its first-seen `METADATA`. `FCT_TREND_SIGNALS` has no
  nomination column.
  _Source: CRMA-1720 findings, 2026-11-10._
- **ATLAS's role reads the presentation tables, not staging.** `TH_APIROLE` reads every
  `MCC_PRESENTATION.TREND_AGENT` table a readback joins, but not `STG_TREND_CANDIDATES` or
  `STG_EXTERNAL_SIGNALS`, so it cannot see a stuck candidate.
  _Source: `SHOW GRANTS TO ROLE TH_APIROLE`, CRMA-1720, 2026-11-10._
- **The verdict comes before any write, but it is not fast today.** The handler gets the
  new-or-merge verdict from a `gemini-3.7-flash` topic call, a Cortex embed and a
  `gemini-3.8-flash` sameness call, before it writes anything. The two smoke-test background runs
  took 30 s and 52 s in total. The logs do not split out the verdict steps. `POST /nominations`
  itself answers in under 1 s.
  _Source: `services/editorial-ingest/editorial_ingest/handler.py:41-45`, Cloud Run request logs
  for 2026-10-26, 2026-11-10._
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
- **ATLAS gets the verdict at once.** The person who nominates sees instant feedback on whether
  the nomination becomes a new trend or is added to an existing trend, and to which one. Minutes
  later is not enough. (Martin, 2026-11-10.)
- **ATLAS polls; Trend Tree sends no callback.** (Marcelo's own terms, accepted in charting,
  2026-11-10.) "Decide: how ATLAS reads an editorial nomination's outcome" must test this against
  the instant-verdict constraint: a verdict in the `POST /nominations` response itself would
  replace the poll for that verdict.
- **The workflow document waits for the verdict.** "Send Jason the editorial nomination workflow
  document" is blocked by the two verdict tickets. Its draft (Confluence page `2494693377`,
  unpublished) is rewritten from their answers before Martin sends it. (Martin, 2026-11-10.)
- **The tag-or-tab display is an ATLAS decision that Jason Smith and Marcelo Freitas own.** This
  map only confirms that `TREND_ORIGIN` supports both. (Charting session, 2026-11-10.)

## Decisions so far

<!-- The index — one line per closed ticket.

     - [<closed ticket title>](link) — **Decided:** <the answer, one line>

     `resolve` appends here. Do not hand-edit while a session is running. -->

- [Research: what the live editorial-ingest path records for each nomination outcome](https://mcclatchy.atlassian.net/browse/CRMA-1720) — **Decided:** 3 of 4 outcomes read back by nomination_id via FCT_PROMOTION_LEDGER; gave-up vs retrying is invisible; signals already carry METADATA.nomination_id; no real nomination has run

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
