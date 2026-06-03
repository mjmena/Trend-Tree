#!/usr/bin/env bash
# GDELT category experiment — DIRECT-API variant.
#
# Bypasses the Pipedream `ingest_search_gdelt` tool (whose egress IP is
# currently being rate-limited by GDELT) and calls the GDELT DOC API
# straight from the local machine. No Snowflake roundtrip — titles are
# scored inline by inspection of the printed output.
#
# Usage:
#   bash scripts/gdelt_category_experiment_direct.sh           # all queries
#   bash scripts/gdelt_category_experiment_direct.sh --tsv     # tab-separated for scoring
#   bash scripts/gdelt_category_experiment_direct.sh "Q1" "Q2" # just these
#
# Sister script: gdelt_category_experiment.sh (Pipedream-tool path —
# currently blocked by IP rate-limit; revive when the IP cools down or
# the tool gets a UA/User-Agent rotation upgrade).
#
# Plan reference: /home/marty/.claude/plans/transient-splashing-gem.md
# (Phase A — sections A1, A2, A3).

set -euo pipefail

GDELT_URL="https://api.gdeltproject.org/api/v2/doc/doc"
WINDOW_DAYS=7
MAX_RECORDS=75
SPACING_SEC="${SPACING_SEC:-5}"   # gentle spacing — direct-IP rate limits are looser
UA='Mozilla/5.0 (compatible; TrendTreeBot/1.0; +https://mcclatchy.com)'

EXCLUDED_DOMAINS_REGEX='wnd\.com|breitbart\.com|foxnews\.com|cnn\.com|msnbc\.com|dailymail\.co\.uk|tmz\.com|dailypolitical\.com|tickerreport\.com|aol\.com|finance\.yahoo\.com|marketwatch\.com|benzinga\.com|seekingalpha\.com|investorplace\.com'

DEFAULT_QUERIES=(
  "GLP-1 lifestyle change"
  "sober curious movement"
  "dupe culture Amazon"
  "Y2K fashion comeback 2026"
  "K-beauty viral product"
  "viral TikTok product 2026"
  "daily supplement stack adults"
  "workout recovery wearable"
  "wellness trends"
)

OUTPUT_TSV=false
QUERIES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tsv) OUTPUT_TSV=true; shift ;;
    *) QUERIES+=("$1"); shift ;;
  esac
done
if [[ ${#QUERIES[@]} -eq 0 ]]; then QUERIES=("${DEFAULT_QUERIES[@]}"); fi

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

if [[ "$OUTPUT_TSV" != true ]]; then
  printf '\n\033[1;36m=== GDELT direct-API experiment — %d queries × %dd window ===\033[0m\n' "${#QUERIES[@]}" "$WINDOW_DAYS"
  echo "  Endpoint : $GDELT_URL"
  echo "  Spacing  : ${SPACING_SEC}s between calls"
  echo "  Filter   : ${EXCLUDED_DOMAINS_REGEX//|/, }"
  echo
fi

for q in "${QUERIES[@]}"; do
  query="${q} sourcecountry:US sourcelang:english"
  out="$TMP/$(echo "$q" | tr ' /' '__').json"

  http=$(curl -sS -G "$GDELT_URL" \
    --data-urlencode "query=$query" \
    --data-urlencode "mode=ArtList" \
    --data-urlencode "format=json" \
    --data-urlencode "maxrecords=$MAX_RECORDS" \
    --data-urlencode "timespan=${WINDOW_DAYS}d" \
    -H "User-Agent: $UA" \
    -H "Accept: application/json" \
    -o "$out" -w '%{http_code}' --max-time 30 || echo "000")

  if [[ "$http" != "200" ]]; then
    [[ "$OUTPUT_TSV" != true ]] && printf '\033[1;31m✗\033[0m %-40s HTTP=%s\n' "$q" "$http"
    sleep "$SPACING_SEC"
    continue
  fi

  # Some GDELT errors come back as text (rate-limit messages) with HTTP 200.
  if ! head -c 1 "$out" | grep -q '[{[]'; then
    [[ "$OUTPUT_TSV" != true ]] && printf '\033[1;33m!\033[0m %-40s rate-limit text response\n' "$q"
    sleep "$SPACING_SEC"
    continue
  fi

  # Filter to allowed domains, English only, dedupe by URL.
  filtered=$(jq --arg banned "$EXCLUDED_DOMAINS_REGEX" '
    [.articles[]?
     | select((.language // "english") | ascii_downcase == "english")
     | select((.domain // "") | test($banned) | not)]
    | unique_by(.url)
  ' "$out")
  count=$(echo "$filtered" | jq 'length')

  if [[ "$OUTPUT_TSV" == true ]]; then
    echo "$filtered" | jq -r --arg q "$q" '.[] | [$q, .domain, .title, .url] | @tsv'
  else
    printf '\n\033[1;32m●\033[0m %s — %d articles\n' "$q" "$count"
    echo "$filtered" | jq -r '.[] | "    [\(.domain)] \(.title)"' | head -30
  fi

  sleep "$SPACING_SEC"
done

if [[ "$OUTPUT_TSV" != true ]]; then
  cat <<'EOF'

═══════════════════════════════════════════════════════════════════════
Score each title B / L / N:
  B = behavior-shaped (specific named behavior, product, or aesthetic moment)
  L = listicle ("X best Y of 2026")
  N = noise (local PR, celebrity, earnings, irrelevant)

Per-query winner threshold: ≥30% B → keep that query in production cron.

For machine-scoring, re-run with --tsv and pipe to your tool of choice.
═══════════════════════════════════════════════════════════════════════
EOF
fi
