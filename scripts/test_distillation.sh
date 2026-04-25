#!/usr/bin/env bash
# Bottom-up smoke test for the Phase 1 distillation pipeline.
#
# Tests in dependency order:
#   1. ingest_search_bluesky          (~6-8s)
#   2. ingest_search_gdelt            (~20-30s)
#   3. ingest_search_google_trends    (~30-50s, slow)
#   4. ingest_grok_live_search        (~3-5s)
#   5. distillation subagent (dry_run)  — no Anthropic call, ~1s
#   6. distillation subagent (real)     — full agent loop, ~30-90s
#   7. distillation lead (dry_run)      — pre-fetch SQL only, ~5-10s
#   8. distillation lead (real)         — full agent + fanout, 2-10 min
#
# Usage:
#   bash scripts/test_distillation.sh                 # full run (10-15 min)
#   bash scripts/test_distillation.sh --quick         # skip gtrends + real lead
#   bash scripts/test_distillation.sh --errors-only   # deliberate-error tests
#   bash scripts/test_distillation.sh --through subagent_real   # stop after step
#
# Each test asserts on response shape via jq -e. Script exits non-zero on
# the first failure. Snowflake checks happen via snowsql; you'll need a
# valid ~/.snowsql/config and a connection that can SELECT from
# MCC_RAW.MARKETING_DEV (CRMBOT_SERVICE_USER works).

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Endpoints — keep in sync with workflow.yaml props on lead/subagent
# ─────────────────────────────────────────────────────────────────────
LEAD_URL="https://eo8lg4tmkchk2qc.m.pipedream.net"
SUBAGENT_URL="https://eo5h5le4j2qu3tm.m.pipedream.net"
BLUESKY_URL="https://eoydyalz1dslfre.m.pipedream.net"
GDELT_URL="https://eoovhehfk229jrg.m.pipedream.net"
GTRENDS_URL="https://eov9u8rngcgi2z6.m.pipedream.net"
GROK_URL="https://eovzc5ljf76h3h6.m.pipedream.net"

# ─────────────────────────────────────────────────────────────────────
# CLI flags
# ─────────────────────────────────────────────────────────────────────
QUICK=false
ERRORS_ONLY=false
THROUGH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)        QUICK=true ;;
    --errors-only)  ERRORS_ONLY=true ;;
    --through)      THROUGH="$2"; shift ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

SESSION_ID="smoke-$(date +%s)"
PASS=0
FAIL=0
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────
say()  { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }

# post URL TIMEOUT BODY OUTFILE — exits non-zero if HTTP not 2xx
post() {
  local url="$1" timeout="$2" body="$3" out="$4"
  local code
  code=$(curl -sS -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d "$body" --max-time "$timeout" \
    -o "$out" -w '%{http_code}' || echo "000")
  echo "$code"
}

# expect_through STAGE — true if we should run this stage
expect_through() {
  [[ -z "$THROUGH" || "$THROUGH" == "$1" || "$AFTER_THROUGH" == false ]]
}
AFTER_THROUGH=false

# assert_jq OUTFILE FILTER MESSAGE — runs jq -e; ok or fail
assert_jq() {
  local out="$1" filter="$2" msg="$3"
  if jq -e "$filter" "$out" >/dev/null 2>&1; then
    ok "$msg"
  else
    fail "$msg (got: $(jq -c '. | if type == "object" then {keys: (keys|sort)} else . end' "$out" 2>&1 | head -c 240))"
  fi
}

# ─────────────────────────────────────────────────────────────────────
# Deliberate-error tests (skip with default mode)
# ─────────────────────────────────────────────────────────────────────
run_error_tests() {
  say "Deliberate error: bluesky tool with empty body"
  CODE=$(post "$BLUESKY_URL" 30 '{}' "$TMP/err1.json")
  if [[ "$CODE" == "4"* ]] || jq -e '.error // empty' "$TMP/err1.json" >/dev/null 2>&1; then
    ok "got 4xx or error response (HTTP $CODE)"
  else
    fail "expected 4xx or {error}, got HTTP $CODE — $(head -c 200 "$TMP/err1.json")"
  fi

  say "Deliberate error: subagent with bucket=INVALID"
  CODE=$(post "$SUBAGENT_URL" 30 \
    '{"hypothesis":"x","signal_ids":["bsky_test"],"bucket":"INVALID"}' "$TMP/err2.json")
  if [[ "$CODE" == "4"* ]] || [[ "$CODE" == "5"* ]]; then
    ok "got expected non-2xx (HTTP $CODE)"
  else
    fail "expected non-2xx, got HTTP $CODE — $(head -c 200 "$TMP/err2.json")"
  fi

  say "Errors should appear on Pipedream's error endpoint within ~5s"
  echo "  Check via: curl -sS 'https://api.pipedream.com/v1/workflows/<id>/%24errors/event_summaries?org_id=o_qOIvyEa&limit=5&expand=event' -H \"Authorization: Bearer \$PIPEDREAM_API_KEY\" | jq"
}

if [[ "$ERRORS_ONLY" == true ]]; then
  run_error_tests
  printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
  exit "$FAIL"
fi

# ─────────────────────────────────────────────────────────────────────
# 1. ingest_search_bluesky
# ─────────────────────────────────────────────────────────────────────
say "1/8  ingest_search_bluesky"
post "$BLUESKY_URL" 30 \
  "{\"query\":\"cottage cheese protein\",\"limit\":10,\"agent_session_id\":\"$SESSION_ID\"}" \
  "$TMP/bluesky.json" >/dev/null
assert_jq "$TMP/bluesky.json" '.tool == "ingest_search_bluesky"'    "tool name in response"
assert_jq "$TMP/bluesky.json" '.count >= 0'                         "count present"
assert_jq "$TMP/bluesky.json" '.posts | type == "array"'            "posts is array"
assert_jq "$TMP/bluesky.json" '.persisted_to_snowflake == true'     "snowflake write succeeded"
[[ "$THROUGH" == "bluesky" ]] && AFTER_THROUGH=true

# ─────────────────────────────────────────────────────────────────────
# 2. ingest_search_gdelt
# ─────────────────────────────────────────────────────────────────────
if [[ "$AFTER_THROUGH" == false ]]; then
  say "2/8  ingest_search_gdelt"
  post "$GDELT_URL" 90 \
    "{\"topic\":\"cottage cheese protein\",\"window_days\":7,\"agent_session_id\":\"$SESSION_ID\"}" \
    "$TMP/gdelt.json" >/dev/null
  assert_jq "$TMP/gdelt.json" '.tool == "ingest_search_gdelt"'      "tool name in response"
  assert_jq "$TMP/gdelt.json" '.count >= 0'                         "count present"
  assert_jq "$TMP/gdelt.json" '.articles | type == "array"'         "articles is array"
  [[ "$THROUGH" == "gdelt" ]] && AFTER_THROUGH=true
fi

# ─────────────────────────────────────────────────────────────────────
# 3. ingest_search_google_trends (slow — skipped in --quick)
# ─────────────────────────────────────────────────────────────────────
if [[ "$AFTER_THROUGH" == false && "$QUICK" == false ]]; then
  say "3/8  ingest_search_google_trends (slow, ~30-50s)"
  post "$GTRENDS_URL" 120 \
    "{\"keyword\":\"cottage cheese\",\"geo\":\"US\",\"agent_session_id\":\"$SESSION_ID\"}" \
    "$TMP/gtrends.json" >/dev/null
  assert_jq "$TMP/gtrends.json" '.tool == "ingest_search_google_trends"' "tool name in response"
  assert_jq "$TMP/gtrends.json" '.related_queries | type == "array"'     "related_queries is array"
  [[ "$THROUGH" == "gtrends" ]] && AFTER_THROUGH=true
elif [[ "$QUICK" == true ]]; then
  say "3/8  ingest_search_google_trends — SKIPPED (--quick)"
fi

# ─────────────────────────────────────────────────────────────────────
# 4. ingest_grok_live_search
# ─────────────────────────────────────────────────────────────────────
if [[ "$AFTER_THROUGH" == false ]]; then
  say "4/8  ingest_grok_live_search"
  post "$GROK_URL" 60 \
    "{\"query\":\"cottage cheese protein snack trend\",\"mode\":\"both\",\"agent_session_id\":\"$SESSION_ID\"}" \
    "$TMP/grok.json" >/dev/null
  assert_jq "$TMP/grok.json" '.tool == "ingest_grok_live_search"'   "tool name in response"
  assert_jq "$TMP/grok.json" '.summary | type == "string"'          "summary is string"
  assert_jq "$TMP/grok.json" '.citations | type == "array"'         "citations is array"
  [[ "$THROUGH" == "grok" ]] && AFTER_THROUGH=true
fi

# Cross-check: how many signals were tagged with this session?
say "Snowflake check: signals tagged $SESSION_ID"
COUNT=$(snowsql -o friendly=false -o output_format=plain -o header=false -o timing=false \
  -q "SELECT COUNT(*) FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS WHERE AGENT_SESSION_ID='$SESSION_ID';" 2>/dev/null \
  | tail -1 | tr -d ' ' || echo "?")
if [[ "$COUNT" =~ ^[0-9]+$ && "$COUNT" -gt 0 ]]; then
  ok "$COUNT signals tagged with session $SESSION_ID"
else
  fail "expected >0 signals tagged with $SESSION_ID, got '$COUNT'"
fi

# ─────────────────────────────────────────────────────────────────────
# 5. subagent (dry_run)
# ─────────────────────────────────────────────────────────────────────
if [[ "$AFTER_THROUGH" == false ]]; then
  say "5/8  subagent dry_run"
  # Pick a real signal_id from the firehose to satisfy validation; signal must exist.
  SIG=$(snowsql -o friendly=false -o output_format=plain -o header=false -o timing=false \
    -q "SELECT SIGNAL_ID FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS WHERE SOURCE_NAME='bluesky' ORDER BY SIGNAL_TIMESTAMP DESC LIMIT 1;" 2>/dev/null \
    | tail -1 | tr -d ' ')
  if [[ -z "$SIG" ]]; then
    fail "no real signal_id found in STG_EXTERNAL_SIGNALS — cannot test subagent"
  else
    post "$SUBAGENT_URL" 30 \
      "{\"hypothesis\":\"Cottage cheese as protein-replacement snack\",\"signal_ids\":[\"$SIG\"],\"bucket\":\"AGENT_ONLY\",\"agent_session_id\":\"$SESSION_ID\",\"dry_run\":true}" \
      "$TMP/sub_dry.json" >/dev/null
    assert_jq "$TMP/sub_dry.json" '.verdict == "DRY_RUN"'           "verdict=DRY_RUN"
    assert_jq "$TMP/sub_dry.json" '.cost_usd == 0'                  "no Anthropic spend"
  fi
  [[ "$THROUGH" == "subagent_dry" ]] && AFTER_THROUGH=true
fi

# ─────────────────────────────────────────────────────────────────────
# 6. subagent (real, with ingest tool corroboration)
# ─────────────────────────────────────────────────────────────────────
if [[ "$AFTER_THROUGH" == false ]]; then
  say "6/8  subagent real (~30-90s — agent loop with ingest)"
  SIG=$(snowsql -o friendly=false -o output_format=plain -o header=false -o timing=false \
    -q "SELECT SIGNAL_ID FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS WHERE SOURCE_NAME='bluesky' ORDER BY SIGNAL_TIMESTAMP DESC LIMIT 1;" 2>/dev/null \
    | tail -1 | tr -d ' ')
  post "$SUBAGENT_URL" 240 \
    "{\"hypothesis\":\"Cottage cheese as protein-replacement snack\",\"signal_ids\":[\"$SIG\"],\"bucket\":\"AGENT_ONLY\",\"agent_session_id\":\"$SESSION_ID\"}" \
    "$TMP/sub_real.json" >/dev/null
  assert_jq "$TMP/sub_real.json" '.verdict as $v | ["REAL_TREND","REAL_TREND_SPLIT","NOISE","CATEGORY_TOO_BROAD"] | index($v) != null or ($v | startswith("DUPLICATE_OF"))' "verdict is one of the allowed values"
  assert_jq "$TMP/sub_real.json" '.turns >= 1'                      "agent ran ≥1 turn"
  assert_jq "$TMP/sub_real.json" '.cost_usd > 0'                    "Anthropic spend recorded"
  assert_jq "$TMP/sub_real.json" '.tool_calls | length >= 1'        "≥1 tool call recorded"
  echo "  verdict: $(jq -r .verdict "$TMP/sub_real.json"), turns: $(jq -r .turns "$TMP/sub_real.json"), cost: \$$(jq -r .cost_usd "$TMP/sub_real.json")"
  [[ "$THROUGH" == "subagent_real" ]] && AFTER_THROUGH=true
fi

# ─────────────────────────────────────────────────────────────────────
# 7. lead (dry_run) — exercises 4 SQL pre-fetches but skips Anthropic
# ─────────────────────────────────────────────────────────────────────
if [[ "$AFTER_THROUGH" == false ]]; then
  say "7/8  lead dry_run"
  post "$LEAD_URL" 60 '{"dry_run":true}' "$TMP/lead_dry.json" >/dev/null
  assert_jq "$TMP/lead_dry.json" '.tool == "distillation_lead"'     "tool name"
  assert_jq "$TMP/lead_dry.json" '.signals_seen >= 0'               "signals_seen present"
  assert_jq "$TMP/lead_dry.json" '.candidates_count == 0'           "no candidates in dry_run"
  assert_jq "$TMP/lead_dry.json" '.cost_usd == 0'                   "no Anthropic spend"
  echo "  signals_seen=$(jq -r .signals_seen "$TMP/lead_dry.json"), louvain_seen=$(jq -r .louvain_seen "$TMP/lead_dry.json")"
  [[ "$THROUGH" == "lead_dry" ]] && AFTER_THROUGH=true
fi

# ─────────────────────────────────────────────────────────────────────
# 8. lead (real) — full end-to-end (skipped in --quick)
# ─────────────────────────────────────────────────────────────────────
if [[ "$AFTER_THROUGH" == false && "$QUICK" == false ]]; then
  say "8/8  lead real (full end-to-end, 2-10 min)"
  post "$LEAD_URL" 720 '{"dry_run":false}' "$TMP/lead_real.json" >/dev/null
  assert_jq "$TMP/lead_real.json" '.tool == "distillation_lead"'    "tool name"
  assert_jq "$TMP/lead_real.json" '.signals_seen > 0'               "signals_seen > 0"
  assert_jq "$TMP/lead_real.json" '.cost_usd > 0'                   "Anthropic spend"
  assert_jq "$TMP/lead_real.json" '.candidates_persisted == true'   "candidates write succeeded"
  echo "  candidates=$(jq -r .candidates_count "$TMP/lead_real.json"), turns=$(jq -r .turns "$TMP/lead_real.json"), cost=\$$(jq -r .cost_usd "$TMP/lead_real.json"), wall=$(jq -r .run_duration_ms "$TMP/lead_real.json")ms"
elif [[ "$QUICK" == true ]]; then
  say "8/8  lead real — SKIPPED (--quick)"
fi

# ─────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────
printf '\n\033[1m%d passed, %d failed\033[0m  (session %s)\n' "$PASS" "$FAIL" "$SESSION_ID"
[[ $FAIL -eq 0 ]] || exit 1

cat <<EOF

Next checks (ad-hoc):
  snowsql -q "SELECT BUCKET, VERDICT, COUNT(*) FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES_AGENT WHERE CHAIN_ID LIKE '%${SESSION_ID:0:6}%' OR CREATED_AT > DATEADD(hour, -1, CURRENT_TIMESTAMP()) GROUP BY 1, 2;"
  snowsql -q "SELECT TOPIC, BUCKET, CONFIDENCE, SPECIFICITY_SCORE, REASONING FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES_AGENT ORDER BY CREATED_AT DESC LIMIT 20;"
EOF
