#!/usr/bin/env bash
# services/deploy.sh <name> — build, dark-deploy, smoke-test and promote one
# Cloud Run service from services/<name>/ (CRMA-440's decided pattern,
# bootstrapped here by CRMA-776 for trend-tree-ecomm-agent).
#
# The flow, in order:
#   1. Refuse to build from a dirty tree. The image is tagged with the git SHA,
#      so a build from uncommitted work produces a tag that names code nobody
#      can check out — the tag would be a lie, and a rollback to it impossible.
#   2. Build linux/amd64 (Cloud Run's architecture; a dev Mac is arm64) with
#      the REPO ROOT as build context, per CRMA-439 — every service imports
#      services/lib/, which sits outside its own directory.
#   3. Push to the existing `mcc` Artifact Registry repo in mcc-crm-automations
#      / us-east4 (CRMA-437).
#   4. Dark deploy: `--no-traffic --tag candidate`. The new revision is
#      reachable at its own tagged URL and serves none of the live traffic.
#   5. Smoke-test the candidate at that tagged URL. A failure exits non-zero
#      and leaves the previously-promoted revision serving, untouched.
#   6. Promote by moving the traffic pointer to the candidate revision.
#      ROLLBACK IS THE SAME COMMAND aimed at the previous revision:
#        gcloud run services update-traffic <service> \
#          --region <region> --project <project> --to-revisions <prior>=100
#      The script prints the exact rollback line before it promotes.
#
# Ingress is `--no-allow-unauthenticated` per CRMA-441: callers (the CRMA-778
# Cloud Scheduler poller, and a human curl) present a Google OIDC token and
# Cloud Run validates it against a run.invoker binding. The ecomm agent needs
# its OWN caller identity — it is not a beneficiary of the existing
# trend-tree-pipedream-caller@ SA, which exists only for Pipedream-originated
# calls. That binding is a one-time admin ask, tracked on CRMA-776.
#
# Known sibling divergence, flagged rather than silently resolved: the paused
# CRMA-762 work (branch crma-762-service-impl) reaches the same destination by
# a different route — a daemon-free `crane` build, because there is no Docker
# daemon on a dev Mac and cloudbuild.builds.create is denied in this project,
# and Cloud Run's native `--iap` instead of bare OIDC, after bare OIDC produced
# an unexplained edge-level 404 there. This script implements CRMA-440's
# decided pattern as written. If the build step is the blocker on a given
# machine, port CRMA-762's crane staging into step 2 — the Dockerfile stays
# the source of truth for image contents either way.
#
# Usage:
#   services/deploy.sh ecomm-agent                 full flow
#   services/deploy.sh ecomm-agent --no-build      redeploy the SHA's existing image
#   services/deploy.sh ecomm-agent --no-promote    stop after the smoke test
set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" || "$NAME" == -* ]]; then
  echo "usage: services/deploy.sh <name> [--no-build] [--no-promote]" >&2
  exit 2
fi
shift

BUILD=1
PROMOTE=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-promote) PROMOTE=0 ;;
    *) echo "unknown flag: $arg (expected --no-build / --no-promote)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC_DIR="$REPO_ROOT/services/$NAME"
ENV_FILE_SRC="$SVC_DIR/deploy.env"

[[ -d "$SVC_DIR" ]] || { echo "no such service: services/$NAME" >&2; exit 2; }
[[ -f "$ENV_FILE_SRC" ]] || { echo "missing services/$NAME/deploy.env" >&2; exit 2; }
[[ -f "$SVC_DIR/Dockerfile" ]] || { echo "missing services/$NAME/Dockerfile" >&2; exit 2; }

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

# shellcheck disable=SC1090
source "$ENV_FILE_SRC"

for v in SERVICE PROJECT REGION REPO SERVICE_ACCOUNT TIMEOUT PORT HEALTH_PATH; do
  [[ -n "${!v:-}" ]] || { echo "services/$NAME/deploy.env is missing $v" >&2; exit 2; }
done

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Clean tree — the SHA tag must name code that exists.
# ---------------------------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing to deploy from a dirty tree — the image tag is the git SHA, so an" >&2
  echo "image built from uncommitted work would be untraceable and un-rollback-able." >&2
  echo "Commit (or stash) first:" >&2
  git status --short >&2
  exit 1
fi

GIT_SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:${GIT_SHA}"

# ---------------------------------------------------------------------------
# 2/3. Build linux/amd64 from the repo root, push to Artifact Registry.
# ---------------------------------------------------------------------------
if [[ "$BUILD" == "1" ]]; then
  log "Building ${IMAGE} (linux/amd64, context = repo root)..."
  docker build --platform linux/amd64 -f "services/$NAME/Dockerfile" -t "$IMAGE" .

  log "Pushing ${IMAGE}..."
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet --project "$PROJECT"
  docker push "$IMAGE"
fi

# ---------------------------------------------------------------------------
# 4. Dark deploy.
# ---------------------------------------------------------------------------
ENV_FILE="$(mktemp -t "${SERVICE}-env.XXXXXX.yaml")"
trap 'rm -f "$ENV_FILE"' EXIT
printf '%s\n' "${ENV_VARS:-}" > "$ENV_FILE"

deploy_step() {
  local traffic_flag="$1"  # "--no-traffic", or "" on a first-ever create
  # An `[[ ... ]] && arr=(...)` one-liner would return 1 when SECRETS is empty
  # and `set -e` would abort the whole deploy on it. Use a real if.
  local secrets_flag=()
  if [[ -n "${SECRETS:-}" ]]; then
    secrets_flag=(--set-secrets "$SECRETS")
  fi
  # shellcheck disable=SC2086 -- traffic_flag is either empty or one flag token
  gcloud run deploy "$SERVICE" \
    --project "$PROJECT" --region "$REGION" \
    --image "$IMAGE" \
    --service-account "$SERVICE_ACCOUNT" \
    --cpu "${CPU:-1}" --memory "${MEMORY:-512Mi}" \
    --min-instances "${MIN_INSTANCES:-0}" --max-instances "${MAX_INSTANCES:-5}" \
    --concurrency "${CONCURRENCY:-10}" \
    --timeout "$TIMEOUT" --port "$PORT" \
    --no-allow-unauthenticated \
    $traffic_flag --tag candidate \
    ${secrets_flag[@]+"${secrets_flag[@]}"} \
    --env-vars-file "$ENV_FILE"
}

SERVICE_EXISTS="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format 'value(metadata.name)' 2>/dev/null || true)"

# Whichever revision is serving 100% right now — captured BEFORE the dark
# deploy, and read from the flattened traffic list rather than traffic[0],
# because a previous run's `candidate` tag also occupies a traffic entry (at
# 0%) and can sort first.
PRIOR_REVISION=""
if [[ -n "$SERVICE_EXISTS" ]]; then
  PRIOR_REVISION="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
    --flatten 'status.traffic[]' --format 'value(status.traffic.revisionName,status.traffic.percent)' 2>/dev/null \
    | awk '$2 == 100 { print $1; exit }')"
fi

if [[ -z "$SERVICE_EXISTS" ]]; then
  # gcloud rejects --no-traffic when creating a service (there is no prior
  # revision to protect). The bootstrap revision serves 100% immediately; every
  # deploy after this one takes the normal dark-deploy path.
  log "Service does not exist yet — creating a bootstrap revision (no --no-traffic on first create)."
  deploy_step ""
fi

log "Dark-deploying candidate (--no-traffic --tag candidate)..."
deploy_step "--no-traffic"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format 'value(status.url)')"
CANDIDATE_URL="https://candidate---${URL#https://}"
CANDIDATE_REVISION="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format 'value(status.latestCreatedRevisionName)')"

# ---------------------------------------------------------------------------
# 5. Smoke test — authenticated, because ingress is not public.
# ---------------------------------------------------------------------------
log "Smoke-testing ${CANDIDATE_URL}${HEALTH_PATH} (authenticated)..."
# `|| true`: a connection-level curl failure must reach the friendly failure
# branch below (as HTTP_CODE=000), not abort the script via `set -e` with a
# bare curl exit code and no explanation of what stays serving.
HTTP_CODE=$(curl -sS -o /tmp/"${SERVICE}"-smoke.json -w '%{http_code}' \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${CANDIDATE_URL}${HEALTH_PATH}" || true)
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Smoke test FAILED: expected 200 from ${HEALTH_PATH}, got HTTP ${HTTP_CODE}." >&2
  echo "Candidate ${CANDIDATE_REVISION} stays at 0% traffic; ${PRIOR_REVISION:-the current revision} keeps serving. Response:" >&2
  cat /tmp/"${SERVICE}"-smoke.json >&2
  exit 1
fi
log "Smoke test passed."

# ---------------------------------------------------------------------------
# 6. Promote (and print the rollback command first).
# ---------------------------------------------------------------------------
if [[ -n "$PRIOR_REVISION" && "$PRIOR_REVISION" != "$CANDIDATE_REVISION" ]]; then
  log "Rollback command for this promote (same command, prior revision):"
  echo "  gcloud run services update-traffic $SERVICE --project $PROJECT --region $REGION --to-revisions ${PRIOR_REVISION}=100"
fi

if [[ "$PROMOTE" == "1" ]]; then
  log "Promoting ${CANDIDATE_REVISION} to 100% traffic..."
  gcloud run services update-traffic "$SERVICE" \
    --project "$PROJECT" --region "$REGION" \
    --to-revisions "${CANDIDATE_REVISION}=100"
  log "Deployed: ${URL}"
else
  log "Skipping promote (--no-promote); candidate is live at ${CANDIDATE_URL}, serving 0% of traffic."
fi
