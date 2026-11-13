# trend-tree-attribution

Cloud Run job. Each hourly execution runs one tick (`tick.mjs`): collect the finished Gemini
batch into `FCT_TREND_SIGNALS` (`LINK_KIND = 'attributed'`), then submit the next
`ATTRIBUTION_BATCH_CAP` trends, least recently swept first, as the next batch. The design is
`docs/prd/attribution-job.md`.

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
