#!/usr/bin/env bash
# GDELT category experiment — Phase A of the ingestion-layer redesign.
#
# Fires 8 candidate queries + 1 control against the existing
# ingest_search_gdelt HTTP tool, isolating each by an experiment-specific
# AGENT_SESSION_ID (gdelt_exp_<slug>). Tool persists rows to
# STG_EXTERNAL_SIGNALS tagged with that session id; review the rows after
# the run to score each query's behavior-vs-listicle-vs-noise mix.
#
# Usage:
#   bash scripts/gdelt_category_experiment.sh
#
# Plan reference: /home/marty/.claude/plans/transient-splashing-gem.md
# (Phase A — sections A1, A2, A3).

set -euo pipefail

GDELT_URL="https://eoovhehfk229jrg.m.pipedream.net"
WINDOW_DAYS=7
# GDELT rate-limits the Pipedream egress IP aggressively. 3s spacing
# 8/9'd the first run with "fetch failed" TCP drops on both retries.
# 45s is the empirical minimum that lets all queries land.
SPACING_SEC="${SPACING_SEC:-45}"

QUERIES=(
  "GLP-1 lifestyle change"
  "sober curious movement"
  "dupe culture Amazon"
  "Y2K fashion comeback 2026"
  "K-beauty viral product"
  "viral TikTok product 2026"
  "daily supplement stack adults"
  "workout recovery wearable"
  "wellness trends"   # control — current categorical baseline
)

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

say()  { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %-40s  count=%-4s  %s\n' "$1" "$2" "${3:-}"; }
warn() { printf '  \033[1;33m!\033[0m %-40s  count=%-4s  %s\n' "$1" "$2" "${3:-}"; }
errf() { printf '  \033[1;31m✗\033[0m %-40s  HTTP=%s   %s\n' "$1" "$2" "${3:-}"; }

slugify() {
  echo "$1" | tr '[:upper:] ' '[:lower:]_' | tr -cd 'a-z0-9_-' | cut -c1-50
}

say "GDELT category experiment — ${#QUERIES[@]} queries × ${WINDOW_DAYS}d window"
echo "  Tool URL : $GDELT_URL"
echo "  Session prefix: gdelt_exp_<slug>"
echo "  Each call is sequential with ${SPACING_SEC}s spacing (rate-limit hygiene)."
echo "  Estimated wall: ~$(( (${#QUERIES[@]} * SPACING_SEC) / 60 ))min"

TOTAL_OK=0
TOTAL_FAIL=0

for q in "${QUERIES[@]}"; do
  slug=$(slugify "$q")
  session_id="gdelt_exp_${slug}"
  out="$TMP/${slug}.json"

  body=$(jq -n \
    --arg topic "$q" \
    --argjson window "$WINDOW_DAYS" \
    --arg sess "$session_id" \
    '{topic: $topic, window_days: $window, agent_session_id: $sess}')

  http=$(curl -sS -X POST "$GDELT_URL" \
    -H 'Content-Type: application/json' \
    -d "$body" --max-time 90 \
    -o "$out" -w '%{http_code}' || echo "000")

  if [[ "$http" != "200" ]]; then
    errf "$q" "$http" "$(head -c 160 "$out")"
    TOTAL_FAIL=$((TOTAL_FAIL+1))
  else
    count=$(jq -r '.count // "?"' "$out")
    err=$(jq -r '.error // empty' "$out")
    if [[ -n "$err" ]]; then
      warn "$q" "$count" "tool error: $err"
    else
      ok "$q" "$count"
    fi
    TOTAL_OK=$((TOTAL_OK+1))
  fi

  sleep "$SPACING_SEC"
done

printf '\n\033[1m%d/%d queries fired successfully\033[0m\n' "$TOTAL_OK" "${#QUERIES[@]}"

cat <<EOF

═══════════════════════════════════════════════════════════════════════
Next: pull the experiment rows for scoring. Run this Snowflake query:

SELECT
  AGENT_SESSION_ID,
  SIGNAL_TITLE,
  URL,
  SIGNAL_TIMESTAMP
FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
WHERE AGENT_SESSION_ID LIKE 'gdelt_exp_%'
ORDER BY AGENT_SESSION_ID, INGESTED_AT DESC;

Score each row B (behavior-shaped) / L (listicle) / N (noise).
Winner threshold: ≥30% B-shaped per query → keep in production cron.

Cleanup after scoring:
  DELETE FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
  WHERE AGENT_SESSION_ID LIKE 'gdelt_exp_%';
═══════════════════════════════════════════════════════════════════════
EOF

[[ $TOTAL_FAIL -eq 0 ]] || exit 1
