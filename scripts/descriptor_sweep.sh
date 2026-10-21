#!/usr/bin/env bash
#
# descriptor_sweep.sh — active-only re-enrichment sweep (ADR-0003, CRMA-463).
#
# Re-runs the full dispatcher chain (sources -> enrichment -> write) for every
# ACTIVE trend whose current TREND_VECTOR is still on the legacy recipe, so it
# gains a `descriptor` and a vector embedded from `descriptor.statement`.
#
# "Current vector" = the latest FCT_TREND_ENRICHMENT_LEDGER row with a non-null
# TREND_VECTOR (what DT_TREND_DASHBOARD's trend_vectors CTE reads). That row's
# vector was embedded at write time by PROC_ENRICHMENT_APPLY from
# FN_TREND_EMBED_DOC(payload): descriptor.statement when present, else the
# legacy topic|summary|drivers|narrative doc. So a trend needs the sweep iff
# that row's PAYLOAD:descriptor:statement is empty.
#
# Idempotent: selection is by "still lacks a statement-based vector", so a
# re-run only fires the trends that have not landed yet (failures included).
#
# Name safety (ADR-0001): the write step calls PROC_ENRICHMENT_APPLY with
# KIND='initial', which sets FCT_TRENDS.TREND_NAME when it is NULL. Active
# trends with a NULL TREND_NAME are shown in ATLAS under their legacy B2C/B2B
# name, so re-enriching them RENAMES the card. They are excluded by default;
# INCLUDE_UNNAMED=1 opts them in (a product decision, not this script's).
#
# Usage:
#   scripts/descriptor_sweep.sh            # fire the remaining set
#   DRY_RUN=1 scripts/descriptor_sweep.sh  # list the remaining set, fire nothing
# Env:
#   CONCURRENCY=3        max dispatcher chains in flight (keep <=3)
#   MAX_TRENDS=240       refuse to start above this many (240 x ~$0.25 = $60)
#   INCLUDE_UNNAMED=0    1 = also sweep active trends with NULL TREND_NAME (renames them)
#   SNOW_CONN=claude     snow CLI connection name
#   LOG_DIR=/tmp         per-run TSV log lands here
#
# Verify by rows landed, not by this script's output: re-run with DRY_RUN=1
# after the sweep (and after DT_TREND_DASHBOARD's 15-min lag for the
# dashboard view); the remaining count should be 0.

set -euo pipefail

DISPATCHER_URL="https://eoqf5zok2vcvael.m.pipedream.net"
TRIGGER_TIMEOUT="${TRIGGER_TIMEOUT:-600}"

# ── worker mode: fire one trend, print one TSV line ──────────────────────
if [[ "${1:-}" == "--fire-one" ]]; then
  tid="$2"
  started=$(date +%s)
  body_file="$(mktemp)"
  code="$(curl -sS -o "$body_file" -w '%{http_code}' -X POST "$DISPATCHER_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"trend_id\":\"${tid}\"}" \
    --max-time "$TRIGGER_TIMEOUT" 2>/dev/null || echo "000")"
  secs=$(( $(date +%s) - started ))
  ok="$(jq -r 'if has("ok") then (.ok|tostring) else "?" end' "$body_file" 2>/dev/null || echo "?")"
  stage="$(jq -r '.stage // "?"' "$body_file" 2>/dev/null || echo "?")"
  err="$(jq -r '.error_message // ""' "$body_file" 2>/dev/null | tr '\t\n' '  ' | cut -c1-200 || true)"
  rm -f "$body_file"
  printf '%s\t%s\t%s\t%s\t%ss\t%s\n' "$(date -u +%FT%TZ)" "$tid" "$code" "ok=${ok}/${stage}" "$secs" "$err"
  exit 0
fi

CONCURRENCY="${CONCURRENCY:-3}"
MAX_TRENDS="${MAX_TRENDS:-240}"
INCLUDE_UNNAMED="${INCLUDE_UNNAMED:-0}"
SNOW_CONN="${SNOW_CONN:-claude}"
LOG_DIR="${LOG_DIR:-/tmp}"
DRY_RUN="${DRY_RUN:-0}"

if (( CONCURRENCY > 3 )); then
  echo "CONCURRENCY capped at 3 (was ${CONCURRENCY})" >&2
  CONCURRENCY=3
fi

NAME_FILTER="AND t.TREND_NAME IS NOT NULL"
[[ "$INCLUDE_UNNAMED" == "1" ]] && NAME_FILTER=""

# The selection query. Also documented in docs/adr/0003-trend-descriptor-sweep-sample.md.
read -r -d '' SELECT_SQL <<SQL || true
WITH active AS (
  SELECT TREND_ID, HEAT_INDEX
  FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD
  WHERE LIFECYCLE_STATUS IN ('NEW','GROWING','STABLE','RESURGENT')
),
latest_vec AS (
  SELECT TREND_ID, NULLIF(TRIM(PAYLOAD:descriptor:statement::STRING), '') AS STMT
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_VECTOR IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) = 1
)
SELECT a.TREND_ID
FROM active a
JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = a.TREND_ID
LEFT JOIN latest_vec lv ON lv.TREND_ID = a.TREND_ID
WHERE lv.STMT IS NULL
  ${NAME_FILTER}
ORDER BY a.HEAT_INDEX DESC
SQL

TRENDS="$(snow sql -c "$SNOW_CONN" -q "$SELECT_SQL" --format json \
  | jq -r '.[].TREND_ID' | grep -E '^[0-9a-fA-F-]{36}$' || true)"
COUNT=$(printf '%s' "$TRENDS" | grep -c . || true)

echo "descriptor sweep: ${COUNT} active trend(s) still on the legacy vector recipe (include_unnamed=${INCLUDE_UNNAMED})"
if [[ "$COUNT" -eq 0 ]]; then
  echo "nothing to do"
  exit 0
fi
if [[ "$DRY_RUN" == "1" ]]; then
  printf '%s\n' "$TRENDS"
  exit 0
fi
if (( COUNT > MAX_TRENDS )); then
  echo "refusing: ${COUNT} > MAX_TRENDS=${MAX_TRENDS} (cost guard, ~\$0.25/run)" >&2
  exit 1
fi

LOG="${LOG_DIR}/descriptor_sweep_$(date -u +%Y%m%dT%H%M%SZ).tsv"
echo "firing ${COUNT} dispatcher chain(s), ${CONCURRENCY} in flight; log: ${LOG}"
printf '%s\n' "$TRENDS" \
  | xargs -P "$CONCURRENCY" -n 1 "$0" --fire-one \
  | tee "$LOG"

echo "done. http-200 lines: $(grep -c $'\t200\t' "$LOG" || true)/${COUNT}"
echo "verify with: DRY_RUN=1 $0   (target: 0 remaining)"
