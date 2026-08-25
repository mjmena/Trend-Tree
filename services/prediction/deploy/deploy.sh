#!/usr/bin/env bash
# trend-tree-prediction deploy -- build + push + dark-deploy + smoke test + promote.
#
# Build is daemon-free via crane (matching prism/deploy/deploy.sh and
# helm/deploy/deploy-helm.sh): there is no Docker daemon on a dev Mac, and
# Cloud Build is blocked in mcc-crm-automations. A Docker-daemon environment
# (CI, once wired) would use services/prediction/Dockerfile instead; both
# produce the same /app layout.
#
# ---------------------------------------------------------------------------
# Ingress-auth: two modes, `oidc` (default) and `iap`.
# ---------------------------------------------------------------------------
#
# `oidc` -- plain Cloud Run IAM: `--no-allow-unauthenticated --no-iap`, callers
# need roles/run.invoker and present `Authorization: Bearer <id_token>` whose
# `aud` is the SERVICE URL. This is how the service actually runs today.
#
# `iap` -- Cloud Run's native IAP integration (`--iap`), the pattern most other
# locked-down services in the estate use (helm, mcc-audience-builder,
# mcc-newsletters/dashboard; see mcc-audience-builder/deploy/deploy.sh:101).
# Callers need roles/iap.httpsResourceAccessor and IAP forwards a signed
# `X-Goog-IAP-JWT-Assertion` whose `aud` is
# `/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE}`.
# Kept selectable so reinstating IAP is a flag, not a rewrite.
#
# The unexplained edge-level 404 that pushed CRMA-762 to IAP in the first
# place was never an OIDC problem: the service had been deployed with
# `run.googleapis.com/invoker-iam-disabled: true` while IAP was never actually
# provisioned (zero bindings on its IAP IAM policy), so NO authorization layer
# was bound and Google's frontend answered a generic 404 to everything. With
# the invoker IAM check re-enabled the service authorizes correctly and
# returns 403 to unauthenticated callers. `gcloud run deploy` preserves that
# annotation's current (enabled) state across revisions -- if a 404 ever comes
# back on every path, check the annotation first:
#   gcloud run services describe $SERVICE --region $REGION --project $PROJECT \
#     --format='value(metadata.annotations)' | tr ',' '\n' | grep invoker
#
# Set the mode with --auth-mode=iap or PREDICTION_AUTH_MODE=iap. The mode
# drives BOTH the deploy flags and PREDICTION_SERVICE_AUDIENCE, because the
# two audience shapes are not interchangeable -- an IAP-shaped audience on an
# OIDC-mode service 401s every authenticated caller.
#
# This is a two-stage promote, per CRMA-762's acceptance criteria: the image
# is always deployed --no-traffic under the `candidate` tag first, smoke-
# tested at its tagged URL, and only then promoted to 100% traffic. A failed
# smoke test exits non-zero and leaves the previously-promoted revision
# serving, untouched.
#
# Two bootstrap wrinkles, both self-converging (no manual follow-up needed):
#   * `gcloud run deploy --no-traffic` is rejected when creating a brand-new
#     service (there is no prior revision to protect) -- on a first-ever deploy
#     this script creates the service without --no-traffic, then falls through
#     to the normal dark-deploy flow for every step after. That branch is
#     taken ONLY when gcloud authoritatively reports the service missing; if
#     the describe call merely FAILS, the deploy aborts rather than guessing
#     (see deploy/lib.sh -- running the bootstrap branch against an existing,
#     serving service would promote an unprobed revision to 100% traffic).
#   * in `oidc` mode the audience IS the service URL, which does not exist
#     until the service does. The bootstrap revision therefore gets a
#     deliberately unmatchable placeholder audience (it fails CLOSED -- every
#     caller 401s -- rather than accepting anything), and the very next
#     deploy, one step later, carries the real URL. `iap` mode has no such
#     dance: its audience is static and known before any deploy exists.
#
# The smoke test is THREE probes, and all three must pass before any promote:
#
#   1. Unauthenticated GET of the candidate's /health must be REJECTED at the
#      edge -- 403 under Cloud Run IAM, 401 under IAP (CRMA-762 AC4; matches
#      helm/deploy/deploy-helm.sh:114). Anything else, 404 above all, means
#      the authorization layer is not bound and the gate fails.
#   2. Authenticated GET of the *same* candidate-tagged /health must return
#      200 with {"ok":true} from the container itself.
#   3. Authenticated GET of the candidate's /whoami -- the only probe that
#      runs the container's own token verification, because /health is
#      deliberately registered without the require_caller dependency. A
#      revision whose PREDICTION_SERVICE_AUDIENCE has the wrong shape for its
#      AUTH_MODE passes probes 1 and 2 and 401s every real call; only this
#      one catches it. /whoami is a side-effect-free no-op route on purpose:
#      /run would append a real verdict-ledger row on every deploy.
#
# The health probes hit /health, NOT the conventional /healthz: Google's edge
# intercepts the exact path `/healthz` on *.run.app hostnames and returns its
# own generic 404 before the request reaches Cloud Run or IAP (measured
# 2026-08-21). On /healthz both of them fail for a reason that has nothing to
# do with the candidate revision's health. Leave these on /health.
#
# Probe 1 alone has no discriminating power over the revision: the edge
# rejects before the request ever reaches a revision, so a revision that 500s
# on every single request produces the identical rejection as a healthy one --
# and the old gate then promoted it. Only probes 2 and 3 actually reach the
# candidate's container, and only probe 3 reaches its auth code.
#
# Probes 2 and 3 need a caller identity token. If one cannot be obtained, or the
# probe cannot be made for any other reason, this script EXITS NON-ZERO and
# does not promote. "Couldn't check" must never read as "passed" -- that is
# the exact failure mode being fixed here.
#
# Token sourcing, in order:
#   * $PROBE_ID_TOKEN (or the older $IAP_ID_TOKEN), if set -- an already-minted
#     token (the estate has seen `gcloud auth print-identity-token` rejected
#     for audience reasons; a token minted elsewhere, e.g. from a browser
#     session or an impersonated service account, drops in here without
#     weakening the gate, because the probe still has to come back 200).
#   * `gcloud auth print-identity-token --audiences=<audience>`, where the
#     audience defaults to the service URL in `oidc` mode (what the container
#     verifies against) and is left to gcloud's default in `iap` mode.
#     $PROBE_TOKEN_AUDIENCE (or the older $IAP_TOKEN_AUDIENCE) overrides.
#
#   deploy/deploy.sh                build + push + dark-deploy + smoke test + promote
#   deploy/deploy.sh --no-build     redeploy the latest pushed image through the same flow
#   deploy/deploy.sh --no-promote   stop after the smoke test; candidate stays at 0% traffic
#   deploy/deploy.sh --auth-mode=iap   deploy behind IAP instead of Cloud Run IAM
#
#   PROBE_ID_TOKEN=...        use this identity token for the authenticated probe
#   PROBE_TOKEN_AUDIENCE=...  mint the probe token for this audience
#
# Where a PROBE_ID_TOKEN comes from when the user credential is stale -- which
# is the normal case on a dev Mac, because a lapsed SSO session cannot be
# refreshed non-interactively and `gcloud auth print-identity-token` then has
# nothing to sign with. Impersonate crm-automations@, which carries
# roles/iam.serviceAccountTokenCreator for group:crm@mcclatchy.com as a binding
# on the service account itself. It needs no human:
#
#   export CLOUDSDK_AUTH_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
#   SA=crm-automations@mcc-crm-automations.iam.gserviceaccount.com
#   PROBE_ID_TOKEN=$(curl -s -X POST \
#     -H "Authorization: Bearer $CLOUDSDK_AUTH_ACCESS_TOKEN" \
#     -H "Content-Type: application/json" \
#     "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$SA:generateIdToken" \
#     -d "{\"audience\":\"<service-url>\",\"includeEmail\":true}" | jq -r .token)
#
# The same CLOUDSDK_AUTH_ACCESS_TOKEN export also carries the gcloud calls in
# this script, including the crane push. crm-automations@ must additionally
# hold roles/run.invoker on this service or probe 2 comes back 403; it was
# granted 2026-08-24. Note that IAM propagation takes about 90 seconds.
#
# ---------------------------------------------------------------------------
# SCHEMA MIGRATIONS RUN BEFORE THIS SCRIPT.
# ---------------------------------------------------------------------------
#
# This script deploys code. It does NOT apply DDL, and sql/*.sql is not part of
# the image. A release that widens the ledger's column list therefore has an
# ORDER: migrate first, deploy second.
#
# The failure mode is not partial. Every phase -- generate, match and sweep --
# writes through the one MERGE in domain/ledger.py, so a column the live table
# does not have yet makes that statement fail to compile and takes the whole
# service down, not just the new field. Snowflake reports it as
# `invalid identifier '<COLUMN>'`; if a deploy starts erroring that way, look
# for an unapplied migration before you look at the code.
#
# Nothing is outstanding as of 2026-08-24. The last one was
# sql/alter_prediction_verdict_ledger_add_narrative.sql (CRMA-782, ANGLE +
# AUDIENCE_QUESTION); it is APPLIED, and revision 00013 -- the first to write
# those columns -- is serving. Do NOT run it again: ADD COLUMN in this form is
# not idempotent and a second run errors rather than no-opping.
#
# When the next migration lands here, check the column is absent before running
# it, for that same reason:
#   SHOW COLUMNS LIKE '<COLUMN>' IN TABLE
#     MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER;
#
# The smoke test below will NOT catch a missed migration: its three probes hit
# /health and the auth path, none of which writes a verdict row.
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
# Runtime identity for the container itself (not a caller identity -- caller
# access is granted separately, see the log lines at the end of this script).
# crm-runtime@ already carries project-level roles/secretmanager.secretAccessor,
# reaching the existing snowflake-private-key secret with no new binding needed.
SERVICE_ACCOUNT=crm-runtime@mcc-crm-automations.iam.gserviceaccount.com

# An audience no token can ever carry, used only for the first-ever create in
# oidc mode (see the bootstrap note above). Fails closed by construction.
BOOTSTRAP_AUDIENCE="https://service-url-not-yet-known.invalid"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SVC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

BUILD=1
PROMOTE=1
AUTH_MODE="${PREDICTION_AUTH_MODE:-oidc}"
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-promote) PROMOTE=0 ;;
    --auth-mode=*) AUTH_MODE="${arg#--auth-mode=}" ;;
    *) echo "unknown flag: $arg (expected --no-build / --no-promote / --auth-mode=oidc|iap)" >&2; exit 1 ;;
  esac
done

case "$AUTH_MODE" in
  oidc|iap) ;;
  *) echo "unknown auth mode: ${AUTH_MODE} (expected oidc or iap)" >&2; exit 1 ;;
esac

# One cleanup handler for everything, registered once. Each `trap ... EXIT`
# REPLACES the previous handler rather than adding to it, so the build's
# `trap 'rm -rf "$CTX"'` used to be silently discarded by the env-file trap
# further down -- leaving $CTX/docker-config/config.json, which holds a live
# `gcloud auth print-access-token` value, on disk after every run.
CTX=""
ENV_FILE=""
AUTH_HEADER_FILE=""
SMOKE_BODY=""
TOKEN_ERR=""
cleanup() {
  [[ -n "$CTX" ]] && rm -rf "$CTX"
  [[ -n "$ENV_FILE" ]] && rm -f "$ENV_FILE"
  [[ -n "$AUTH_HEADER_FILE" ]] && rm -f "$AUTH_HEADER_FILE"
  [[ -n "$SMOKE_BODY" ]] && rm -f "$SMOKE_BODY"
  [[ -n "$TOKEN_ERR" ]] && rm -f "$TOKEN_ERR"
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

# Sets $URL to the service's URL, or to empty if the service genuinely does
# not exist yet -- and ABORTS the deploy if gcloud could not answer the
# question at all. See deploy/lib.sh: "couldn't check" must never read as
# "does not exist", because the not-exist branch below deploys WITHOUT
# --no-traffic and (in oidc mode) with an unmatchable bootstrap audience.
#
# Assigns rather than echoing, deliberately: `URL="$(service_url)"` would run
# the abort inside a command substitution, where `exit 1` only leaves the
# subshell and the caller sails on with an empty URL -- reproducing the exact
# bug this guards against.
set_service_url() {
  if ! URL="$(resolve_service_url "$SERVICE" "$REGION" "$PROJECT")"; then
    echo "Aborting: could not determine whether ${SERVICE} exists in ${PROJECT}/${REGION} (gcloud's error is above). Refusing to guess -- treating a failed describe as 'the service does not exist' would deploy an unprobed revision straight to 100% traffic on an existing, healthy service." >&2
    exit 1
  fi
}

ENV_FILE="$(mktemp -t trend-tree-prediction-env.XXXXXX.yaml)"
# write_env_file AUDIENCE -- the audience shape must match AUTH_MODE; see the
# header. Everything else is mode-independent.
write_env_file() {
  cat > "$ENV_FILE" <<YAML
PREDICTION_SNOWFLAKE_ACCOUNT: 'WVB49304-MCCLATCHY_EVAL'
PREDICTION_SNOWFLAKE_USER: 'CRMBOT_SERVICE_USER'
PREDICTION_SNOWFLAKE_ROLE: 'MARKETING_ENGINEER'
PREDICTION_SNOWFLAKE_WAREHOUSE: 'MARKETING_WH'
PREDICTION_SNOWFLAKE_DATABASE: 'MCC_PRESENTATION'
PREDICTION_SNOWFLAKE_SCHEMA: 'TREND_AGENT'
PREDICTION_SERVICE_AUTH_MODE: '${AUTH_MODE}'
PREDICTION_SERVICE_AUDIENCE: '$1'
YAML
}

# The generation phase's Gemini key (CRMA-763). Bound only when the secret
# actually exists in the project: as of 2026-08-21 it does not, and an
# --update-secrets flag naming a missing secret fails the whole deploy. A
# service deployed without it still serves /health, /whoami and /run, and
# answers POST /generate with a 503 naming the variable -- so the pillar's
# other work is not blocked on an admin ask, and the binding appears
# automatically on the next deploy once the secret is created:
#   gcloud secrets create generic-gemini-api-key --project mcc-crm-automations
#   printf %s "$KEY" | gcloud secrets versions add generic-gemini-api-key \
#     --project mcc-crm-automations --data-file=-
# One --update-secrets flag, not two: gcloud treats it as a single dict and a
# second occurrence replaces the first rather than adding to it.
GEMINI_SECRET="${PREDICTION_GEMINI_SECRET:-generic-gemini-api-key}"
# The saturation phase's Exploding Topics key (CRMA-765), bound the same
# conditional way and for a stronger reason: ET is an ORACLE, not a gate, so a
# service deployed without the key still writes every verdict it would have
# written -- each one recording an explicit `not_configured` miss, which the
# strategy says carries no penalty. Create it when access is provisioned:
#   gcloud secrets create exploding-topics-api-key --project mcc-crm-automations
#   printf %s "$KEY" | gcloud secrets versions add exploding-topics-api-key \
#     --project mcc-crm-automations --data-file=-
# GDELT needs no credential, so nothing here binds for it.
ET_SECRET="${PREDICTION_EXPLODING_TOPICS_SECRET:-exploding-topics-api-key}"
secret_bindings() {
  local bindings="PREDICTION_SNOWFLAKE_PRIVATE_KEY=snowflake-private-key:latest"
  if gcloud secrets describe "$GEMINI_SECRET" --project "$PROJECT" >/dev/null 2>&1; then
    bindings="${bindings},PREDICTION_GEMINI_API_KEY=${GEMINI_SECRET}:latest"
  fi
  if gcloud secrets describe "$ET_SECRET" --project "$PROJECT" >/dev/null 2>&1; then
    bindings="${bindings},PREDICTION_EXPLODING_TOPICS_API_KEY=${ET_SECRET}:latest"
  fi
  printf %s "$bindings"
}

# deploy_step TRAFFIC_FLAG
deploy_step() {
  local traffic_flag="$1"  # "--no-traffic" or "" (unsupported on first create)
  local secrets
  secrets="$(secret_bindings)"  # the Gemini pair joins once the secret exists; see above
  local iap_flag="--no-iap"
  [[ "$AUTH_MODE" == "iap" ]] && iap_flag="--iap"
  # `--no-iap` is stated explicitly rather than omitted: the service HAS been
  # deployed with --iap before, and leaving the flag off would silently
  # inherit that, putting an IAP edge in front of a container configured to
  # verify Cloud Run IAM tokens. `beta` track is required for --[no-]iap.
  # shellcheck disable=SC2086 -- traffic_flag is intentionally either empty or one flag token
  gcloud beta run deploy "$SERVICE" \
    --project "$PROJECT" --region "$REGION" \
    --image "$IMAGE" \
    --service-account "$SERVICE_ACCOUNT" \
    --min-instances 0 --max-instances 5 \
    --cpu 1 --memory 512Mi \
    --concurrency 20 --timeout 600 \
    --port 8080 --ingress all \
    "$iap_flag" --no-allow-unauthenticated \
    $traffic_flag --tag candidate \
    --update-secrets "$secrets" \
    --env-vars-file "$ENV_FILE"
}

URL=""
set_service_url

# The audience the container will verify incoming tokens against.
if [[ "$AUTH_MODE" == "iap" ]]; then
  AUDIENCE="$IAP_AUDIENCE"
elif [[ -n "$URL" ]]; then
  AUDIENCE="$URL"
else
  AUDIENCE="$BOOTSTRAP_AUDIENCE"
fi

if [[ -z "$URL" ]]; then
  log "Service does not exist yet -- gcloud rejects --no-traffic on creation (no prior revision to protect). Bootstrap revision will serve 100% traffic immediately; every step after this falls through to the normal dark-deploy flow."
  if [[ "$AUTH_MODE" == "oidc" ]]; then
    log "  oidc mode: the audience is the service URL, which does not exist yet. Bootstrapping with the unmatchable placeholder '${BOOTSTRAP_AUDIENCE}' (fails closed -- every caller 401s); the dark deploy one step below carries the real URL."
  fi
  write_env_file "$AUDIENCE"
  deploy_step ""
  set_service_url
  if [[ -z "$URL" ]]; then
    echo "Bootstrap deploy reported success but the service has no URL. Not continuing." >&2
    exit 1
  fi
  [[ "$AUTH_MODE" == "oidc" ]] && AUDIENCE="$URL"
fi

write_env_file "$AUDIENCE"

log "Dark-deploying candidate (--no-traffic, auth mode: ${AUTH_MODE}, audience: ${AUDIENCE})..."
deploy_step "--no-traffic"

CANDIDATE_URL="https://candidate---$(echo "$URL" | sed 's#https://##')"

# mktemp, not a fixed /tmp path: `curl -o` follows an existing symlink, so a
# predictable name is a local user's lever to have this script overwrite a
# file of their choosing. Registered in cleanup() above like every other temp.
SMOKE_BODY="$(mktemp -t trend-tree-prediction-smoke.XXXXXX)"
# probe_body_reset -- empty the shared body file before each curl, so a
# transport failure (curl writes nothing) shows an empty response rather than
# the *previous* probe's body, which reads as a wildly misleading diagnostic.
probe_body_reset() { : > "$SMOKE_BODY"; }

if [[ "$AUTH_MODE" == "iap" ]]; then
  REJECT_CODES="401"
else
  # Cloud Run IAM answers 403 ("client does not have permission") to a caller
  # with no credential; 401 is accepted as the equivalent edge rejection. A
  # 404 is the invoker-IAM/IAP misconfiguration described in the header, and
  # a 200 means the service is wide open -- both fail the gate.
  REJECT_CODES="401|403"
fi

log "Probe 1/3: ${CANDIDATE_URL}/health unauthenticated (expect ${REJECT_CODES} from the edge)..."
# `|| echo 000` so a curl-level failure reports as a failed gate rather than
# tripping `set -e` with no explanation.
probe_body_reset
HTTP_CODE=$(curl -sS -o "$SMOKE_BODY" -w '%{http_code}' "${CANDIDATE_URL}/health" || echo "000")
if [[ ! "$HTTP_CODE" =~ ^(${REJECT_CODES})$ ]]; then
  echo "Smoke test FAILED: expected ${REJECT_CODES} from the edge, got HTTP ${HTTP_CODE}. Not promoting; candidate stays at 0% traffic. Response:" >&2
  cat "$SMOKE_BODY" >&2
  echo >&2
  if [[ "$HTTP_CODE" == "404" ]]; then
    echo "  404 on every path is the signature of NO authorization layer being bound: check run.googleapis.com/invoker-iam-disabled on the service, and whether IAP is half-provisioned. See this script's header." >&2
  fi
  exit 1
fi
log "Probe 1/3 passed: the edge rejects an unauthenticated request (${HTTP_CODE})."

# Probe 2 is the one with discriminating power: it reaches the candidate
# revision's own container. Failing to obtain a token is a FAILURE, not a
# skip -- an unverifiable revision must never be promoted.
log "Probe 2/3: ${CANDIDATE_URL}/health authenticated (expect 200 from the candidate revision)..."
PRESET_ID_TOKEN="${PROBE_ID_TOKEN:-${IAP_ID_TOKEN:-}}"
# In oidc mode the token's audience must be exactly what the container checks
# (PREDICTION_SERVICE_AUDIENCE = the service URL). In iap mode, gcloud's
# default audience is what the estate's other IAP services use.
TOKEN_AUDIENCE="${PROBE_TOKEN_AUDIENCE:-${IAP_TOKEN_AUDIENCE:-}}"
if [[ -z "$TOKEN_AUDIENCE" && "$AUTH_MODE" == "oidc" ]]; then
  TOKEN_AUDIENCE="$AUDIENCE"
fi

if [[ -n "$PRESET_ID_TOKEN" ]]; then
  ID_TOKEN="$PRESET_ID_TOKEN"
  log "  (using the identity token from \$PROBE_ID_TOKEN/\$IAP_ID_TOKEN)"
else
  TOKEN_ERR="$(mktemp -t trend-tree-prediction-token.XXXXXX)"  # in cleanup()
  if [[ -n "$TOKEN_AUDIENCE" ]]; then
    ID_TOKEN="$(gcloud auth print-identity-token --audiences="$TOKEN_AUDIENCE" 2>"$TOKEN_ERR" || true)"
  else
    ID_TOKEN="$(gcloud auth print-identity-token 2>"$TOKEN_ERR" || true)"
  fi
  if [[ -z "$ID_TOKEN" ]]; then
    echo "Smoke test FAILED: could not mint an identity token for the authenticated probe, so the candidate revision's health is UNVERIFIED. Not promoting. gcloud said:" >&2
    cat "$TOKEN_ERR" >&2
    echo "Fix by granting this identity the caller role (see the end of this script), setting PROBE_TOKEN_AUDIENCE, or passing a pre-minted token in PROBE_ID_TOKEN." >&2
    rm -f "$TOKEN_ERR"
    TOKEN_ERR=""
    exit 1
  fi
  rm -f "$TOKEN_ERR"
  TOKEN_ERR=""
fi

# Header from a 0600 file rather than an argv element -- same `ps` exposure
# the crane login above avoids.
AUTH_HEADER_FILE="$(mktemp -t trend-tree-prediction-hdr.XXXXXX)"
chmod 600 "$AUTH_HEADER_FILE"
printf 'Authorization: Bearer %s\n' "$ID_TOKEN" > "$AUTH_HEADER_FILE"

probe_body_reset
AUTH_CODE=$(curl -sS -o "$SMOKE_BODY" -w '%{http_code}' -H @"$AUTH_HEADER_FILE" "${CANDIDATE_URL}/health" || echo "000")

if [[ "$AUTH_CODE" != "200" ]]; then
  echo "Smoke test FAILED: authenticated probe of the candidate revision returned HTTP ${AUTH_CODE}, expected 200. Not promoting; candidate stays at 0% traffic. Response:" >&2
  cat "$SMOKE_BODY" >&2
  echo >&2
  if [[ "$AUTH_MODE" == "iap" ]]; then
    echo "  401/403 -> the calling identity lacks roles/iap.httpsResourceAccessor, or the token audience is wrong (set PROBE_TOKEN_AUDIENCE / PROBE_ID_TOKEN)." >&2
  else
    echo "  403 -> the calling identity lacks roles/run.invoker on ${SERVICE}." >&2
    echo "  401 -> the EDGE rejected the token (this route has no container-side auth check -- that is probe 3): check its aud and that its iss is https://accounts.google.com. Override with PROBE_TOKEN_AUDIENCE / PROBE_ID_TOKEN." >&2
  fi
  echo "  5xx/000 -> the candidate revision itself is unhealthy. Check: gcloud run services logs read ${SERVICE} --region ${REGION} --project ${PROJECT}" >&2
  exit 1
fi
if ! grep -qE '"ok"[[:space:]]*:[[:space:]]*true' "$SMOKE_BODY"; then
  echo "Smoke test FAILED: authenticated probe returned 200 but not the expected /health body. Not promoting. Response:" >&2
  cat "$SMOKE_BODY" >&2
  exit 1
fi
log "Probe 2/3 passed: the candidate revision itself answers /health with 200."

# Probe 3 is the only one that runs the container's OWN auth code. /health is
# deliberately registered without the require_caller dependency, so probes 1
# and 2 together prove "the edge let my token through and the process is up"
# -- and nothing about whether verify_oidc_token/verify_iap_assertion inside
# the container agree with the edge. A revision carrying an audience of the
# wrong SHAPE for its AUTH_MODE (a partly-applied deploy, or a manual
# `gcloud run services update --update-env-vars`) passes both and then 401s
# every real call, while looking correctly locked down from outside.
#
# /whoami, not /run: /run appends a real row to FCT_PREDICTION_VERDICT_LEDGER,
# and a deploy gate must not write ledger rows on every deploy. /whoami sits
# behind the same require_caller dependency and does nothing else.
log "Probe 3/3: ${CANDIDATE_URL}/whoami authenticated (expect 200 -- the container's own auth check)..."
probe_body_reset
WHOAMI_CODE=$(curl -sS -o "$SMOKE_BODY" -w '%{http_code}' -H @"$AUTH_HEADER_FILE" "${CANDIDATE_URL}/whoami" || echo "000")
rm -f "$AUTH_HEADER_FILE"
AUTH_HEADER_FILE=""

if [[ "$WHOAMI_CODE" != "200" ]]; then
  echo "Smoke test FAILED: authenticated probe of ${CANDIDATE_URL}/whoami returned HTTP ${WHOAMI_CODE}, expected 200. Not promoting; candidate stays at 0% traffic. Response:" >&2
  cat "$SMOKE_BODY" >&2
  echo >&2
  echo "  401 here while /health returned 200 means the EDGE accepted the token but the CONTAINER rejected it -- almost always PREDICTION_SERVICE_AUDIENCE not matching AUTH_MODE=${AUTH_MODE}. This revision would 401 every real /run call. Expected audience for this mode: '${AUDIENCE}'." >&2
  echo "  404 means the candidate revision predates /whoami; redeploy from a build that includes it." >&2
  exit 1
fi
if ! grep -q '"caller"' "$SMOKE_BODY"; then
  echo "Smoke test FAILED: /whoami returned 200 but not the expected identity body. Not promoting. Response:" >&2
  cat "$SMOKE_BODY" >&2
  exit 1
fi
log "Probe 3/3 passed: the container verified the caller itself ($(cat "$SMOKE_BODY"))."

if [[ "$PROMOTE" == "1" ]]; then
  log "Promoting candidate to 100% traffic..."
  gcloud run services update-traffic "$SERVICE" \
    --project "$PROJECT" --region "$REGION" \
    --to-latest
else
  log "Skipping promote (--no-promote); candidate is live at ${CANDIDATE_URL}, serving 0% of traffic."
fi

log "Deployed: ${URL}"
log "Auth mode: ${AUTH_MODE} -- token audience for this service: ${AUDIENCE}"
if [[ "$AUTH_MODE" == "iap" ]]; then
  log "To grant a caller access (roles/iap.httpsResourceAccessor), mirroring mcc-audience-builder/deploy/deploy.sh:"
  log "  curl -s -X POST https://iap.googleapis.com/v1/projects/${PROJECT_NUMBER}/iap_web/cloud_run-${REGION}/services/${SERVICE}:getIamPolicy \\"
  log "    -H \"Authorization: Bearer \$(gcloud auth print-access-token)\""
  log "  # then setIamPolicy with the same etag, adding a roles/iap.httpsResourceAccessor binding for the caller"
else
  log "To grant a caller access (roles/run.invoker):"
  log "  gcloud run services add-iam-policy-binding ${SERVICE} --region ${REGION} --project ${PROJECT} \\"
  log "    --member='serviceAccount:CALLER@PROJECT.iam.gserviceaccount.com' --role='roles/run.invoker'"
  log "To call it:"
  log "  curl -H \"Authorization: Bearer \$(gcloud auth print-identity-token --audiences=${AUDIENCE})\" ${URL}/health"
fi
