<!-- map: CRMA-1315 -->

# SerpApi sources for TikTok, Reddit, and Kickstarter

## Destination

A spec at `docs/prd/serpapi-sources.md` that says which of TikTok, Reddit, and
Kickstarter enter the pipeline through SerpApi, and in which role: direct
platform source, agent search tool, or oracle (the three roles `CONTEXT.md`
defines). The map stops at the spec; `/to-tickets` cuts the build from it.

## Notes

- **The gap these sources fill** (agreed at charting, 2026-09-27): early
  consumer and product signal. Discovery covers social (Bluesky, `grok_live`),
  news (GDELT) and demand (Google Trends). Nothing covers forum discussion
  (Reddit) or pre-retail products (Kickstarter), and the TikTok lane is thin
  since `ingestion/tiktok-p_yKCm9Am` was deactivated on 2026-06-09. Judge every
  candidate on how *early* its results are, not on volume.
- Use the `CONTEXT.md` terms exactly: [source], [agent search tool], [oracle],
  [publisher], source family, provenance invariant.
- Grilling tickets use `/grilling` and `/domain-modeling`. Give a written
  recommendation with its reasoning, not multiple-choice option cards.
- The SerpApi key is in the macOS Keychain as service `serpapi-api`.

## Established facts

- The repo has no SerpApi code as of 2026-09-27 (grep over the tree).
- The TikTok Creative Center scraper failed twice: TikTok retired the page
  (301 to "TikTok One Creative Suite"), and its hashtag-level output never met
  the distillation specificity rubric (#18). Source: `CLAUDE.md`, 2026-06-09.
- SerpApi has no TikTok, Reddit, or Kickstarter engine; every path goes through
  Google, needs a query, and offers no "top" or "trending" feed. Best shapes:
  TikTok `engine=google_short_videos` + `site:tiktok.com <topic>` + `tbs=qdr:w`
  (12/12 fresh, no date field, post time decodable from the video ID); Reddit
  `engine=google_forums` or `site:reddit.com` (thin recent coverage, comment
  count but no score); Kickstarter `site:kickstarter.com/projects` (mostly
  funded-project updates, crawl date only). Source: CRMA-1316 live calls,
  2026-09-27, `docs/wayfinder/assets/crma-1316-serpapi-coverage.md`.
- The SerpApi key belongs to the shared `dev@trendhunter.com` account: $275/mo
  for 30,000 searches (~$0.009/call), 24,078 used this cycle, renews
  2026-10-07. Source: `account.json`, 2026-09-27.
- Against the 30% specificity-floor bar (#18), a seed-query sample passed at
  TikTok 10% (6/60, 57/60 posted in the past day), Reddit tab 0% (only 17/58
  results were Reddit), Kickstarter 4% (4 of 6 consumer seeds returned 0).
  Source: CRMA-1317, 2026-09-28,
  `docs/wayfinder/assets/crma-1317-serpapi-sample-grades.md`.

## Standing constraints

- The map produces a spec, not a running ingester (charting, 2026-09-27).
- TikTok, Reddit, and Kickstarter are planned as **direct platform sources**
  (scheduled ingesters writing `FCT_SIGNALS`), not agent search tools or
  oracles. Martin's intent, 2026-09-27 (CRMA-1319).
- A SerpApi ingester is a `services/` Cloud Run service started by a Cloud
  Scheduler job, with the fetch logic in `services/lib/sources/serpapi.mjs`.
  No new Pipedream workflow. The audit agent watches each new `SOURCE_NAME`
  for freshness via `EMBEDDED_AT` (CRMA-1319). If a platform later takes the
  tool or oracle role, the hosting question reopens for that platform only.
- The ingester looks outward. Each run searches a fixed list of **seed
  queries** (a constant in the service), never queries derived from signals,
  candidates or trends. TikTok and Reddit share one list keyed by discovery's
  6 verticals, 3-5 atomic consumer terms each; Kickstarter gets no list until
  its role is decided. Daily run, past-day window, hard cap of 50 calls per
  run (CRMA-1320). Pipeline-derived lookups are the agent-search-tool role.
- No platform passes the specificity floor as-is (CRMA-1317). A platform kept
  as a direct platform source must add an explicit specificity filter or a
  different query shape, and the spec must say which. Reddit results add depth
  on topics we already carry, which is the agent-search-tool role.

## Decisions so far

- [Research: What can SerpApi return for TikTok, Reddit, and Kickstarter?](https://mcclatchy.atlassian.net/browse/CRMA-1316) — **Decided:** No dedicated engines; all three go through Google, need a query, and have no top/trending feed. TikTok via google_short_videos is strong, Reddit thin, Kickstarter weak; shared quota at 80% used.

- [Decide: Where does a new SerpApi ingester run, Pipedream or the services/ Cloud Run tier?](https://mcclatchy.atlassian.net/browse/CRMA-1319) — **Decided:** Cloud Run service started by Cloud Scheduler, fetch logic in services/lib/sources/serpapi.mjs, no new Pipedream workflow; the platforms are planned as direct platform sources.

- [Decide: Where does a scheduled SerpApi ingester get its queries?](https://mcclatchy.atlassian.net/browse/CRMA-1320) — **Decided:** Outward-looking: a fixed seed-query list keyed by discovery's 6 verticals, shared by TikTok and Reddit, daily past-day pulls capped at 50 calls per run.

- [Prototype: Does a SerpApi sample pass the distillation specificity rubric?](https://mcclatchy.atlassian.net/browse/CRMA-1317) — **Decided:** No platform passes as-is: TikTok 10%, Reddit tab 0%, Kickstarter 4% against the 30% specificity-floor bar; TikTok is fresh but category seeds return routines and listicles.

## Not yet specified

- **The source family of each new source name.** The promotion gate counts
  source families, so this decides whether a Reddit signal can corroborate a
  Bluesky signal. It hangs on which platforms survive the prototype.
- **The provenance invariant for a SERP result.** A Google result about a post
  has a real URL, but its snippet is Google's text, not the post. Decide
  whether that is a verifiable external artifact, or whether the ingester must
  fetch the page.
- **Kickstarter's home.** It could be a trend source, an input to the ecomm
  sourcing agent (`services/ecomm-agent`), or something for the CSA team
  (PGS-836). The prototype found it fails as a trend source (4%, index
  dominated by games and books); whether any other home is in scope hangs on
  CRMA-1318.
- **The signal timestamp.** TikTok's post time decodes from the video ID;
  Reddit gives a relative date; Kickstarter gives only Google's crawl date.
  Decide how `SIGNAL_TIMESTAMP` is derived per platform.

## Out of scope
