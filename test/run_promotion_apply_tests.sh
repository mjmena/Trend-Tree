#!/usr/bin/env bash
# Run the PROC_PROMOTION_APPLY double-apply fixture test against
# Snowflake. Exits non-zero if any assertion fails. Run only after the
# proc change is deployed: it CALLs the live proc.
set -euo pipefail
cd "$(dirname "$0")/.."
snow sql -c claude -f test/promotion_apply.test.sql
