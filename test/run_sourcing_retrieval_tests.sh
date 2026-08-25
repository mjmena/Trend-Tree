#!/usr/bin/env bash
# Run the sourcing retrieval-query SQL fixture tests against Snowflake.
# Exits non-zero if any assertion fails (the test SQL forces a 1/0 on failure).
#
# Uses `snow sql -c claude` (this repo's mandated CLI — see CLAUDE.md /
# the snowflake snippet), not `snowsql`. --enable-templating NONE: the
# fixture rows carry product-ish text and this file's own SQL uses `{`-free
# but curly-adjacent syntax in spots — same defensive flag CRMA-773 needed
# for product-text SQL files (see fix(CRMA-773) commit).
set -euo pipefail
cd "$(dirname "$0")/.."
snow sql -c claude -f test/sourcing_retrieval.test.sql --enable-templating NONE
