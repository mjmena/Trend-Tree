# Ingest accepted Trend Hunter articles as Trend Tree signals

[Delivery epic](https://mcclatchy.atlassian.net/browse/CRMA-1917) · [Research map](https://mcclatchy.atlassian.net/browse/CRMA-1911)

## Problem statement

Trend Hunter already collects articles from news and trade publications. During November 13–19, 2026 it accepted 2,513 distinct article URLs. Five exactly matched original URLs in the five Trend Tree sources examined. For those five, provider pickup preceded Trend Tree intake by a median of 42 hours. Three eventually supplied evidence to four active trends. The study established an article pickup lead. Its effect on trend discovery is still unknown. [Article profile](https://mcclatchy.atlassian.net/browse/CRMA-1912) · [Discovery timing study](https://mcclatchy.atlassian.net/browse/CRMA-1913)

## Solution

Add the accepted article feed as a direct source in Trend Tree's normal signal intake. Distillation can use an article in a candidate and attribution can attach it to an active trend. Existing promotion rules determine when a candidate becomes a trend. Start recording observations on the first run so that the feed's contribution can be assessed after rollout.

## User stories

1. As a strategist, I want Trend Tree to consider accepted articles alongside its other signals so it can surface an emerging trend sooner.
2. As a strategist reviewing a trend, I want the original publisher and story link so I can inspect its evidence.
3. As an evidence reviewer, I want repeat sightings and verified copies of one release counted once while independent reporting remains eligible.
4. As an operator, I want interrupted and overlapping pulls to recover without losing a page or adding repeat evidence.
5. As the source owner, I want to know when an accepted article first reached us and what it contributed to a candidate or an existing trend.

## Implementation decisions

**Article intake.** Read the authenticated article list with `status=accepted`. Start with headline, original URL, publisher host and available summary. Retain the provider article ID, feed label, editorial verdict, provider `first_seen`, nullable `published_at` and our first successful observation of the accepted record in UTC. Header-authenticated metadata requests return `text: null` with `fields=-text`; a missing summary can use the headline. The article detail endpoint is available when a specific copy needs verification. [Provider API reference](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)

**Evidence identity.** Use one direct source name, `trend_hunter`, and the original publication as publisher. Submit eligible articles through the existing external-signal merge so they can reach the embedded signal table. Match canonical publisher URLs across feeds and retain the original URL for inspection. Preserve the first writer's signal and retain the Trend Hunter observation even when another source supplied it first. For syndicated releases, use a shared original, release identifier or verified matching release text to credit one item of evidence across copies. A shared host, brand or similar headline alone is insufficient to merge two articles. The same rule applies to source-family corroboration and publisher breadth whichever feed arrives first.

**Operation.** Use the project's scheduled Cloud Run job and Secret Manager conventions. Proposed defaults are an hourly pull and daily reconciliation over the preceding seven days of provider pickup, starting at enablement. A fixed upper bound and cursor keep a multipage read consistent. Advance progress only when every page in the window has been durably handled. Respect `Retry-After`, preserve the original accepted-observation time on replay, and record counts for accepted rows read, new signals, repeat sightings, syndicated copies and unusable records. Reconciliation catches later acceptance within its stated window because the API filters by pickup and returns the current verdict. A bounded operator replay can recover older changes. Record replay origin so historical recovery cannot be mistaken for forward discovery lead.

**Contribution after rollout.** After the first seven complete UTC days, produce a repeatable report for a stated window. Follow signal IDs to supporting candidates, new promotions, merges and attributed links to trends already active at observation. Count independent stories and distinct active trends receiving evidence. For a sample of candidate movements, compare when the same movement first met the existing criteria using native evidence and using native plus Trend Hunter evidence available at that time. From the first run, retain time-stamped article observations and the as-of evidence needed for sampled comparisons, including observable native repeats the signal merge would discard. Label estimates, comparison-source coverage, unavailable native sightings and cases still awaiting an outcome. An exact URL arriving earlier establishes an article lead. The sampled candidate decisions establish whether there is evidence for a trend discovery lead. [Observation clocks and comparison limits](https://mcclatchy.atlassian.net/browse/CRMA-1913)

## Testing and release evidence

- Exercise the normal job entry point over a fixed window. Verify stored signal identity, original publisher, retained timestamps, and eligibility for the existing distillation and attribution paths. Include one rejected article, a missing summary, a repeat URL seen first through another feed, verified copies of a release and independently reported stories on the same topic.
- Interrupt a paginated pull, retry a rate-limited page, overlap two executions and reconcile a previously observed window after an article becomes accepted. Check the resulting observations, checkpoint and unique evidence counts.
- Verify a scheduled production run through its recorded outcome and resulting Snowflake rows. A subsequent replay must preserve signal counts and first-observation times. The post-launch report can then use recorded cases with an attributable outcome and cases with insufficient evidence.

## Out of scope

Trend Hunter's scored trends, rejected-article ingestion, bulk historical seeding, and changes to ATLAS screens or promotion thresholds are separate work.

## Delivery

1. [Add accepted Trend Hunter articles to the signal dataset](https://mcclatchy.atlassian.net/browse/CRMA-1918)
2. [Run and verify scheduled Trend Hunter article intake](https://mcclatchy.atlassian.net/browse/CRMA-1919)
3. [Measure earlier discovery and fresh evidence from Trend Hunter articles](https://mcclatchy.atlassian.net/browse/CRMA-1920)
