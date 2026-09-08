# TikTok reopens as vendor-scraped video-level records

**Status:** accepted (2026-09-07); **superseded (2026-09-08) by
[ADR-0009](0009-tiktok-two-lane-posture-curated-creator-list.md)** — see
CRMA-1021, CRMA-1023 and CRMA-1024. Do not implement from this ADR. Six of the
decisions below have moved: the role framing (emergence detection ->
corroboration and evidence breadth), the freshness guard (~7 days -> a 90-day
backfill ceiling over a rolling pull window), the volume target (requirement ->
dropped; the list is sized by curation capacity), the query posture (the
hashtag-page funnel has no working surface; `profile_url` is the spine), the
cost model (~$1-2/1k is the delivered price, not the usable one), and where the
curated lists live (repo files -> a Snowflake table). Role B, the
`search-tiktok` agent search tool, was settled separately on CRMA-1005.

## Context

TikTok was retired as a source on 2026-06-09: the Creative Center hashtag
scraper (`ingestion/tiktok-p_yKCm9Am`) died structurally — the scraped page
301s to "TikTok One Creative Suite" and the `creative_radar_api` XHR is
gone — and its hashtag-level output had already failed the distillation
specificity rubric (#18). The expand-intake-sources map (CRMA-977) set a
reopen condition: a data shape materially different from hashtags that can
plausibly pass the rubric.

Research (CRMA-979, 2026-09-06) found exactly one shape that clears it:

- **Official Research API**: right shape (video-level), wrong eligibility —
  academic / EU-nonprofit only, and eligibility narrowed through 2025–26. A
  US commercial media company does not qualify. Dead end.
- **Creative Center / TikTok One**: surviving trend surfaces (hashtags,
  songs, creators, products) are all topic-bucket-coarse; the small
  trending-videos pane has no API, and scraping the rebuilt page reproduces
  the fragility that killed the old ingester. The Display API returns only
  an authorized user's own videos.
- **Vendor scrape**: keyword- or hashtag-driven **video-level records** —
  description text, sound name+author, author profile, engagement counts,
  timestamp, public tiktok.com URL — at ~$1–2/1k videos. A video
  description narrating a concrete practice is the rubric's own example of
  a pass, and every record carries a verifiable public URL (evidence
  purity). Durability risk is priced, not structural: individual actors
  break on TikTok changes, but the vendor market repairs fast.

The map's API-first, scrape-fallback precedence therefore collapses for
TikTok to scrape-or-nothing. Scraping TikTok sits against its ToS.

## Decision

TikTok reopens as a **direct platform source** fed by a **vendor scrape**
through the shared scraping tool, **conditional on the vendor decision
(CRMA-985) delivering acceptable durability terms** — if it does not, the
reopen lapses back to retired with no new decision needed.

- **Partial reversal only**: hashtag-class **output** (records that *are*
  hashtags or other topic buckets) stays ruled out — the #18 rubric
  failure stands. A hashtag used as an **input funnel** that yields
  video-level records is the passing shape: input funnel and output shape
  are independent axes.
- **Query posture (role A, the ingester)**: hybrid, hashtag-funnel-first —
  a curated set of broad vertical hashtags as the ambient base (the
  analogue of Reddit's curated subreddits), plus a small curated keyword
  list for named practices. Both lists are human-maintained in the repo;
  **pipeline-derived queries are ruled out** by evidence purity (an
  ingester sent to find support for system-authored claims violates the
  invariant in spirit). Guards: a pre-write post-date freshness filter
  (~7 days), because both funnels rank by engagement rather than recency,
  and pre-write filtering so only rubric-plausible records land. Initial
  scale: a few hundred videos/day (~$5–15/mo).
- **Second role named (role B)**: a `search-tiktok` **agent search tool** —
  first-party short-video grounding for the distillation and enrichment
  agents, a lane no existing tool covers. Judged the **higher-quality**
  role of the two, but decided in its own ticket blocked by CRMA-985,
  because it hangs on pilot-measurable facts (actor latency against the
  enrichment loop's ~3–5 min budget; per-call cost). The keyword-search
  input mode that is weak for ambient intake is exactly right for a tool
  answering a supplied query.
- **Risk acceptance and mitigations**: the scrape is limited to public
  data; the vendor decision weighs legal defensibility explicitly; the
  route carries audit-agent freshness coverage as a launch requirement
  (per the map's standing constraint for every approved scrape route).

## Considered options (and why rejected)

- **Stay retired**: unsupported once the shape cleared — video-level
  records are first-party evidence of concrete practices; the Grok
  discovery lane sees only the echo on X.
- **Official Research API**: categorically closed to commercial
  applicants; misusing academic credentials risks total access loss.
- **Re-scrape Creative Center / TikTok One**: hashtag/leaderboard-coarse
  (fails the rubric) and repeats the structural fragility that killed the
  first ingester.
- **Keyword-only query posture**: a passive discovery ingester that only
  finds what it already thought to ask about — the discovery paradox.
  Keyword search belongs to role B, where the agent supplies the query.
- **Pipeline-derived queries**: violates evidence purity.
- **Corroboration-oracle or per-trend-metrics roles**: deferred — TikTok
  search returns something for almost any query, so a match is a weak
  verdict next to Exploding Topics (ADR-0004); the metrics role has no
  score consumer, and attribution grows a trend's TikTok evidence
  organically.

## Consequences

- A second ToS-adverse route is knowingly headed for production; the
  vendor's legal posture is part of the mitigation, so CRMA-985 must weigh
  it, and must also cover TikTok's hashtag + keyword-search surfaces,
  verify post-date filtering / recency sorting on both input modes in the
  paid pilot, and treat role B's latency and per-call cost as first-class
  criteria.
- The scraped surface can vanish or change without notice (the Creative
  Center precedent), so freshness monitoring (CRMA-989) is a launch
  requirement, not an enhancement.
- The reopen is reversible by construction: it lapses if CRMA-985 finds no
  acceptable vendor, and the ingester's curated lists mean shutting the
  source off is config removal, not schema surgery.
- TikTok Shop / product sourcing stays out of scope — the sourcing tier's
  multi-tier contract owns it, the same boundary that keeps Kickstarter
  signals-only.
