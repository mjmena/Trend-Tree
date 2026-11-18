# Attribution: production release, 2026-11-18

Attribution runs as the Cloud Run job `trend-tree-attribution` on Gemini 3.8 Flash.
Cloud Scheduler runs one tick hourly at minute 30, UTC, with a 30-trend cap.
The Pipedream writers were stopped and drained before the first collection.

## Deployed configuration

| Component | Value |
| --- | --- |
| Implementation | [PR #174](https://github.com/mjmena/Trend-Tree/pull/174), merge `106c3d1647d01c26e1b53c85330ed002f480a12b` |
| Image | `us-east4-docker.pkg.dev/mcc-crm-automations/mcc/trend-tree-attribution:106c3d1` |
| Image digest | `sha256:f01b44308825dd06c3cc59d49521c2ab0c0ef4508a2217698f4afef008be2386` |
| Project / region | `mcc-crm-automations` / `us-east4` |
| Model | `gemini-3.8-flash`, medium thinking, 8192 output tokens |
| Prompt | `signal.attribution.job.system` v1, active; shared rubric v3 unchanged |
| Schedule | `trend-tree-attribution-hourly`, `30 * * * *`, UTC, enabled |
| Invoker | `crm-runtime@mcc-crm-automations.iam.gserviceaccount.com`, OAuth |
| Alert | `trend-tree-attribution: failed or silent`, policy `9914009757804511597`, enabled |
| Alert channel | Existing lifecycle channel `2368507138900698906` |

The audit prompt manifest was confirmed live before applying the committed prompt
migration. `STG_ATTRIBUTION_BATCHES` already existed. All 349 service-library tests
passed against the merged implementation, including Flash pricing at the 2027 boundary.
The job image used Google's mirror of `node:22-slim` after Docker Hub DNS failed.

Flash was the operator's explicit choice, superseding the earlier Pro decision. The
frozen comparison's 60.0% recall was below its 61.8% cutoff; this release accepts that
tradeoff and does not claim a new passing evaluation. See the [job runbook](../../services/attribution/README.md)
for measured precision, usage estimates and the 2027 price change.

## Production verification

The one-request read-only preflight returned valid Flash output using a real candidate
pool. The 10-trend batch `batches/sinmzxw9moc8atuwkax9fgepih4q9v509nqi` was submitted by
execution `trend-tree-attribution-vgrnv` and collected by `trend-tree-attribution-j46qc`.
All 10 entries succeeded with valid empty attribution arrays: no retries, dropped
entries or errors. Snowflake confirmed `STATE = 'COLLECTED'` and exactly one cost row
under `WORKFLOW_NAME = 'trend-tree-attribution'` and `MODEL = 'gemini-3.8-flash'`.
The row records 33,984 input, 100 output and 11,713 thinking tokens, costing $0.034894,
matching the per-entry Batch API calculation. No links were added by this sample.
`STATUS = 'BUDGET_EXHAUSTED'` reflects the initial unswept backlog.

The collector then submitted 30 trends, 29 with nonempty candidate pools, as batch
`batches/i0k06yo6w7zowhuioj2t9375necrs11bwsyx`. A direct Scheduler fire launched execution
`trend-tree-attribution-h8khs` as the runtime service account and completed successfully
at 17:55:47 UTC. The permanent cap remained 30 after the smoke-test override.

## Retirement sequence

At 17:44:28–30 UTC the cron source `dc_lVupvbe` was paused and workflows `p_KwCoaap`
and `p_PACe77B` were deactivated. The last subagent event was 17:38:36 UTC; its 600-second
timeout elapsed before collection at 17:54 UTC. This used pause, drain and verification
before removal in place of the spec's immediate deletion, preserving one writer.

CRMA-1740 removes both workflow directories, their audit error-registry entries, the
cron source code and the backfill script that called the retired endpoint. The old
`signal.attribution.system` prompt stays in the drift manifest because its Snowflake
row still exists. The job is operated through `services/attribution/README.md`.
