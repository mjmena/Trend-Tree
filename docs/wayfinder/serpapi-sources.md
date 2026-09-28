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

## Standing constraints

- The map produces a spec, not a running ingester (charting, 2026-09-27).

## Decisions so far

## Not yet specified

- **The source family of each new source name.** The promotion gate counts
  source families, so this decides whether a Reddit signal can corroborate a
  Bluesky signal. It hangs on the role decision.
- **The provenance invariant for a SERP result.** A Google result about a post
  has a real URL, but its snippet is Google's text, not the post. Decide
  whether that is a verifiable external artifact, or whether the ingester must
  fetch the page.
- **Kickstarter's home.** It could be a trend source, an input to the ecomm
  sourcing agent (`services/ecomm-agent`), or something for the CSA team
  (PGS-836). It becomes sharp once the research shows what Kickstarter results
  contain.
- **The signal timestamp.** SERP dates are often relative ("3 days ago").
  Decide how `SIGNAL_TIMESTAMP` is derived.

## Out of scope
