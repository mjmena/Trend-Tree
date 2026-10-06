# Reddit enters by vendor scrape while the official Data API is stalled

**Status:** accepted (2026-09-07)

## Context

The expand-intake-sources map (CRMA-977) set an API-first, scrape-fallback
precedence for new sources. For Reddit, research (CRMA-978, 2026-09-06) found:

- **Official Data API**: technically ideal — `/r/{sub}/new`, `/top?t=day`,
  `/rising` are exactly the shapes a passive cron ingester wants, and our
  ~22k calls/mo is trivial against the 100 QPM ceiling. But free access is
  non-commercial only, a "Responsible Builder Policy" (since ~2026-06) gates
  all access behind a 2–4-week approval queue, and third-party reports put
  the commercial floor at ~$12k/mo regardless of call volume. McClatchy has
  already sent a commercial-access inquiry to Reddit and received **no
  response** — the API-first route is blocked by silence, not by a quoted
  price.
- **Unauthenticated `.json` endpoints**: dead. Deprecated ~2026-05-28;
  verified 403 on every probe (TLS fingerprinting, datacenter-IP blocks).
- **Vendor scrape**: viable at ~$20–50/mo for ~15k posts/mo. Post-level
  items (title, selftext, subreddit, score, permalink) pass both hard
  requirements: specificity (posts are sentence-grade claims — categorically
  better than the hashtag-level shape that failed the distillation rubric
  for TikTok, #18) and evidence purity (every item carries a canonical
  public permalink).

Scraping Reddit sits against Reddit's ToS. Waiting for Reddit means the
platform contributes nothing for an unbounded period, on the say-so of a
party that has not replied.

## Decision

Reddit enters as a **direct platform source** fed by a **vendor scrape**
through the shared scraping tool (a commercial scraping API behind a thin
internal service — vendor selection is CRMA-985's call), while the official
API path stays open in parallel:

- **Surfaces**: post-level records from curated subreddits via the `new`
  and `top?t=day` sorts. Native `rising` is welcome where the chosen vendor
  exposes it, but it is **not a hard requirement** — "rising" is derivable
  by re-polling `new`-sort snapshots and computing acceleration, the same
  delta math that produces upvote velocity. Binding the vendor choice to
  one sort order would trade legal posture for a computation we can do
  ourselves.
- **Risk acceptance and mitigations**: the scrape is limited to public
  data; the vendor decision weighs legal defensibility explicitly; the
  route carries audit-agent freshness coverage (per the map's standing
  constraint for every approved scrape route).
- **Standing switch intent**: the commercial-API inquiry to Reddit stays
  open. If Reddit responds with workable terms, the ingester moves to the
  official Data API — the scrape is the fallback the precedence names, not
  a preference.

## Considered options (and why rejected)

- **Wait for Reddit's reply before ingesting**: unbounded delay for zero
  signal; the counterparty has already let one inquiry sit unanswered.
- **Rule Reddit out**: unsupported — the data shape is among the best
  surveyed, and cost is trivial.
- **Unauthenticated `.json`**: nonfunctional (403) and architecturally
  hostile going forward; struck from the map.
- **Require native `rising` from the vendor**: constrains CRMA-985 away
  from the most legally defensible vendors for a derivable computation.

## Consequences

- A ToS-adverse route is knowingly in production for Reddit; the vendor's
  legal posture is part of the mitigation, so CRMA-985 must weigh it, not
  just price and coverage.
- The scraped surface can vanish or change without notice (the TikTok
  Creative Center precedent), so freshness monitoring is a launch
  requirement, not an enhancement.
- A later switch to the official API is a swap of the fetch layer only —
  the decided data shape (post-level records, permalink evidence, derived
  velocity) is available identically from both routes by design.
- A `search-reddit` agent search tool is **not** part of this decision —
  it would be a separate lane needing its own justification.
