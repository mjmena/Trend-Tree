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
# The smoke test is TWO probes, and both must pass before any promote:
#
#   1. Unauthenticated GET of the candidate's /health must return 401 --
#      IAP's own rejection at the edge (CRMA-762 AC4; matches every other
#      IAP-fronted service in the estate, see helm/deploy/deploy-helm.sh:114).
#   2. IAP-authenticated GET of the *same* candidate-tagged /health must
#      return 200 with {"ok":true} from the container itself.
#
# Both probes hit /health, NOT the conventional /healthz: Google's edge
# intercepts the exact path `/healthz` on *.run.app hostnames and returns its
# own generic 404 before the request reaches Cloud Run or IAP (measured
# 2026-08-21). On /healthz both probes fail for a reason that has nothing to
# do with the candidate revision's health. Leave these on /health.
#
# Probe 1 alone has no discriminating power over the revision: IAP answers
# 401 at the edge before the request ever reaches a revision, so a revision
# that 500s on every single request produces the identical 401 as a healthy
# one -- and the old gate then promoted it. Only probe 2 actually reaches the
# candidate's container.
#
# Probe 2 needs a caller identity token. If one cannot be obtained, or the
# probe cannot be made for any other reason, this script EXITS NON-ZERO and
# does not promote. "Couldn't check" must never read as "passed" -- that is
# the exact failure mode being fixed here.
#
# Token sourcing, in order:
#   * $IAP_ID_TOKEN, if set -- an already-minted token (the estate has seen
#     `gcloud auth print-identity-token` rejected by IAP for audience
#     reasons; a token minted elsewhere, e.g. from a browser session or an
#     impersonated service account, drops in here without weakening the gate,
#     because the probe still has to come back 200).
#   * `gcloud auth print-identity-token`, with `--audiences=$IAP_TOKEN_AUDIENCE`
#     when that variable is set (required when minting as a service account /
#     via impersonation).
#
#   deploy/deploy.sh                build + push + dark-deploy + smoke test + promote
#   deploy/deploy.sh --no-build     redeploy the latest pushed image through the same flow
#   deploy/deploy.sh --no-promote   stop after the smoke test; candidate stays at 0% traffic
#
#   IAP_ID_TOKEN=...        use this identity token for the authenticated probe
#   IAP_TOKEN_AUDIENCE=...  mint the probe token for this audience
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

# One cleanup handler for everything, registered once. Each `trap ... EXIT`
# REPLACES the previous handler rather than adding to it, so the build's
# `trap 'rm -rf "$CTX"'` used to be silently discarded by the env-file trap
# further down -- leaving $CTX/docker-config/config.json, which holds a live
# `gcloud auth print-access-token` value, on disk after every run.
CTX=""
ENV_FILE=""
AUTH_HEADER_FILE=""
cleanup() {
  [[ -n "$CTX" ]] && rm -rf "$CTX"
  [[ -n "$ENV_FILE" ]] && rm -f "$ENV_FILE"
  [[ -n "$AUTH_HEADER_FILE" ]] && rm -f "$AUTH_HEADER_FILE"
  return 0
}
trap cleanup EXIT

if [[ "$BUILD" == "1" ]]; then
  log "Staging /app tree with linux/amd64 wheels..."
  CTX="$(mktemp -d)"
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
  # Token on stdin, never as an argv element: `-p "$(gcloud auth
  # print-access-token)"` puts a live OAuth token in the process table, where
  # any user on the box can read it out of `ps`.
  gcloud auth print-access-token \
    | "$CRANE" auth login "${REGION}-docker.pkg.dev" -u oauth2accesstoken --password-stdin
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

SMOKE_BODY=/tmp/trend-tree-prediction-smoke.json

log "Probe 1/2: ${CANDIDATE_URL}/health unauthenticated (expect 401 from IAP)..."
# `|| echo 000` so a curl-level failure reports as a failed gate rather than
# tripping `set -e` with no explanation.
HTTP_CODE=$(curl -sS -o "$SMOKE_BODY" -w '%{http_code}' "${CANDIDATE_URL}/health" || echo "000")
if [[ "$HTTP_CODE" != "401" ]]; then
  echo "Smoke test FAILED: expected 401 from IAP, got HTTP ${HTTP_CODE}. Not promoting; candidate stays at 0% traffic. Response:" >&2
  cat "$SMOKE_BODY" >&2
  exit 1
fi
log "Probe 1/2 passed: IAP rejects an unauthenticated request (401)."

# Probe 2 is the one with discriminating power: it reaches the candidate
# revision's own container. Failing to obtain a token is a FAILURE, not a
# skip -- an unverifiable revision must never be promoted.
log "Probe 2/2: ${CANDIDATE_URL}/health IAP-authenticated (expect 200 from the candidate revision)..."
if [[ -n "${IAP_ID_TOKEN:-}" ]]; then
  ID_TOKEN="$IAP_ID_TOKEN"
  log "  (using the identity token from \$IAP_ID_TOKEN)"
else
  TOKEN_ERR="$(mktemp -t trend-tree-prediction-token.XXXXXX)"
  if [[ -n "${IAP_TOKEN_AUDIENCE:-}" ]]; then
    ID_TOKEN="$(gcloud auth print-identity-token --audiences="$IAP_TOKEN_AUDIENCE" 2>"$TOKEN_ERR" || true)"
  else
    ID_TOKEN="$(gcloud auth print-identity-token 2>"$TOKEN_ERR" || true)"
  fi
  if [[ -z "$ID_TOKEN" ]]; then
    echo "Smoke test FAILED: could not mint an identity token for the authenticated probe, so the candidate revision's health is UNVERIFIED. Not promoting. gcloud said:" >&2
    cat "$TOKEN_ERR" >&2
    echo "Fix by granting this identity roles/iap.httpsResourceAccessor (see the end of this script), setting IAP_TOKEN_AUDIENCE, or passing a pre-minted token in IAP_ID_TOKEN." >&2
    rm -f "$TOKEN_ERR"
    exit 1
  fi
  rm -f "$TOKEN_ERR"
fi

# Header from a 0600 file rather than an argv element -- same `ps` exposure
# the crane login above avoids.
AUTH_HEADER_FILE="$(mktemp -t trend-tree-prediction-hdr.XXXXXX)"
chmod 600 "$AUTH_HEADER_FILE"
printf 'Authorization: Bearer %s\n' "$ID_TOKEN" > "$AUTH_HEADER_FILE"

AUTH_CODE=$(curl -sS -o "$SMOKE_BODY" -w '%{http_code}' -H @"$AUTH_HEADER_FILE" "${CANDIDATE_URL}/health" || echo "000")
rm -f "$AUTH_HEADER_FILE"
AUTH_HEADER_FILE=""

if [[ "$AUTH_CODE" != "200" ]]; then
  echo "Smoke test FAILED: authenticated probe of the candidate revision returned HTTP ${AUTH_CODE}, expected 200. Not promoting; candidate stays at 0% traffic. Response:" >&2
  cat "$SMOKE_BODY" >&2
  echo >&2
  echo "  401/403 -> the calling identity lacks roles/iap.httpsResourceAccessor, or the token audience is wrong (set IAP_TOKEN_AUDIENCE / IAP_ID_TOKEN)." >&2
  echo "  5xx/000 -> the candidate revision itself is unhealthy. Check: gcloud run services logs read ${SERVICE} --region ${REGION} --project ${PROJECT}" >&2
  exit 1
fi
if ! grep -q '"ok"' "$SMOKE_BODY"; then
  echo "Smoke test FAILED: authenticated probe returned 200 but not the expected /health body. Not promoting. Response:" >&2
  cat "$SMOKE_BODY" >&2
  exit 1
fi
log "Probe 2/2 passed: the candidate revision itself answers /health with 200."

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
