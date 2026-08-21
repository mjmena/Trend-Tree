#!/usr/bin/env bash
# Run the services/lib pure-function unit tests (the Cloud Run fleet's
# shared-module home, CRMA-439). Sibling of scripts/test_agents_lib.sh,
# which still covers the Pipedream-era agents/lib modules.
# Explicit file list — `node --test <dir>` is flaky across Node versions.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --test services/lib/*.test.mjs
