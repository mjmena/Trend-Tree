#!/usr/bin/env bash
# Run the sourcing-ledger SQL fixture tests against Snowflake.
# Exits non-zero if any assertion fails (the test SQL forces a 1/0 on failure).
#
# Uses `snow sql -c claude` (this repo's mandated CLI — see CLAUDE.md /
# the snowflake snippet), not `snowsql`, which test/run_connections_tests.sh
# still calls directly.
set -euo pipefail
cd "$(dirname "$0")/.."
snow sql -c claude -f test/sourcing.test.sql
