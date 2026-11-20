#!/usr/bin/env bash
# Run the sourcing-poll anti-join fixture tests against Snowflake.
# Exits non-zero if any assertion fails (the test SQL forces a 1/0 on failure).
#
# Uses `snow sql -c claude` (this repo's mandated CLI — see CLAUDE.md /
# the snowflake snippet), not `snowsql`.
#
# --enable-templating NONE for the same reason the retrieval runner sets it:
# the file contains `{`-adjacent literals that snow's templating would
# otherwise try to interpret.
set -euo pipefail
cd "$(dirname "$0")/.."

cleanup() {
  local result=$?
  trap - EXIT
  if ! snow sql -c claude -f test/sourcing_poll_cleanup.sql --enable-templating NONE; then
    echo 'Sourcing poll fixture cleanup failed; rerun test/sourcing_poll_cleanup.sql.' >&2
    if (( result == 0 )); then result=1; fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

snow sql -c claude -f test/sourcing_poll_cleanup.sql --enable-templating NONE
snow sql -c claude -f test/sourcing_poll.test.sql --enable-templating NONE
