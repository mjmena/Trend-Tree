#!/usr/bin/env bash
# Helpers for deploy.sh that are worth testing on their own, in their own file
# so a test can source them without running a deploy (tests/test_deploy_lib.py).
#
# Nothing here executes at source time.

# is_service_not_found_error STDERR_TEXT
#
# Whether gcloud's stderr says the service genuinely does not exist, as
# opposed to "the call failed". `gcloud run services describe` reports a
# missing service as a non-zero exit with one of:
#   ERROR: (gcloud.run.services.describe) Cannot find service [NAME]
#   ERROR: (gcloud.run.services.describe) NOT_FOUND: Resource 'namespaces/...'
# Every other non-zero exit -- expired credentials, a network blip, an API
# 500, a permission problem -- is NOT this, and must never be read as "the
# service does not exist" (see resolve_service_url).
is_service_not_found_error() {
  local err="$1"
  local lowered
  lowered="$(printf '%s' "$err" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    *not_found*|*"cannot find service"*|*"does not exist"*) return 0 ;;
    *) return 1 ;;
  esac
}

# resolve_service_url SERVICE REGION PROJECT
#
# Three distinct outcomes, which the old `2>/dev/null || true` one-liner
# collapsed into one:
#   * exit 0, URL on stdout      -- the service exists and is serving at that URL
#   * exit 0, nothing on stdout  -- gcloud authoritatively says it does not exist
#   * exit 1, gcloud's stderr    -- the call FAILED; the caller must not guess
#
# The third case is the whole point. Under the old collapse, a transient
# describe failure produced the same empty string as "no such service", and
# deploy.sh's bootstrap branch then deployed WITHOUT --no-traffic (and, in
# oidc mode, with the deliberately unmatchable bootstrap audience) straight
# onto a healthy, serving service -- promoting an unprobed revision to 100%
# traffic and 401-ing every caller. That was harmless before the OIDC
# audience bootstrap existed, because the old bootstrap carried the same
# static IAP audience as every other revision. It is not harmless now.
resolve_service_url() {
  local service="$1" region="$2" project="$3"
  local gcloud_bin="${GCLOUD:-gcloud}"
  local err_file out err status
  err_file="$(mktemp -t trend-tree-prediction-describe.XXXXXX)"
  if out="$("$gcloud_bin" run services describe "$service" \
    --region "$region" --project "$project" \
    --format 'value(status.url)' 2>"$err_file")"; then
    status=0
  else
    status=$?
  fi
  err="$(cat "$err_file")"
  rm -f "$err_file"

  if [[ "$status" -eq 0 ]]; then
    printf '%s' "$out"
    return 0
  fi
  if is_service_not_found_error "$err"; then
    return 0
  fi
  printf '%s\n' "$err" >&2
  return 1
}
