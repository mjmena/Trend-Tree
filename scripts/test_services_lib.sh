#!/usr/bin/env bash
# Run the services/ unit tests: the services/lib pure-function modules (the
# Cloud Run fleet's shared-module home, CRMA-439) plus the deploy-layout
# checks that keep each Dockerfile and services/deploy.sh's crane staging
# describing the same image. Sibling of scripts/test_agents_lib.sh, which
# still covers the Pipedream-era agents/lib modules.
# Explicit file list — `node --test <dir>` is flaky across Node versions.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --test services/lib/*.test.mjs services/deploy_layout.test.mjs
