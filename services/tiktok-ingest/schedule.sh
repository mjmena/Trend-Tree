#!/usr/bin/env bash
# The TikTok ingester's daily cron, as code (CRMA-1338).
#
#   services/tiktok-ingest/schedule.sh             create-or-update the Scheduler job
#   services/tiktok-ingest/schedule.sh --dry-run   print the gcloud call, change nothing
#   services/tiktok-ingest/schedule.sh --fire      fire the cron once and show the execution it started
#
# Idempotent: it describes the Scheduler job first, then runs `create` or
# `update`. Re-running this script is how the schedule is CHANGED.
#
# The target is the Cloud Run Admin API's `jobs/<name>:run`, not an HTTP route
# on the job — a job serves no HTTP. Scheduler therefore presents an OAuth
# ACCESS token (scope cloud-platform), not an OIDC ID token as the
# trend-tree-ecomm-poll and trend-tree-prediction-daily-sweep crons do. This
# is the same shape the project's harbor-* and audience-dashboard-nightly
# crons already use.
#
# Authorization needs no admin (verified 2026-09-28):
#   * the caller is crm-runtime@, which holds project-level roles/run.invoker,
#     and that role includes run.jobs.run;
#   * creating the Scheduler job needs cloudscheduler.jobs.create plus
#     iam.serviceAccounts.actAs on crm-runtime@ — both granted to the operator
#     (services/catalog-sync/schedule.sh created its job this way).
#
# This script is a copy of services/catalog-sync/schedule.sh with the job
# names, the hour and the description changed.
#
# Scheduler's retry covers only the START of a run: the `:run` call returns
# once the execution is created, so Scheduler never sees the ingest's result.
# A failed ingest is retried by the job itself (MAX_RETRIES in deploy.env), and
# reported by the audit agent's tiktok freshness row, which goes RED when no
# tiktok row has an EMBEDDED_AT in the last 25h
# (audit-agent-p_xMC9nm3/run_audit_agent/tiktok_freshness.mjs).
set -euo pipefail

PROJECT="${PROJECT:-mcc-crm-automations}"
REGION="${REGION:-us-east4}"
TARGET_JOB="${TARGET_JOB:-trend-tree-tiktok-ingest}"
CRON_JOB="${CRON_JOB:-trend-tree-tiktok-ingest-daily}"
INVOKER="${INVOKER:-crm-runtime@mcc-crm-automations.iam.gserviceaccount.com}"
GCLOUD="${GCLOUD:-gcloud}"

# 09:00 UTC daily. A run that times out (1h) and then retries still lands by
# 11:00, so a failed run is visible in the audit's 13:00 UTC report the same
# day. If you move this hour, check that WINDOW_HOURS in tiktok_freshness.mjs
# still fits.
SCHEDULE="${SCHEDULE:-0 9 * * *}"
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
  --description "Daily SerpApi TikTok ingest into STG_EXTERNAL_SIGNALS (CRMA-1338). Starts Cloud Run job ${TARGET_JOB}."
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
