#!/usr/bin/env bash
# trend-tree-prediction deploy -- build + push + dark-deploy + smoke test + promote.
#
# Build is daemon-free via crane (matching prism/deploy/deploy.sh and
# helm/deploy/deploy-helm.sh): there is no Docker daemon on a dev Mac, and
# Cloud Build is blocked in mcc-crm-automations. A Docker-daemon environment
# (CI, once wired) would use services/prediction/Dockerfile instead; both
# produce the same /app layout.
#
# Ingress-auth: Cloud Run's native IAP integration (`--iap`), not bare
# `run.invoker` + service-to-service OIDC. The bare-OIDC approach this
# replaces has zero working examples anywhere in the McClatchy estate
# (CRMA-509/511 research) and, deployed for real during CRMA-762, produced an
# unexplained edge-level 404 that several rounds of platform-level
# investigation (org policy, ingress annotation, VPC-SC audit logs) could not
# root-cause. `--iap --no-allow-unauthenticated` on `gcloud beta run deploy`
# is the pattern every other locked-down service in the estate actually uses
# and that works (helm, mcc-audience-builder, mcc-newsletters/dashboard) --
# see mcc-audience-builder/deploy/deploy.sh:101 for the reference this
# mirrors. `beta` track is required for the `--iap` flag on `run deploy`.
#
# This is a two-stage promote, per CRMA-762's acceptance criteria: the image
# is always deployed --no-traffic under the `candidate` tag first, smoke-
# tested at its tagged URL, and only then promoted to 100% traffic. A failed
# smoke test exits non-zero and leaves the previously-promoted revision
# serving, untouched.
#
# One bootstrap wrinkle, self-converging (no manual follow-up needed):
# `gcloud run deploy --no-traffic` is rejected when creating a brand-new
# service (there is no prior revision to protect) -- on a first-ever deploy
# this script creates the service without --no-traffic, then falls through
# to the normal dark-deploy flow for every step after. Unlike the bare-OIDC
# attempt this replaces, there is no audience chicken-and-egg problem here:
# IAP's audience is `/projects/{PROJECT_NUMBER}/locations/{REGION}
# /services/{SERVICE}` -- static, known before any deploy exists.
#
# The smoke test hits the candidate URL *unauthenticated* and expects 401
# (IAP's own rejection, matching the documented behavior of every other
# IAP-fronted service in the estate -- see helm/deploy/deploy-helm.sh:114,
# "401 if hit directly"). This proves IAP is correctly wired in front of the
# revision; it does not by itself prove the container's own app code is
# healthy the way an authenticated 200 would (IAP rejects before reaching the
# backend), so it is a weaker signal than the original design intended -- the
# real proof is the authenticated capped-scope /run call in CRMA-762's AC4/5,
# done separately once an IAP-accessor identity is available to call with.
#
#   deploy/deploy.sh                build + push + dark-deploy + smoke test + promote
#   deploy/deploy.sh --no-build     redeploy the latest pushed image through the same flow
#   deploy/deploy.sh --no-promote   stop after the smoke test; candidate stays at 0% traffic
set -euo pipefail

PROJECT=mcc-crm-automations
REGION=us-east4
SERVICE=trend-tree-prediction
REPO=mcc
GIT_SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:${GIT_SHA}"
BASE=python:3.12-slim
CRANE="${CRANE:-crane}"
UV="${UV:-uv}"
# Runtime identity for the container itself (not a caller identity -- IAP
# access for *callers* is granted separately via roles/iap.httpsResourceAccessor,
# see the log line at the end of this script). crm-runtime@ already carries
# project-level roles/secretmanager.secretAccessor, reaching the existing
# snowflake-private-key secret with no new binding needed.
SERVICE_ACCOUNT=crm-runtime@mcc-crm-automations.iam.gserviceaccount.com

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SVC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

BUILD=1
PROMOTE=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-promote) PROMOTE=0 ;;
    *) echo "unknown flag: $arg (expected --no-build / --no-promote)" >&2; exit 1 ;;
  esac
done

if [[ "$BUILD" == "1" ]]; then
  log "Staging /app tree with linux/amd64 wheels..."
  CTX="$(mktemp -d)"
  trap 'rm -rf "$CTX"' EXIT
  mkdir -p "$CTX/app"
  cp -R "$REPO_ROOT/services/lib/tt_services_lib" "$CTX/app/tt_services_lib"
  cp -R "$SVC_ROOT/prediction_service" "$CTX/app/prediction_service"

  # Cross-install: we are on arm64 macOS, the image is linux/amd64. Every
  # runtime dependency (snowflake-connector-python, cryptography, google-auth,
  # tenacity) ships manylinux wheels, so this resolves without a compiler.
  # Installs prediction/'s declared third-party deps only -- tt_services_lib
  # and prediction_service themselves are the raw copies above, not pip
  # packages (see Dockerfile's matching note).
  "$UV" pip install \
    --python-platform x86_64-manylinux2014 \
    --python-version 3.12 \
    --target "$CTX/app/vendor" \
    "$SVC_ROOT" >/dev/null

  log "Pushing ${IMAGE} (crane append onto ${BASE})..."
  tar -C "$CTX" -cf "$CTX/layer.tar" app
  export DOCKER_CONFIG="$CTX/docker-config"
  mkdir -p "$DOCKER_CONFIG"
  "$CRANE" auth login "${REGION}-docker.pkg.dev" -u oauth2accesstoken -p "$(gcloud auth print-access-token)"
  WITH_LAYER=$("$CRANE" append --platform linux/amd64 -b "$BASE" -f "$CTX/layer.tar" -t "${IMAGE%:*}:layer")
  "$CRANE" mutate "$WITH_LAYER" -t "$IMAGE" \
    --workdir /app \
    --env PYTHONPATH=/app/vendor \
    --env PYTHONUNBUFFERED=1 \
    --env PORT=8080 \
    --entrypoint python \
    --cmd "-m,prediction_service.server"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${SERVICE}"

ENV_FILE="$(mktemp -t trend-tree-prediction-env.XXXXXX.yaml)"
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<YAML
PREDICTION_SNOWFLAKE_ACCOUNT: 'WVB49304-MCCLATCHY_EVAL'
PREDICTION_SNOWFLAKE_USER: 'CRMBOT_SERVICE_USER'
PREDICTION_SNOWFLAKE_ROLE: 'MARKETING_ENGINEER'
PREDICTION_SNOWFLAKE_WAREHOUSE: 'MARKETING_WH'
PREDICTION_SNOWFLAKE_DATABASE: 'MCC_PRESENTATION'
PREDICTION_SNOWFLAKE_SCHEMA: 'TREND_AGENT'
PREDICTION_SERVICE_AUDIENCE: '${IAP_AUDIENCE}'
YAML

# deploy_step TRAFFIC_FLAG
deploy_step() {
  local traffic_flag="$1"  # "--no-traffic" or "" (unsupported on first create)
  # shellcheck disable=SC2086 -- traffic_flag is intentionally either empty or one flag token
  gcloud beta run deploy "$SERVICE" \
    --project "$PROJECT" --region "$REGION" \
    --image "$IMAGE" \
    --service-account "$SERVICE_ACCOUNT" \
    --min-instances 0 --max-instances 5 \
    --cpu 1 --memory 512Mi \
    --concurrency 20 --timeout 600 \
    --port 8080 --ingress all \
    --iap --no-allow-unauthenticated \
    $traffic_flag --tag candidate \
    --update-secrets "PREDICTION_SNOWFLAKE_PRIVATE_KEY=snowflake-private-key:latest" \
    --env-vars-file "$ENV_FILE"
}

SERVICE_EXISTS="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format 'value(metadata.name)' 2>/dev/null || true)"

if [[ -z "$SERVICE_EXISTS" ]]; then
  log "Service does not exist yet -- gcloud rejects --no-traffic on creation (no prior revision to protect). Bootstrap revision will serve 100% traffic immediately; every step after this falls through to the normal dark-deploy flow."
  deploy_step ""
fi

log "Dark-deploying candidate (--no-traffic, IAP-fronted)..."
deploy_step "--no-traffic"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format 'value(status.url)')"
CANDIDATE_URL="https://candidate---$(echo "$URL" | sed 's#https://##')"

log "Smoke-testing candidate at ${CANDIDATE_URL}/healthz (unauthenticated -- expect 401 from IAP)..."
HTTP_CODE=$(curl -sS -o /tmp/trend-tree-prediction-smoke.json -w '%{http_code}' "${CANDIDATE_URL}/healthz")
if [[ "$HTTP_CODE" != "401" ]]; then
  echo "Smoke test failed: expected 401 from IAP, got HTTP ${HTTP_CODE}. Leaving candidate at 0% traffic. Response:" >&2
  cat /tmp/trend-tree-prediction-smoke.json >&2
  exit 1
fi
log "Smoke test passed: IAP correctly rejects an unauthenticated request (401)."

if [[ "$PROMOTE" == "1" ]]; then
  log "Promoting candidate to 100% traffic..."
  gcloud run services update-traffic "$SERVICE" \
    --project "$PROJECT" --region "$REGION" \
    --to-latest
else
  log "Skipping promote (--no-promote); candidate is live at ${CANDIDATE_URL}, serving 0% of traffic."
fi

log "Deployed: ${URL}"
log "IAP audience for this service: ${IAP_AUDIENCE}"
log "To grant a caller access (roles/iap.httpsResourceAccessor), mirroring mcc-audience-builder/deploy/deploy.sh:"
log "  curl -s -X POST https://iap.googleapis.com/v1/projects/${PROJECT_NUMBER}/iap_web/cloud_run-${REGION}/services/${SERVICE}:getIamPolicy \\"
log "    -H \"Authorization: Bearer \$(gcloud auth print-access-token)\""
log "  # then setIamPolicy with the same etag, adding a roles/iap.httpsResourceAccessor binding for the caller"
