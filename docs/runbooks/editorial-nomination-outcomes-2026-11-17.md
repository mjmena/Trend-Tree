# Editorial nomination outcomes: production release, 2026-11-17

The outcome/readback API, durable worker recovery, secure URL provenance view,
and no-write preview are deployed. The service is public again, its original
invoker policy is restored, and the editorial queue is running.

## Released versions

| Component | Deployed value |
| --- | --- |
| Implementation | [PR #178](https://github.com/mjmena/Trend-Tree/pull/178), merge `018d3b72f9a5dee5d9a4f51bf4321235115887e6` |
| Grant-preserving release fix | [PR #179](https://github.com/mjmena/Trend-Tree/pull/179), merge `f7057e96232d7d702ba749718a93d34ce38179d9` |
| Cloud Run revision | `trend-tree-editorial-ingest-00005-vum`, 100% traffic |
| Image | `us-east4-docker.pkg.dev/mcc-crm-automations/mcc/trend-tree-editorial-ingest:f7057e9` |
| Image digest | `sha256:a4e747a72cfbc7c6ea41cff359b2135b9c289609aaac269d5918f82e569dd358` |
| Service URL | `https://trend-tree-editorial-ingest-tu6gxkvema-uk.a.run.app` |
| Prior revision | `trend-tree-editorial-ingest-00003-vax` |

The candidate was built at zero traffic before maintenance. Public invocation
was then temporarily blocked and the queue paused. The queue was empty, the old
revision had no nomination activity, and no runtime Snowflake query was active
before migration. Traffic moved to the candidate before queue delivery resumed;
public access was restored after its original queued tasks replayed successfully.

Applied, in order: `sql/stg_editorial_nominations.sql`,
`sql/proc_promotion_apply.sql`, and `sql/v_editorial_nomination_signals.sql`.
The deployed Python procedure bodies exactly matched the merged files. The
singleton mutex has one valid row. `COPY GRANTS` retained the existing
`BUSINESS_ENGINEER_ROLE` procedure usage grant; an isolated native replacement
probe verified this before the production replacement, then was removed.

The secure view has its five documented columns, including `ACCEPTED_AT` as
`TIMESTAMP_LTZ`. Its owner is `MARKETING_ENGINEER`; `TH_APIROLE` has `SELECT`.
Direct grants and inherited roles were checked: ATLAS does not inherit access
to the private receipt. The operator could not log in as `TH_APIROLE`, so a
query through the actual ATLAS client remains an integration check.

## Live verification

| Check | Observed result |
| --- | --- |
| Missing/wrong API key | `401` before nomination processing |
| Malformed body / all URLs dropped | `400` / `422` |
| Unknown nomination | `404` |
| Preview-only key on production submit and existing receipt | `401` |
| Preview using preview and production credentials | `200`, provisional `would_merge`, expected existing trend; 11.8s and 10.1s |
| Preview isolation | Zero receipts, tasks, candidates, promotion rows, revival rows, provenance rows or new signals for the preview ID |
| Paused-queue submission | `202 pending` in 60.206s, `Retry-After: 5`, status URL |
| Pending readback | `200 pending` in 0.276s |
| First-content replay after commit | `200 merged` in 0.217s; original request and acceptance timestamp unchanged |
| Concurrent candidate evaluation | Initial `202` in 60.232s; `merged` observed at 85.298s total |
| Normal public submission through the resumed queue | Initial `202` in 60.149s; `merged` observed at 96.852s total |
| Original-task replay after cutover | Both handlers returned `200` in about 0.1s; no duplicate writes |

The one-minute limit bounds the initial response, **not evaluation completion**.
The three real workers took approximately 55.2s, 64.7s and 74.4s; acceptance and
queue handoff add time. ATLAS must poll after `202`. These measurements do not
establish an evaluation SLA or load/concurrency capacity.

All smoke nominations used an existing public Popular Mechanics article about
portable backup power stations. They merged into existing trend
`e82acac4-c682-439a-8223-bd5f28c527c2` (Portable Home Backup Batteries):

- `crma1719-release-20261117-merge-a`
- `crma1719-release-20261117-merge-b`
- `crma1719-release-20261117-merge-c`

Each has one receipt, one candidate and one promotion record. No new trend was
created. The shared URL has three distinct nomination associations, retains its
original discovery source and metadata, and still has one trend-evidence link.
The target remains `DISCOVERED`. Preview ID
`crma1719-release-20261117-preview-a` has no stored nomination or domain writes.
These real verification receipts remain as release evidence.

Local verification before deployment: 74 service tests passed; the final
authentication refactor passed all 46 affected route tests. Ruff and diff checks
passed. Native isolated fixtures covered concurrent acceptance/claims, signal
merge/promotion/revival, expired-owner fencing, recovery without an audit row,
late-failure preservation, and provenance cardinality. New-trend creation,
revival, exhausted retries and failure injection were not repeated against live
production data during this release.

## Permissions and remaining handoffs

The distinct `atlas-trend-tree-preview-api-key` secret exists in
`mcc-crm-automations`; the runtime has secret access. The runtime also has
`roles/cloudtasks.viewer` on the editorial queue for status reconciliation.
Temporary operator enqueue/run and service invocation grants were removed.
The service invoker policy matches its pre-release policy. Build staging and its
temporary registry token were removed. No credential value is recorded here.

ATLAS dev installation remains with an authorized ATLAS operator: this account
cannot manage `insights-agent-dev-504817`. That access is unnecessary to deploy
Trend Tree. The operator should copy the preview secret through Secret Manager,
grant the ATLAS dev runtime access to its local copy, and configure dev to call
`POST /nominations/preview` with that key. Do not copy the production credential
into the dev preview setup. The key is accepted only on the preview route; ATLAS
prod retains its existing production credential for submit/readback. Verify the
dev caller's preview result and `401` on production submit/readback after setup.

The [workflow document](../dashboard/editorial-nomination-workflow.md) remains
ready for Martin to send to Jason Smith. [CRMA-1721](https://mcclatchy.atlassian.net/browse/CRMA-1721)
stays open until delivery and Jason's response are recorded. No email or other
message to Jason was sent during this rollout. ATLAS owns its form/result display;
this release does not deploy an ATLAS frontend change.

For a future release or coordinated repair, use the
[release runbook](editorial-nomination-outcomes-release.md). Reverting traffic to
the old worker alone is insufficient once durable receipts have been accepted.
