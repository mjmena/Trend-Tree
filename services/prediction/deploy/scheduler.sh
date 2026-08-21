#!/usr/bin/env bash
# The prediction pillar's daily cron, as code (CRMA-766 AC1/AC6).
#
#   deploy/scheduler.sh                 create-or-update the daily sweep job
#   deploy/scheduler.sh --dry-run       print the gcloud call, change nothing
#   deploy/scheduler.sh --describe      show the job as it exists today
#   deploy/scheduler.sh --pause / --resume
#
# Idempotent by construction: it describes the job first and then either
# `create` or `update`, so re-running it is how the cron is CHANGED, not a
# thing that fails because the job already exists. That is the point of
# shipping it as a script rather than as a command someone ran once -- the
# schedule, the payload and the OIDC identity are reviewable in a diff, and
# the job can be rebuilt from the repo if the project is ever recreated.
#
# ---------------------------------------------------------------------------
# How this is authorized, and why it needs no admin
# ---------------------------------------------------------------------------
#
# The service is deployed --no-allow-unauthenticated, so Cloud Run IAM rejects
# an uncredentialed caller at the edge. Cloud Scheduler authenticates as a
# service account and Google mints the OIDC ID token for it:
#
#   * the caller identity is $INVOKER (crm-runtime@), which ALREADY holds
#     roles/run.invoker on trend-tree-prediction. Verified read-only on
#     2026-08-21:
#       gcloud run services get-iam-policy trend-tree-prediction \
#         --region us-east4 --project mcc-crm-automations
#     -> one binding, roles/run.invoker, members crm-runtime@ and mmena@.
#     ensure_invoker_binding below re-adds it only if it is ever missing.
#   * creating the job needs cloudscheduler.jobs.create and, because the job
#     runs AS crm-runtime@, iam.serviceAccounts.actAs on that account. Both
#     were confirmed granted to the operator on 2026-08-21 via
#     projects:testIamPermissions and serviceAccounts:testIamPermissions.
#
# So there is no access request outstanding for this cron. If a future run of
# this script fails on either permission, the minimum ask is exactly one of:
#   roles/cloudscheduler.admin on projects/mcc-crm-automations   (create/update)
#   roles/iam.serviceAccountUser on crm-runtime@                 (actAs)
# -- nothing wider; the job needs no project-level Run or IAM admin.
#
# ---------------------------------------------------------------------------
# Three things that cost real time when this was first proven out
# ---------------------------------------------------------------------------
#
# 1. THE OIDC AUDIENCE IS THE BASE SERVICE URL, ALWAYS -- including when the
#    --uri points at a revision tag (https://candidate---SERVICE-HASH...).
#    The container verifies `aud` against PREDICTION_SERVICE_AUDIENCE, which
#    deploy.sh sets to the base URL. Point the audience at a tag URL and the
#    call comes back 401 with "The access token could not be verified" in the
#    container log, with nothing wrong anywhere else.
#
# 2. `gcloud scheduler jobs run` PRINTS NOTHING USEFUL and leaves
#    status.code: -1 whatever happened. Do not read it as a result. Read the
#    Cloud Run request log instead -- see verify_last_run below, which filters
#    on the scheduler's own user agent.
#
# 3. --schedule IS VALIDATED AT CREATION. An impossible date (`0 0 31 2 *`)
#    is rejected outright, so "create it paused with a date that never fires"
#    is not a way to stage this. Use --pause.
#
# ---------------------------------------------------------------------------
# A local operator cannot smoke-test this path by hand
# ---------------------------------------------------------------------------
#
# `gcloud auth print-identity-token --audiences=...` fails for a USER account
# ("Invalid account type for --audiences") -- audience-scoped ID tokens are a
# service-account capability. So the way to prove the cron works is to fire
# the job and read the Cloud Run log, which is what --verify does. deploy.sh's
# own authenticated probe has the same limitation and the same workaround
# ($PROBE_ID_TOKEN).
set -euo pipefail

PROJECT="${PROJECT:-mcc-crm-automations}"
REGION="${REGION:-us-east4}"
SERVICE="${SERVICE:-trend-tree-prediction}"
JOB="${JOB:-trend-tree-prediction-daily-sweep}"
INVOKER="${INVOKER:-crm-runtime@mcc-crm-automations.iam.gserviceaccount.com}"
GCLOUD="${GCLOUD:-gcloud}"

# 14:00 UTC daily. Deliberately the same hour the retiring deterministic
# scorer ran (dc_wDuPeGB, "Daily 14:00 UTC cron"), so the pillar's daily
# rhythm does not move under the Insights Agent when the scorer is retired at
# cutover (CRMA-770). It also sits after the ingestion tier's overnight runs,
# so the corpus the generation pass reads is a full day old, not a partial one.
SCHEDULE="${SCHEDULE:-0 14 * * *}"
TIME_ZONE="${TIME_ZONE:-UTC}"

# The sweep's own retry budget. Cloud Scheduler retries a non-2xx, and the
# sweep is idempotent per chain_id -- but the scheduled body deliberately
# does NOT pin a chain_id: a retry that lands after a partial write should
# append the rows the first attempt did not, and MERGE semantics make a
# repeat of the ones it did harmless only when the id matches. Rather than
# hand-roll a per-day id in a cron payload (Cloud Scheduler has no template
# variables), the run is left to mint one, and the retry count is kept low so
# a genuinely broken run fails into ledger staleness -- which is the failure
# surface the PRD asks for -- rather than hammering the warehouse.
MAX_RETRY_ATTEMPTS="${MAX_RETRY_ATTEMPTS:-2}"
# The service is deployed with --timeout 600; the sweep's own budget has to
# sit inside that or the scheduler gives up on a run that is still working.
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-590s}"

# The daily body: the full run. No caps beyond the defaults -- a capped-scope
# fire is a manual thing (see --dry-run's printed curl equivalent), and a cron
# that quietly re-evaluated only part of the pool would leave the rest
# silently un-swept.
# Written to a variable first: inside ${BODY:-...} a literal '}' has to be
# backslash-escaped, and the backslash survives into the value -- which ships
# a cron whose POST body is invalid JSON. Caught by tests/test_scheduler.py.
DEFAULT_BODY='{"prediction_limit": 50, "max_predictions": 5}'
BODY="${BODY:-$DEFAULT_BODY}"

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

usage() {
  cat >&2 <<USAGE
usage: deploy/scheduler.sh [--dry-run|--describe|--pause|--resume|--verify]

  (no flag)    create the job if it does not exist, update it if it does
  --dry-run    print what would be done; change nothing
  --describe   print the job as it exists today
  --pause      stop the cron without deleting it
  --resume     start it again
  --verify     fire the job once and read the Cloud Run request log for the
               real result (see note 2 in this script's header)
USAGE
  exit 1
}

ACTION=apply
for arg in "$@"; do
  case "$arg" in
    --dry-run) ACTION=dry-run ;;
    --describe) ACTION=describe ;;
    --pause) ACTION=pause ;;
    --resume) ACTION=resume ;;
    --verify) ACTION=verify ;;
    -h|--help) usage ;;
    *) echo "unknown flag: $arg" >&2; usage ;;
  esac
done

# service_url -- the BASE URL, which is both the POST target and, separately,
# the OIDC audience. Aborts rather than guessing: a scheduler job pointed at
# an empty URL is a job that 404s once a day, quietly.
service_url() {
  local url
  url="$("$GCLOUD" run services describe "$SERVICE" \
    --region "$REGION" --project "$PROJECT" --format 'value(status.url)')" || return 1
  [[ -n "$url" ]] || return 1
  printf '%s' "$url"
}

# job_exists -- true when the job is already there. `describe` is the only
# read that answers this; `list | grep` would match a job whose name merely
# contains this one's.
job_exists() {
  "$GCLOUD" scheduler jobs describe "$JOB" \
    --location "$REGION" --project "$PROJECT" >/dev/null 2>&1
}

# ensure_invoker_binding -- add roles/run.invoker for $INVOKER if it is
# missing. Already granted as of 2026-08-21, so this is normally a no-op read;
# it exists so the cron can be rebuilt from this script alone.
ensure_invoker_binding() {
  local policy
  policy="$("$GCLOUD" run services get-iam-policy "$SERVICE" \
    --region "$REGION" --project "$PROJECT" --format json 2>/dev/null || echo '{}')"
  if printf '%s' "$policy" | grep -q "serviceAccount:${INVOKER}"; then
    log "roles/run.invoker: ${INVOKER} already bound on ${SERVICE} (no change)."
    return 0
  fi
  log "Granting roles/run.invoker to ${INVOKER} on ${SERVICE}..."
  "$GCLOUD" run services add-iam-policy-binding "$SERVICE" \
    --region "$REGION" --project "$PROJECT" \
    --member "serviceAccount:${INVOKER}" \
    --role roles/run.invoker
}

# build_job_args URL -- fills $ARGS with every flag that defines the job,
# shared by create and update so the two can never drift.
# --oidc-token-audience is the BASE url, see note 1 in the header.
#
# An array set by a function rather than a here-list piped through `mapfile`:
# macOS ships bash 3.2, where `mapfile` does not exist, and this script has to
# run from a dev Mac (deploy.sh already assumes as much -- crane, not Docker).
ARGS=()
build_job_args() {
  local url="$1"
  ARGS=(
    "--location=${REGION}"
    "--project=${PROJECT}"
    "--schedule=${SCHEDULE}"
    "--time-zone=${TIME_ZONE}"
    "--uri=${url}/sweep"
    "--http-method=POST"
    "--headers=Content-Type=application/json"
    "--message-body=${BODY}"
    "--oidc-service-account-email=${INVOKER}"
    "--oidc-token-audience=${url}"
    "--max-retry-attempts=${MAX_RETRY_ATTEMPTS}"
    "--attempt-deadline=${ATTEMPT_DEADLINE}"
    "--description=Daily re-evaluation sweep + generation pass for the Trend Tree prediction pillar (CRMA-766). Managed by services/prediction/deploy/scheduler.sh -- edit there, not in the console."
  )
}

case "$ACTION" in
  describe)
    exec "$GCLOUD" scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT"
    ;;
  pause)
    exec "$GCLOUD" scheduler jobs pause "$JOB" --location "$REGION" --project "$PROJECT"
    ;;
  resume)
    exec "$GCLOUD" scheduler jobs resume "$JOB" --location "$REGION" --project "$PROJECT"
    ;;
esac

URL="$(service_url)" || {
  echo "Aborting: could not read ${SERVICE}'s URL in ${PROJECT}/${REGION}. Deploy the service first (deploy/deploy.sh); a scheduler job pointed at an empty URL 404s once a day, silently." >&2
  exit 1
}

if [[ "$ACTION" == "verify" ]]; then
  # `jobs run` reports nothing useful (header note 2) -- fire it, then read
  # the Cloud Run request log filtered on the scheduler's own user agent.
  log "Firing ${JOB} once (its printed status is meaningless -- see below)..."
  "$GCLOUD" scheduler jobs run "$JOB" --location "$REGION" --project "$PROJECT" || true
  log "The real result, from the Cloud Run request log:"
  exec "$GCLOUD" logging read \
    "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE} AND httpRequest.userAgent:\"Google-Cloud-Scheduler\"" \
    --project "$PROJECT" --limit 5 --freshness 15m \
    --format 'table(timestamp, httpRequest.status, httpRequest.requestUrl, httpRequest.latency)'
fi

build_job_args "$URL"

if [[ "$ACTION" == "dry-run" ]]; then
  if job_exists; then verb=update; else verb=create; fi
  log "Would run (job ${JOB} ${verb}):"
  printf '  %s scheduler jobs %s http %s \\\n' "$GCLOUD" "$verb" "$JOB"
  printf '    %q \\\n' "${ARGS[@]}"
  printf '\n'
  log "The same call by hand, for a one-off capped-scope fire:"
  printf '  curl -sS -X POST %s/sweep -H "Content-Type: application/json" \\\n' "$URL"
  printf '    -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=%s)" \\\n' "$URL"
  printf '    -d %s\n' "'{\"prediction_ids\": [\"<uuid>\"], \"skip_generation\": true}'"
  printf '  # NOTE: that token mint fails for a USER account -- see this script'"'"'s header.\n'
  exit 0
fi

ensure_invoker_binding

if job_exists; then
  log "Updating ${JOB} (schedule '${SCHEDULE}' ${TIME_ZONE}, POST ${URL}/sweep as ${INVOKER})..."
  "$GCLOUD" scheduler jobs update http "$JOB" "${ARGS[@]}"
else
  log "Creating ${JOB} (schedule '${SCHEDULE}' ${TIME_ZONE}, POST ${URL}/sweep as ${INVOKER})..."
  "$GCLOUD" scheduler jobs create http "$JOB" "${ARGS[@]}"
fi

log "Done. Verify an actual run with:  deploy/scheduler.sh --verify"
