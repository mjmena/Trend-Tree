<!-- map: CRMA-977 -->

# Expand intake sources — TikTok, Reddit, Kickstarter

## Destination

Each of TikTok, Reddit, and Kickstarter has a decided ingest route — entry mechanism, API-or-scrape route, cost, and data shape — or an explicit ruled-out verdict, sharp enough to hand to `/to-spec` or `/to-tickets`. Plus the shared scraping tool decided and provisioned far enough that an approved scrape route can use it.

## Notes

- Skills: `/grilling` + `/domain-modeling` on every decide ticket. Decision tickets resolve as written prose recommendations with reasoning, not option cards.
- Vocabulary: `CONTEXT.md`'s **Source** entry defines the three entry mechanisms — direct platform source / discovery agent / agent search tool. Use those terms exactly; "add a platform" means choosing one of the three.
- Execution override: this map carries one execution ticket — provisioning the scraping tool. The destination includes the tool being usable, not just chosen.

## Established facts

- `ingestion/tiktok-p_yKCm9Am` (Creative Center hashtag scraper) was deactivated 2026-06-09: the scraped page 301s to "TikTok One Creative Suite" and the `creative_radar_api` XHR is gone; its hashtag-level output also failed the distillation specificity rubric (#18). Source: CLAUDE.md, verified 2026-09-06.
- The Grok discovery lane covers the TikTok cultural niche today. Source: CLAUDE.md, 2026-09-06.
- Reddit and Kickstarter have no prior ingester or prior ruling in this repo. Source: repo survey, 2026-09-06.

## Standing constraints

- TikTok reopens only if research finds a data shape materially different from hashtags (video/sound-level with descriptions, or the official Research API) that can plausibly pass the specificity rubric. The #18 rubric failure stands as a decision.
- The entry mechanism is decided per platform; the default preference is direct platform source where a viable API exists.
- Kickstarter enters as a signal source (feeding distillation → trends), never as product-sourcing feed.
- Recurring paid APIs are acceptable; each platform decision weighs the researched real cost.
- Pass bar for any new source: specificity-rubric pass + evidence purity (verifiable URLs) are hard requirements; volume and cost are per-platform judgment calls.
- The scraping tool is a commercial scraping API wrapped behind a thin internal service — not homegrown scraping infrastructure, not an agent-driven fetcher.
- Route precedence: API-first, scrape-fallback. Scraping TikTok/Reddit sits against their ToS, and a scraped surface can vanish without notice (the TikTok precedent) — every approved scrape route must carry audit-agent freshness coverage.

## Decisions so far

## Not yet specified

- A reusable source-onboarding playbook (rubric checks, API vetting, mechanism choice). Interest expressed; value unclear until the three platforms have been walked.
- Source naming + `METADATA` provenance for whichever platforms land — `CONTEXT.md` flags that `SOURCE_NAME` does not encode the entry mechanism; new sources should not repeat that mess.
- How audit-agent freshness coverage gets wired for scraped sources — sharpens once the first scrape route is approved.

## Out of scope

- Building the per-platform ingesters — past the destination; hands off via `/to-spec` or `/to-tickets` once a route is decided.
- An ingester scaffold/generator — execution-after-decision, downstream of the map.
- Kickstarter as product-sourcing feed — the sourcing tier's multi-tier contract (CRMA-745) owns that; this map ingests Kickstarter as signals only.
