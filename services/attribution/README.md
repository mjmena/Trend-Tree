# trend-tree-attribution

Cloud Run job. Each hourly execution runs one tick (`tick.mjs`): collect the finished Gemini
batch into `FCT_TREND_SIGNALS` (`LINK_KIND = 'attributed'`), then submit the next
`ATTRIBUTION_BATCH_CAP` trends, least recently swept first, as the next batch. The design is
`docs/prd/attribution-job.md`.

## Model

The job submits batches and standard retries to `gemini-3.8-flash`, with medium thinking
and an 8192-token output limit. The prompt migration sets the same model in
`signal.attribution.job.system` v1. Apply it after the audit manifest has deployed.

The operator selected Flash on 2026-11-18, superseding CRMA-1691's Pro choice. The frozen
300-trend comparison (CRMA-1690) measured 91.8% precision, 60.0% recall against a 61.8% cutoff,
and no malformed answers. This is an accepted recall tradeoff, not a new passing evaluation.
The measured estimate was $2.11/day at 720 evaluations; live cost is recorded per batch in
`STG_AGENT_RUN_COSTS`, including thinking tokens and standard retries.

[Google's pricing](https://aistudio.google.com/docs/pricing#gemini-3.8-flash) doubles on
2027-01-01. Cost accounting applies that change automatically; at the same token usage the
estimate becomes $4.22/day. No batch from another model may remain in flight during a model
change: the collector prices entries using the deployed `JOB_MODEL`.

## Operate

- Deploy: `services/deploy.sh attribution --no-execute`. An execution writes links.
- Schedule: `services/attribution/schedule.sh` (`--dry-run` prints the call, `--fire` runs it
  once). Hourly at minute 30, UTC, Scheduler job `trend-tree-attribution-hourly`. Apply it only
  at the cut-over, after the Pipedream attribution workflows are deleted: the job and the
  Pipedream sweep must never both link signals.
- Alert policy, applied once by hand (`services/deploy.sh` does not apply policies):

  ```sh
  CHANNEL_NAME="<display name of the team's alert channel>"
  CHANNEL=$(gcloud beta monitoring channels list --project mcc-crm-automations \
    --filter="displayName=\"$CHANNEL_NAME\"" --format='value(name)')
  gcloud monitoring policies create --project mcc-crm-automations \
    --policy-from-file services/attribution/alert-policy.json --notification-channels "$CHANNEL"
  ```

- `STATUS = BUDGET_EXHAUSTED` on a cost row means the cap left out a trend not swept for 24 h.
  Until the first cycle after cut-over completes, every batch reports it. After that, raise
  `ATTRIBUTION_BATCH_CAP` with `gcloud run jobs update trend-tree-attribution --region us-east4
  --project mcc-crm-automations --update-env-vars ATTRIBUTION_BATCH_CAP=<n>`.

## When the alert fires

A failed execution means Snowflake, the batch submit or the batch poll broke; read the
execution's stderr (`gcloud run jobs executions list --job trend-tree-attribution --region
us-east4 --project mcc-crm-automations`, then its logs). No completed execution for 3 h means the
Scheduler job is paused or gone (`schedule.sh --dry-run` shows what it should be). A failed or
cancelled batch does not count as a sweep, so the next good tick takes its trends first: fix
forward, then check `STG_ATTRIBUTION_BATCHES` and the `STG_AGENT_RUN_COSTS` row (`STATUS`,
`ERROR_MESSAGE`) for the batch.
