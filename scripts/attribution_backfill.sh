#!/usr/bin/env bash
#
# attribution_backfill.sh — one-off fattening of thin trend clusters.
#
# The hourly attribution sweeper only looks at signals embedded in the last
# 24h, so trends that were promoted thin (cluster_size 2-3) can't be
# backfilled from older matching signals by normal rotation. This driver
# POSTs each thin trend to the attribution subagent with a wide
# lookback_hours window, letting the LLM-confirm step pull in historical
# matches. Idempotent: the subagent's commit step has a NOT EXISTS guard,
# so re-running never double-links.
#
# NOTE on LIMIT 20: the subagent shows the LLM only the top-20-by-similarity
# candidates per call. A trend with 60 genuine historical matches gets <=20
# in one pass — re-run the driver (or let rotation catch up) to pull the
# rest; the NOT EXISTS guard makes subsequent passes pick up where this
# left off.
#
# Usage:
#   scripts/attribution_backfill.sh [MAX_CLUSTER_SIZE] [LOOKBACK_HOURS]
# Defaults: MAX_CLUSTER_SIZE=4  LOOKBACK_HOURS=720 (30d)

set -euo pipefail

MAX_CLUSTER_SIZE="${1:-4}"
LOOKBACK_HOURS="${2:-720}"
BUDGET_USD="${BUDGET_USD:-0.06}"
SUBAGENT_URL="https://eozqgr1dhwf0akq.m.pipedream.net"
BATCH_SIZE="${BATCH_SIZE:-6}"
TRIGGER_TIMEOUT="${TRIGGER_TIMEOUT:-180}"

echo "attribution backfill: cluster_size<=${MAX_CLUSTER_SIZE} lookback=${LOOKBACK_HOURS}h budget=\$${BUDGET_USD} batch=${BATCH_SIZE}"

# Select thin, active trends that have an enrichment vector (subagent
# early-exits without one, so skip those to avoid wasted calls).
read -r -d '' SELECT_SQL <<SQL || true
WITH tv AS (
  SELECT DISTINCT TREND_ID
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_VECTOR IS NOT NULL
)
SELECT d.TREND_ID
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD d
JOIN tv ON tv.TREND_ID = d.TREND_ID
WHERE d.LIFECYCLE_STATUS NOT IN ('RETIRED','DORMANT')
  AND d.TOTAL_CLUSTER_SIZE <= ${MAX_CLUSTER_SIZE}
ORDER BY d.TOTAL_CLUSTER_SIZE ASC;
SQL

mapfile -t TRENDS < <(snowsql -o output_format=tsv -o header=false -o timing=false -o friendly=false -q "$SELECT_SQL" | grep -E '^[0-9a-fA-F-]{36}$')

COUNT="${#TRENDS[@]}"
echo "selected ${COUNT} thin trends to backfill"
if [[ "$COUNT" -eq 0 ]]; then
  echo "nothing to do"
  exit 0
fi

fire() {
  local tid="$1"
  local resp
  resp="$(curl -sS -X POST "$SUBAGENT_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"trend_id\":\"${tid}\",\"lookback_hours\":${LOOKBACK_HOURS},\"budget_usd\":${BUDGET_USD}}" \
    --max-time "$TRIGGER_TIMEOUT" 2>/dev/null || echo '{"error":"timeout_or_curl_fail"}')"
  local committed
  committed="$(echo "$resp" | grep -oE '"committed_count":"?[0-9]+"?' | grep -oE '[0-9]+' | head -1)"
  echo "  ${tid}  committed=${committed:-?}"
}

i=0
for tid in "${TRENDS[@]}"; do
  fire "$tid" &
  i=$((i + 1))
  if (( i % BATCH_SIZE == 0 )); then
    wait
    sleep 2
  fi
done
wait

echo "backfill dispatch complete (${COUNT} trends). Verify cluster growth in FCT_TREND_SIGNALS / DT_TREND_DASHBOARD (15-min lag)."
