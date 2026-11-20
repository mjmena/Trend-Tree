#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

fixture_sql="$(mktemp "${TMPDIR:-/tmp}/candidate-commit.XXXXXX")"
trap 'rm -f "$fixture_sql"' EXIT
python3 test/build_candidate_commit_fixture.py > "$fixture_sql"
snow sql -c claude --database MCC_RAW --schema MARKETING_DEV \
  --enable-templating NONE -f "$fixture_sql" "$@"
