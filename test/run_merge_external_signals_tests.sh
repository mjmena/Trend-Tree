#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

fixture_sql="$(mktemp "${TMPDIR:-/tmp}/merge-external-signals.XXXXXX")"
trap 'rm -f "$fixture_sql"' EXIT
python3 test/build_merge_external_signals_fixture.py > "$fixture_sql"

# Legacy CLI templating rewrites JavaScript && to &, changing the procedure.
snow sql -c claude --database MCC_RAW --schema MARKETING_DEV \
  --enable-templating NONE -f "$fixture_sql" "$@"
