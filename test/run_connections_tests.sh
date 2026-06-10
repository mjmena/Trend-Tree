#!/usr/bin/env bash
# Run the connections-agent SQL fixture tests against Snowflake.
# Exits non-zero if any assertion fails (the test SQL forces a 1/0 on failure).
set -euo pipefail
cd "$(dirname "$0")/.."
snowsql -o friendly=false -o header=true -o timing=false -o exit_on_error=true \
  -f test/connections.test.sql
