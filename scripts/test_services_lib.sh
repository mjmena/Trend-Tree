#!/usr/bin/env bash
# Run the services/ unit tests: the services/lib pure-function modules (the
# Cloud Run fleet's shared-module home, CRMA-439) plus the deploy-layout
# checks that keep each Dockerfile and services/deploy.sh's crane staging
# describing the same image. Sibling of scripts/test_agents_lib.sh, which
# still covers the Pipedream-era agents/lib modules.
# Explicit file list — `node --test <dir>` is flaky across Node versions.
set -euo pipefail
cd "$(dirname "$0")/.."
# services/lib/normalize/ is listed separately because the glob above does not
# recurse — the (platform, vendor) normalizers CRMA-985 put in that
# subdirectory would otherwise be silently untested.
exec node --test services/lib/*.test.mjs services/lib/normalize/*.test.mjs \
  services/scrape-gateway/*.test.mjs services/deploy_layout.test.mjs
