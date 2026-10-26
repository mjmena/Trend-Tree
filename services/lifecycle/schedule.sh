#!/usr/bin/env bash
# The lifecycle job's hourly cron, as code.
#
#   services/lifecycle/schedule.sh             create-or-update the Scheduler job
#   services/lifecycle/schedule.sh --dry-run   print the gcloud call, change nothing
#   services/lifecycle/schedule.sh --fire      fire the cron once and show the execution it started
#
# A copy of services/tiktok-ingest/schedule.sh with the names, the schedule and
# the description changed; its header explains the OAuth target and the IAM.
#
# Run it only at the cut-over, after the Pipedream lifecycle workflows are
# deleted: the job and the Pipedream sweep must never both write the ledger.
set -euo pipefail

PROJECT="${PROJECT:-mcc-crm-automations}"
REGION="${REGION:-us-east4}"
TARGET_JOB="${TARGET_JOB:-trend-tree-lifecycle}"
CRON_JOB="${CRON_JOB:-trend-tree-lifecycle-hourly}"
INVOKER="${INVOKER:-crm-runtime@mcc-crm-automations.iam.gserviceaccount.com}"
GCLOUD="${GCLOUD:-gcloud}"

SCHEDULE="${SCHEDULE:-0 * * * *}"
TIME_ZONE="${TIME_ZONE:-UTC}"

URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${TARGET_JOB}:run"

MODE="apply"
case "${1:-}" in
  "") ;;
  --dry-run) MODE="dry-run" ;;
  --fire) MODE="fire" ;;
  *) echo "usage: $0 [--dry-run | --fire]" >&2; exit 2 ;;
esac

if [[ "$MODE" == "fire" ]]; then
  "$GCLOUD" scheduler jobs run "$CRON_JOB" --location "$REGION" --project "$PROJECT"
  echo "Fired ${CRON_JOB}. Newest executions of ${TARGET_JOB} (the new one can take a few seconds to appear):"
  sleep 10
  exec "$GCLOUD" run jobs executions list --job "$TARGET_JOB" --region "$REGION" --project "$PROJECT" --limit 3
fi

ARGS=(
  --location "$REGION" --project "$PROJECT"
  --schedule "$SCHEDULE" --time-zone "$TIME_ZONE"
  --uri "$URI" --http-method POST
  --oauth-service-account-email "$INVOKER"
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
  --attempt-deadline 60s
  --max-retry-attempts 2
  --description "Hourly lifecycle tick: collect the finished Gemini batch, submit the due trends. Starts Cloud Run job ${TARGET_JOB}."
)

if "$GCLOUD" scheduler jobs describe "$CRON_JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  VERB="update"
else
  VERB="create"
fi

if [[ "$MODE" == "dry-run" ]]; then
  printf '%q ' "$GCLOUD" scheduler jobs "$VERB" http "$CRON_JOB" "${ARGS[@]}"
  echo
  exit 0
fi

"$GCLOUD" scheduler jobs "$VERB" http "$CRON_JOB" "${ARGS[@]}"
