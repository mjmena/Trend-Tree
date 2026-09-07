#!/usr/bin/env bash
# CRMA-986 — the four Bright Data gate checks that precede provisioning.
#
# CRMA-985 chose Bright Data CONDITIONALLY. These four checks are the
# condition. A failure falls back PER PLATFORM to Apify, except check 3 which
# hits the whole vendor. Run this before creating the secret or deploying.
#
# Cost: Web Scraper API bills 1 credit per RECORD, Web Unlocker 1 per request.
# Every probe below caps itself at 3 records, so a full run costs well under 20
# of the 5,000 free monthly credits.
#
# Usage:  brightdata_gate_checks.sh            # key from macOS Keychain
#         BRIGHTDATA_API_KEY=... brightdata_gate_checks.sh
#
# The script never prints the key. Findings go to stdout; raw payloads are kept
# in $OUTDIR so a surprising result can be re-read rather than re-billed.
set -uo pipefail

OUTDIR="${OUTDIR:-${TMPDIR:-/tmp}/brightdata-gate-checks-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUTDIR"

KEY="${BRIGHTDATA_API_KEY:-$(security find-generic-password -s brightdata-api -w 2>/dev/null || true)}"
if [[ -z "$KEY" ]]; then
  cat >&2 <<'MSG'
No Bright Data API key found.

  Keychain (preferred, keeps the key out of shell history and transcripts):
    security add-generic-password -s brightdata-api -a "$USER" -w 'YOUR_KEY'

  Or for one run:
    BRIGHTDATA_API_KEY=... brightdata_gate_checks.sh
MSG
  exit 2
fi

BD="https://api.brightdata.com"
AUTH=(-H "Authorization: Bearer $KEY" -H "Content-Type: application/json")
DS_TIKTOK="gd_lu702nij2f790tmv9h"
DS_REDDIT="gd_lvz8ah06191smkebj4"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33m????\033[0m  %s\n' "$1"; }
note() { printf '        %s\n' "$1"; }
head1() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Bright Data's synchronous endpoint DOES support discovery (contrary to what
# CRMA-985 recorded) but caps at ~1 minute, answering 202 + snapshot_id on
# timeout. So: try sync, and fall back to the async poll on a 202. Every probe
# here is 3 records, which finishes inside the sync window in practice.
#
# $1 dataset_id  $2 discover_by  $3 json body  $4 label
scrape() {
  local ds="$1" by="$2" body="$3" label="$4"
  local raw="$OUTDIR/$label.json" code

  code=$(curl -sS -o "$raw" -w '%{http_code}' -X POST \
    "$BD/datasets/v3/scrape?dataset_id=$ds&type=discover_new&discover_by=$by&include_errors=true&format=json" \
    "${AUTH[@]}" -d "$body" --max-time 180 2>"$OUTDIR/$label.err")

  if [[ "$code" == "202" ]]; then
    local snap
    snap=$(jq -r '.snapshot_id // empty' "$raw" 2>/dev/null)
    [[ -z "$snap" ]] && { echo "202 with no snapshot_id" >&2; return 1; }
    note "sync window elapsed; polling snapshot $snap"
    for _ in $(seq 1 40); do
      sleep 15
      local st
      st=$(curl -sS "$BD/datasets/v3/progress/$snap" "${AUTH[@]}" --max-time 30 | jq -r '.status // "unknown"')
      case "$st" in
        ready) curl -sS "$BD/datasets/v3/snapshot/$snap?format=json" "${AUTH[@]}" --max-time 120 -o "$raw"; return 0 ;;
        failed|canceled) echo "snapshot $st" >&2; return 1 ;;
      esac
    done
    echo "snapshot still running after 10 min" >&2
    return 1
  fi

  [[ "$code" == "200" ]] || { echo "HTTP $code: $(head -c 300 "$raw")" >&2; return 1; }
  return 0
}

# ---------------------------------------------------------------------------
head1 "Check 1 — Reddit: can subreddit discovery express top-of-day?"
# CRMA-982 decided curated subreddits via `new` + `top?t=day`. The API
# reference for discover-by-subreddit-url documents exactly TWO input fields,
# `url` and `sort_by`, and no time filter of any kind. But Bright Data's docs
# are illustrative rather than exhaustive (the same caveat that keeps check 4
# open), so an undocumented time parameter cannot be ruled out from docs alone.
# Three probes: does an undocumented time field survive validation, what casing
# does sort_by accept, and is `Top` day-bounded in practice?

SUB='https://www.reddit.com/r/cooking/'

note "1a. probing for an undocumented time parameter"
if scrape "$DS_REDDIT" subreddit_url \
     "{\"input\":[{\"url\":\"$SUB\",\"sort_by\":\"Top\",\"date\":\"Past day\",\"t\":\"day\"}],\"limit_per_input\":3}" \
     reddit_time_param; then
  if jq -e '[.[]? | select(.warning? // .error? // empty)] | length > 0' "$OUTDIR/reddit_time_param.json" >/dev/null 2>&1; then
    warn "accepted the request but flagged a warning/error — read reddit_time_param.json"
  else
    warn "an undocumented time field was ACCEPTED without complaint"
    note "acceptance is not proof it was honoured — check 1c decides that"
  fi
else
  note "rejected: $(cat "$OUTDIR/reddit_time_param.err" 2>/dev/null | head -c 200)"
  note "consistent with the docs: no time parameter exists in this mode"
fi

note "1b. probing sort_by casing (docs contradict themselves: 'Hot' vs 'top')"
for v in Top top; do
  if scrape "$DS_REDDIT" subreddit_url \
       "{\"input\":[{\"url\":\"$SUB\",\"sort_by\":\"$v\"}],\"limit_per_input\":3}" "reddit_sort_$v"; then
    note "sort_by=\"$v\" accepted ($(jq 'length' "$OUTDIR/reddit_sort_$v.json" 2>/dev/null) records)"
  else
    note "sort_by=\"$v\" rejected: $(head -c 160 "$OUTDIR/reddit_sort_$v.err" 2>/dev/null)"
  fi
done

note "1c. is sort_by=Top day-bounded, or all-time?"
# This is the decisive one. An all-time Top listing is useless for trend
# detection — it returns the same canonical posts every pull. Day-bounded Top
# is what CRMA-982 actually wanted. Read the post timestamps and judge.
if [[ -s "$OUTDIR/reddit_sort_Top.json" ]]; then
  jq -r '[.[]? | (.date_posted // .created_at // .create_time // empty)] | .[]' \
    "$OUTDIR/reddit_sort_Top.json" 2>/dev/null | head -5 | while read -r ts; do
      note "  top post timestamp: $ts"
    done
  note "if these are months/years old, `Top` is all-time and check 1 FAILS"
else
  note "no Top records to inspect"
fi

# ---------------------------------------------------------------------------
head1 "Check 2 — Kickstarter: does Web Unlocker defeat Turnstile on ?format=json?"
# CRMA-984's route is the discover/advanced JSON surface. Bright Data claims
# Turnstile handling, but no doc addresses a NON-HTML response behind it.
# format=raw returns the target's body unmodified, so a JSON body coming back
# as JSON is the pass condition; a Turnstile interstitial (HTML) is the fail.
#
# NOTE: this needs a Web Unlocker ZONE to exist. Create one in the control
# panel first and pass its name as BD_ZONE.
ZONE="${BD_ZONE:-}"
if [[ -z "$ZONE" ]]; then
  warn "skipped — set BD_ZONE to your Web Unlocker zone name and re-run"
  note "Bright Data control panel -> Proxies & Scraping -> add a Web Unlocker zone"
else
  KS='https://www.kickstarter.com/discover/advanced?state=live&sort=newest&format=json'
  code=$(curl -sS -o "$OUTDIR/kickstarter_unlocker.txt" -w '%{http_code}' -X POST "$BD/request" \
    "${AUTH[@]}" --max-time 120 \
    -d "{\"zone\":\"$ZONE\",\"url\":\"$KS\",\"format\":\"raw\"}" 2>"$OUTDIR/kickstarter_unlocker.err")
  if [[ "$code" != "200" ]]; then
    fail "Web Unlocker returned HTTP $code"
    note "$(head -c 300 "$OUTDIR/kickstarter_unlocker.txt")"
  elif jq -e '.projects? // .total_hits? // empty' "$OUTDIR/kickstarter_unlocker.txt" >/dev/null 2>&1; then
    pass "JSON came back intact with a projects payload"
    note "projects in page: $(jq '.projects | length' "$OUTDIR/kickstarter_unlocker.txt" 2>/dev/null)"
    note "total_hits: $(jq -r '.total_hits // "n/a"' "$OUTDIR/kickstarter_unlocker.txt" 2>/dev/null)"
    # CRMA-984's traction gate needs the raised filter to survive the vendor
    # route. Confirm the fields it depends on are actually present.
    jq -e '.projects[0] | has("percent_funded") or has("pledged")' \
      "$OUTDIR/kickstarter_unlocker.txt" >/dev/null 2>&1 \
      && pass "traction fields (pledged / percent_funded) present" \
      || warn "traction fields absent — CRMA-984's raised filter may not survive"
  elif grep -qi 'turnstile\|cf-challenge\|just a moment\|challenge-platform' "$OUTDIR/kickstarter_unlocker.txt"; then
    fail "a Cloudflare/Turnstile challenge came back instead of JSON"
  else
    warn "200 but not the expected JSON — read kickstarter_unlocker.txt"
    note "first bytes: $(head -c 200 "$OUTDIR/kickstarter_unlocker.txt")"
  fi
fi

# ---------------------------------------------------------------------------
head1 "Check 3 — billing: is there really no PAYG monthly minimum?"
# Settled from the vendor's own billing docs during CRMA-986 research:
#   "No monthly minimum and no plan fee." Pre-paid — charged only for funds
#   explicitly deposited. Free tier is 5,000 credits per month, RECURRING
#   (reset on the 1st, no rollover), and a card is a verification step only.
# Source: https://docs.brightdata.com/general/account/billing-and-pricing/free-tier
pass "no monthly minimum, no plan fee — confirmed in vendor billing docs"
note "free tier is 5,000 credits/month recurring, not a one-off trial"
note "confirm once in the control panel's billing page that no plan is attached"

# ---------------------------------------------------------------------------
head1 "Check 4 — TikTok: does a Posts record carry a sound/music field?"
# CRMA-983 requires description + sound + engagement + URL; sound was part of
# what cleared the reopen condition. The documented field list omits it, but
# that list is illustrative, so only a real payload settles it.
if scrape "$DS_TIKTOK" keyword \
     '{"input":[{"search_keyword":"cottage cheese recipe"}],"limit_per_input":3}' tiktok_keyword; then
  jq -r '.[0] // {} | keys[]' "$OUTDIR/tiktok_keyword.json" > "$OUTDIR/tiktok_fields.txt" 2>/dev/null
  note "fields returned: $(tr '\n' ' ' < "$OUTDIR/tiktok_fields.txt")"
  if grep -Eiq '(^|_)(music|sound)(_|$)|music|sound' "$OUTDIR/tiktok_fields.txt"; then
    pass "a sound/music field is present: $(grep -Ei 'music|sound' "$OUTDIR/tiktok_fields.txt" | tr '\n' ' ')"
  else
    fail "no sound/music field in a real payload — CRMA-983 reopens"
  fi
  # The other three CRMA-983 requirements, checked on the same payload.
  for f in description video_url play_count; do
    jq -e --arg f "$f" '.[0] | has($f)' "$OUTDIR/tiktok_keyword.json" >/dev/null 2>&1 \
      && note "  $f present" || warn "  $f MISSING"
  done
else
  fail "TikTok keyword discovery did not return: $(head -c 200 "$OUTDIR/tiktok_keyword.err" 2>/dev/null)"
fi

head1 "Raw payloads kept in:"
note "$OUTDIR"
