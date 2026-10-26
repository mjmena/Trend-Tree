# trend-tree-lifecycle

Cloud Run job. Each hourly execution runs one tick (`tick.mjs`): collect the finished Gemini
batch into `FCT_TREND_LIFECYCLE_LEDGER`, then submit the due trends as the next batch. The
design is `docs/prd/lifecycle-job.md`.

## Operate

- Deploy: `services/deploy.sh lifecycle --no-execute`. An execution writes ledger rows.
- Schedule: `services/lifecycle/schedule.sh` (`--dry-run` prints the call, `--fire` runs it
  once). Hourly, UTC, Scheduler job `trend-tree-lifecycle-hourly`. Apply it only at the
  cut-over, after the Pipedream lifecycle workflows are deleted: the job and the Pipedream
  sweep must never both write the ledger.
- Alert policy, applied once by hand (`services/deploy.sh` does not apply policies):

  ```sh
  CHANNEL_NAME="<display name of the team's alert channel>"
  CHANNEL=$(gcloud beta monitoring channels list --project mcc-crm-automations \
    --filter="displayName=\"$CHANNEL_NAME\"" --format='value(name)')
  gcloud monitoring policies create --project mcc-crm-automations \
    --policy-from-file services/lifecycle/alert-policy.json --notification-channels "$CHANNEL"
  ```

## When the alert fires

A failed execution means Snowflake, the batch submit or the batch poll broke; read the
execution's stderr (`gcloud run jobs executions list --job trend-tree-lifecycle --region
us-east4 --project mcc-crm-automations`, then its logs). No completed execution for 3 h means the
Scheduler job is paused or gone (`schedule.sh --dry-run` shows what it should be). Every failure
leaves its trends due, so the next good tick picks them up: fix forward, then check
`STG_LIFECYCLE_BATCHES` and the `STG_AGENT_RUN_COSTS` row (`STATUS`, `ERROR_MESSAGE`) for the
batch.
