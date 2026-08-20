#!/usr/bin/env bash
# Dry-run every lane. Assembles each lane's real input from Snowflake and the
# live prompt registry, and makes NO model calls — so it is safe to run often
# and it catches the failure that actually bites: a workflow step renamed or
# re-bound underneath a lane adapter.
#
#   bash scripts/replay/smoke.sh
#
# Needs the `snow` CLI on the 'claude' connection. No Gemini key required.
set -uo pipefail
cd "$(dirname "$0")/../.."

pass=0
fail=0

for f in scripts/replay/lanes/*.mjs; do
  lane=$(basename "$f" .mjs)
  printf '%-14s ' "$lane"
  if out=$(node scripts/replay/replay.mjs "$lane" --dry-run --limit 1 2>&1); then
    printf '\033[32mok\033[0m\n'
    pass=$((pass + 1))
  else
    printf '\033[31mFAIL\033[0m  %s\n' "$(printf '%s' "$out" | grep -m1 'replay failed' || printf '%s' "$out" | tail -1)"
    fail=$((fail + 1))
  fi
done

printf '\n%d ok, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
