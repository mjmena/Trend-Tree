# Access request — read on Insights Postgres `prediction_decisions`

**Status:** not sent. Written by CRMA-768 for a human to send.
**Send to:** Marcelo (Insights Agent backend owner) — the `prediction_decisions`
table and its endpoints are on his side (see `prediction-scoring-handoff-martin.md`).
**Blocks:** the strategist tier of the prediction pillar (CRMA-768). The code path
is built and tested against a stubbed reader; it stays inert until this grant lands.

## What is being asked for

`SELECT` on one table — the Insights Agent's Postgres `prediction_decisions` —
for one service account, the Cloud Run service `trend-tree-prediction`
(`crm-runtime@mcc-crm-automations.iam.gserviceaccount.com`).

That is the whole ask. Not `SELECT` on the schema, not a read-only role over
the database, no write of any kind, and no second table "while we're in there".

## Why

The prediction pillar's strategy makes the human tier outrank automation:

> Precedence: **strategist action > coverage demotion > automated evidence.**
> Dismiss → the agent records a `WITHDRAWN` verdict. Approve → protection from
> automated demotion until the next human touch, plus queue standing.
> (`docs/prediction-pillar-strategy.md` §7.4)

A strategist's Approve/Dismiss is recorded in the Predictions Queue and stored in
`prediction_decisions`. Without read access, the prediction service cannot see
those actions, so:

- a call a strategist has **dismissed** keeps being re-evaluated and keeps
  appearing in the queue — the one outcome the Dismiss button exists to prevent;
- a call a strategist has **approved** can be demoted by internal coverage or by
  automated evidence, which is the machine overruling a human;
- the decisions are not retained as the calibration label tier the strategy asks
  for, so a later confidence-calibration pass has no human judgement to fit
  against (PRD user story 29).

## Which columns are needed

Whatever the table already carries for these; no new columns are being requested:

| Need | Purpose |
|---|---|
| the prediction identifier | the **only** key a decision is bound by — a decision applied to the wrong prediction withdraws a call the strategist never saw |
| the action (`approve` / `dismiss`) | the label itself |
| when the decision was taken | what makes "protected until the next human touch" enforceable — the latest decision wins, so nothing has to be stored as a protection flag |
| who took it (if recorded) | shown in `WHAT_CHANGED` so a withdrawal names the human rather than reading as an automated drop |
| the score/flag shown at decision time | already stored per the handoff doc; it is the label's context for the later regression |

## Access shape

- **Grant:** `SELECT` on `prediction_decisions` only.
- **To:** `crm-runtime@mcc-crm-automations.iam.gserviceaccount.com` (the Cloud Run
  service identity). A dedicated read-only Postgres user is equally fine — whichever
  is less work on the Insights side.
- **Connection details** (host, database, port, and how the credential should be
  presented) to come from the Insights side; the service reads its secrets from
  Secret Manager in `mcc-crm-automations`, so a password can be handed over as a
  secret rather than in a message.
- **Frequency:** one query per daily sweep, filtered to the predictions that are
  live at that moment. Not a stream, not a sync.

## What is already built, and what it does without this

`services/prediction/prediction_service/strategist/` ships the read seam:

- `StrategistDecisionReader` — the Protocol the sweep depends on;
- `StaticStrategistDecisionReader` — the offline flavour tests and
  `local_sweep.py --decisions` run against;
- `UnavailableDecisionReader` — what the deployed service uses **today**. It reads
  nothing and records on every verdict that the source could not be reached, so
  "we could not ask" never silently reads as "nobody has acted".

When the grant lands, the work left is one adapter behind that Protocol and one
argument in `prediction_service/server.py`. The precedence ladder, the `WITHDRAWN`
path, the calibration-label table and the isolation guarantees are already in place
and under test.

## What the data is used for, and what it is not used for

Retained in `MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_STRATEGIST_LABELS` as a
calibration label tier: recorded now, regression-tuned against later, **never
live-trained on**. No runtime code path reads a label back or adjusts a confidence
from one — that is enforced structurally, not by convention
(`strategist/labels.py`, `tests/test_strategist_isolation.py`).

Nothing is ever written back to `prediction_decisions`.
