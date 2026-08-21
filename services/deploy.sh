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
# Cloud Run validates it against a run.invoker binding.
#
# That binding is SELF-SERVICE, not an admin ask — an earlier version of this
# comment said otherwise and was wrong. CRMA-441's admin ask was for a new
# service account plus a key, and iam.serviceAccounts.create is indeed denied.
# The ecomm agent needs neither: nothing calls it from Pipedream, so the caller
# is simply crm-runtime@, and run.services.setIamPolicy is granted to
# crm@mcclatchy.com. Bind it yourself:
#
#   gcloud run services add-iam-policy-binding <service> --region <region> \
#     --member=serviceAccount:crm-runtime@mcc-crm-automations.iam.gserviceaccount.com \
#     --role=roles/run.invoker
#
# Do NOT reach for `--iap` to work around a 404. CRMA-762 did, and `--iap` sets
# run.googleapis.com/invoker-iam-disabled: true; with IAP not actually
# provisioned, nothing authorizes the request and the GFE emits a generic 404.
# The fix there is `--invoker-iam-check`, not more IAP. Read the response
# headers to tell the two apart: a real Cloud Run rejection carries
# `server: Google Frontend`, the edge's own error page carries no `server:`
# header at all.
#
# Sibling alignment: the build step below is now the same daemon-free `crane`
# build CRMA-762 and the wider estate (prism, helm, mcc-audience-builder) use.
# The remaining difference from CRMA-762 is auth mode — this service uses bare
# OIDC, which is CRMA-441's decided pattern, and CRMA-762's move to IAP was a
# response to the 404 that is now understood and has a direct fix.
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
#
# Daemon-free, via crane. There is no Docker daemon on a dev Mac and
# cloudbuild.builds.create is denied in mcc-crm-automations, so `docker build`
# and `gcloud run deploy --source` both dead-end. crane assembles the image by
# appending one tar layer onto a base image, entirely over the registry API.
# This matches prism, helm, mcc-audience-builder and CRMA-762.
#
# This is safe to cross-build here only because the dependency tree is pure
# JavaScript: the lockfile carries no package with an install script and none
# constrained by os/cpu, so node_modules resolved on macOS is byte-for-byte
# what linux/amd64 needs. RE-CHECK THAT before adding a dependency:
#   jq '[.packages[] | select(.hasInstallScript or .os or .cpu)] | length' \
#     services/<name>/package-lock.json      # must print 0
# If it ever prints non-zero, the dep has native code and this build silently
# ships the wrong architecture — install inside a linux/amd64 container, or go
# back to a real Docker build.
#
# The Dockerfile remains the source of truth for image CONTENTS and is what
# `docker run` reproduces locally. The staging below must mirror it; they are
# checked against each other by services/deploy_layout.test.mjs.
# ---------------------------------------------------------------------------
CRANE="${CRANE:-crane}"
BASE_IMAGE="${BASE_IMAGE:-node:22-slim}"

if [[ "$BUILD" == "1" ]]; then
  command -v "$CRANE" >/dev/null || {
    echo "crane not found. Install it (brew install crane) or set CRANE=/path/to/crane." >&2
    exit 1
  }

  log "Staging ${IMAGE} (linux/amd64, context = repo root, base = ${BASE_IMAGE})..."
  CTX="$(mktemp -d -t "${SERVICE}-ctx.XXXXXX")"
  trap 'rm -rf "$CTX"' EXIT

  # Mirror the Dockerfile's layout exactly: /app/services/{lib,<name>} with
  # production node_modules inside the service dir.
  mkdir -p "$CTX/app/services"
  cp -R "$REPO_ROOT/services/lib" "$CTX/app/services/lib"
  mkdir -p "$CTX/app/services/$NAME"
  # Copy the service's own files, but never a local node_modules — it is
  # reinstalled from the lockfile below so the image can't inherit dev deps
  # or a half-stale local tree.
  (cd "$SVC_DIR" && tar --exclude=node_modules -cf - .) | tar -C "$CTX/app/services/$NAME" -xf -

  log "Installing production dependencies from the lockfile..."
  npm ci --omit=dev --prefix "$CTX/app/services/$NAME"

  log "Appending layer onto ${BASE_IMAGE} and pushing..."
  tar -C "$CTX" -cf "$CTX/layer.tar" app

  # Give crane its own throwaway Docker config, for two reasons. It keeps the
  # Artifact Registry token out of ~/.docker/config.json, and it sidesteps a
  # stale `credsStore` there: a machine that once had Docker Desktop keeps
  # "credsStore": "desktop" long after the app is gone, and crane then fails
  # even an ANONYMOUS pull of the base image with
  #   error getting credentials - err: exec: "docker-credential-desktop":
  #   executable file not found in $PATH
  export DOCKER_CONFIG="$CTX/dockerconfig"
  mkdir -p "$DOCKER_CONFIG"

  # Pipe the token to `crane auth login --password-stdin`; passing it as an
  # argv value would leave a live OAuth token in the process table.
  gcloud auth print-access-token \
    | "$CRANE" auth login "${REGION}-docker.pkg.dev" -u oauth2accesstoken --password-stdin

  WITH_LAYER="$("$CRANE" append --platform linux/amd64 \
    -b "$BASE_IMAGE" -f "$CTX/layer.tar" -t "${IMAGE%:*}:layer")"

  "$CRANE" mutate "$WITH_LAYER" -t "$IMAGE" \
    --workdir "/app/services/$NAME" \
    --env NODE_ENV=production \
    --env "PORT=${PORT}" \
    --user node \
    --entrypoint node \
    --cmd server.mjs
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
  # revision to protect), so the very first revision is unavoidably live on
  # create. It is still tagged `candidate` and still smoke-tested below; the
  # promote that follows is then a no-op. Deliberately NOT followed by a second
  # --no-traffic deploy of the same image: that would build a redundant
  # revision, move the tag onto it, and orphan the one already serving. Every
  # deploy after this one takes the normal dark-deploy path.
  log "Service does not exist yet — creating a bootstrap revision (no --no-traffic on first create)."
  deploy_step ""
else
  log "Dark-deploying candidate (--no-traffic --tag candidate)..."
  deploy_step "--no-traffic"
fi

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format 'value(status.url)')"
CANDIDATE_URL="https://candidate---${URL#https://}"
CANDIDATE_REVISION="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format 'value(status.latestCreatedRevisionName)')"

# ---------------------------------------------------------------------------
# 5. Smoke test — authenticated, because ingress is not public.
# ---------------------------------------------------------------------------
log "Smoke-testing ${CANDIDATE_URL}${HEALTH_PATH} (authenticated)..."
# Bare `print-identity-token`, no --audiences: this is the form Google's own
# "test a private Cloud Run service" docs use, and for USER credentials
# --audiences is rejected outright ("Invalid audiences") — it is a
# service-account-credential flag. If this script is ever run by an
# impersonated service account instead of a human, add
# `--audiences "$CANDIDATE_URL"` here. UNVERIFIED either way: gcloud auth
# could not be exercised on the machine this was written on (CRMA-776).
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
  # Do NOT claim 0% here unconditionally. On the bootstrap path above, gcloud
  # rejects --no-traffic on a brand-new service, so the first revision is
  # unavoidably serving 100% — saying otherwise tells the operator the exact
  # opposite of what is true at the moment they decide whether to stop.
  if [[ -z "$SERVICE_EXISTS" ]]; then
    log "Skipping promote (--no-promote). NOTE: this was the first-ever deploy of ${SERVICE}, so the new revision is serving 100% of traffic — Cloud Run does not allow --no-traffic on service creation. Nothing was displaced (there was no prior revision). Candidate URL: ${CANDIDATE_URL}"
  else
    log "Skipping promote (--no-promote); candidate is live at ${CANDIDATE_URL}, serving 0% of traffic."
  fi
fi
