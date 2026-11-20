#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-mcc-crm-automations}"
REGION="${REGION:-us-east4}"
TARGET_JOB="${TARGET_JOB:-trend-tree-trend-hunter-ingest}"
INVOKER="${INVOKER:-crm-runtime@mcc-crm-automations.iam.gserviceaccount.com}"
GCLOUD="${GCLOUD:-gcloud}"
uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${TARGET_JOB}:run"
mode="${1:-apply}"
case "$mode" in
  apply|--dry-run|--pause|--resume) ;;
  *) echo "usage: $0 [--dry-run | --pause | --resume]" >&2; exit 2 ;;
esac

for cadence in hourly daily; do
  name="${TARGET_JOB}-${cadence}"
  location=(--location "$REGION" --project "$PROJECT")
  if [[ "$mode" == --pause || "$mode" == --resume ]]; then
    current=$("$GCLOUD" scheduler jobs describe "$name" "${location[@]}" --format='value(state)')
    if [[ "$mode" == --pause && "$current" == PAUSED || "$mode" == --resume && "$current" == ENABLED ]]; then
      continue
    fi
    "$GCLOUD" scheduler jobs "${mode#--}" "$name" "${location[@]}"
    continue
  fi
  cron='7 * * * *'
  body='{}'
  if [[ "$cadence" == daily ]]; then
    cron='17 0 * * *'
    body='{"overrides":{"containerOverrides":[{"env":[{"name":"TREND_HUNTER_ORIGIN","value":"reconcile"}]}]}}'
  fi
  args=("${location[@]}" --schedule "$cron" --time-zone UTC --uri "$uri" --http-method POST
        --oauth-service-account-email "$INVOKER" --oauth-token-scope https://www.googleapis.com/auth/cloud-platform
        --headers Content-Type=application/json --message-body "$body" --attempt-deadline 60s --max-retry-attempts 2)
  verb=create
  if [[ "$mode" == --dry-run ]]; then
    printf '%q ' "$GCLOUD" scheduler jobs "$verb" http "$name" "${args[@]}"
    echo
    continue
  fi
  if "$GCLOUD" scheduler jobs describe "$name" "${location[@]}" >/dev/null 2>&1; then
    verb=update
    # gcloud update owns the incremental header flag.
    args=("${args[@]/--headers/--update-headers}")
  fi
  "$GCLOUD" scheduler jobs "$verb" http "$name" "${args[@]}"
done
