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
- McClatchy has already attempted outreach to Reddit about commercial API access and received no response to date. The API-first route for Reddit is stalled by silence, not by a quoted price. Source: Martin, 2026-09-06.
- **Correction to CRMA-981.** That research called `clockworks` "Apify's own brand" and credited the marketplace with 3–5 substitute actors per platform. Both are wrong. `clockworks`, `harshmaur` and `automation-lab` are all **community** developer accounts; Apify Actor T&Cs §9.1–9.2 disclaim vetting and impose no maintenance obligation on community authors; and the Kickstarter actors have 5 and 2 monthly users. Source: Apify Store + Actor T&Cs, verified 2026-09-07 on CRMA-985.
- **Correction to CRMA-985: Bright Data discovery is NOT async-only.** `POST /datasets/v3/scrape` documents discovery explicitly ("Send it with `type=discover_new&discover_by=subreddit_url` on the query string"), capped at ~1 minute and ≤20 URLs, returning 202 + `snapshot_id` on timeout. CRMA-985's decision stands — the gateway is still always-async, which is right for scheduled ingesters and is what keeps it stateless — but a synchronous search tool is slow and non-deterministic, not impossible. Source: Bright Data API reference, verified 2026-09-07 on CRMA-986.
- **Bright Data's free tier is 5,000 credits per MONTH, recurring** (reset on the 1st, no rollover), card not required, no PAYG monthly minimum and no plan fee. CRMA-985 assumed a one-off trial. Web Scraper API bills 1 credit per record; Web Unlocker 1 per request. Source: Bright Data billing docs, verified 2026-09-07 on CRMA-986.
- **TikTok discovery accepts no vendor-side recency filter** in either keyword or URL mode, so CRMA-983's ~7-day freshness guard must be applied after the pull, on `create_time`. Source: Bright Data API reference, verified 2026-09-07 on CRMA-986.
- **Bright Data's Reddit discover-by-subreddit input has no time parameter** — only `url` and `sort_by`. Day-scoped Reddit exists only in `discover_by=keyword`, which takes a `date` field (`Past hour|Past day|…`). This bears on CRMA-982's `top?t=day` half; CRMA-986's gate check settles it empirically. Source: Bright Data API reference, verified 2026-09-07 on CRMA-986.

## Standing constraints

- TikTok reopens only if research finds a data shape materially different from hashtags (video/sound-level with descriptions, or the official Research API) that can plausibly pass the specificity rubric. The #18 rubric failure stands as a decision.
- The entry mechanism is decided per platform; the default preference is direct platform source where a viable API exists.
- Kickstarter enters as a signal source (feeding distillation → trends), never as product-sourcing feed.
- Recurring paid APIs are acceptable; each platform decision weighs the researched real cost.
- Pass bar for any new source: specificity-rubric pass + evidence purity (verifiable URLs) are hard requirements; volume and cost are per-platform judgment calls.
- The scraping tool is a commercial scraping API wrapped behind a thin internal service — not homegrown scraping infrastructure, not an agent-driven fetcher.
- Route precedence: API-first, scrape-fallback. Scraping TikTok, Reddit, and Kickstarter each sits against that platform's ToS, and a scraped surface can vanish without notice (the TikTok precedent) — every approved scrape route must carry audit-agent freshness coverage.

## Decisions so far

- [Research: Reddit ingest routes — official Data API vs scrape](https://mcclatchy.atlassian.net/browse/CRMA-978) — **Decided:** Reddit: official API stalled (commercial-gated, ~$12k/mo reported floor, outreach unanswered), unauthenticated .json dead (403), vendor scrape viable at ~$20–50/mo and passes both hard requirements
  **Binds:** CRMA-982 chooses between vendor-scrape-now (+ parallel outreach, switch if Reddit replies) — the .json route is struck from the map

- [Research: TikTok data shapes beyond hashtags — can any clear the reopen condition?](https://mcclatchy.atlassian.net/browse/CRMA-979) — **Decided:** TikTok: vendor-scraped keyword-driven video-level records (description + sound + engagement + public URL, ~$1–2/1k) clear the reopen condition; Research API is closed to commercial applicants and Creative Center stays hashtag-coarse
  **Binds:** CRMA-983 reopen is conditional on CRMA-985 delivering acceptable scraper-durability terms; hashtag-class surfaces stay ruled out

- [Research: Kickstarter ingest routes and data shape](https://mcclatchy.atlassian.net/browse/CRMA-980) — **Decided:** Kickstarter: no official API exists — scrape-only via the discover/advanced JSON surface behind a Cloudflare-defeating intermediary; shape passes both hard requirements, ~25–40 relevant projects/day, velocity by re-poll diffing
  **Binds:** CRMA-984 picks Apify actor vs proxy-DIY; no direct unproxied fetches, no RSS shims; Web Robots dumps are backfill/QA only

- [Research: commercial scraping vendors against TikTok, Reddit, Kickstarter](https://mcclatchy.atlassian.net/browse/CRMA-981) — **Decided:** Apify is the strongest single vendor — only pre-built coverage of all three platforms on the needed surfaces, ~$150–250/mo; Bright Data is cheaper (~$113/mo TT+Reddit) with the best litigation record but has decisive surface gaps and zero contractual indemnity
  **Binds:** CRMA-985 weighs Apify coverage vs Bright Data legal posture; suggested paid pilot Apify (all 3) vs EnsembleData (TikTok) before committing

- [Decide: the Reddit ingest route](https://mcclatchy.atlassian.net/browse/CRMA-982) — **Decided:** Reddit is in by vendor scrape (~$20–50/mo) as a direct platform source — post-level records from curated subreddits via new + top?t=day, velocity by re-poll deltas; API inquiry stays open with a standing switch intent; ToS-risk acceptance recorded as ADR-0006
  **Binds:** CRMA-985 must weigh vendor legal posture, and is NOT constrained to native rising-sort coverage; a search-reddit agent search tool is out of this decision

- [Decide: TikTok — reopen with a new data shape, or stay retired](https://mcclatchy.atlassian.net/browse/CRMA-983) — **Decided:** TikTok reopens conditionally as vendor-scraped video-level records (~$1–2/1k): direct platform source now (hashtag-funnel-first hybrid, curated repo-maintained lists, ~7-day freshness guard, few hundred videos/day), search-tiktok tool named the higher-quality second role; lapses back to retired if CRMA-985 finds no acceptable vendor; ToS acceptance ADR-0007
  **Binds:** CRMA-985 must cover TikTok hashtag+keyword surfaces, pilot-verify recency filtering on both input modes, and weigh search-tool latency/per-call cost first-class; hashtag-class OUTPUT stays ruled out (input funnels fine); CRMA-1005 decides the search-tiktok lane; oracle/metrics roles deferred, TikTok Shop out of scope

- [Decide: the Kickstarter ingest route](https://mcclatchy.atlassian.net/browse/CRMA-984) — **Decided:** Kickstarter is in by vendor scrape as a direct platform source, conditional on CRMA-985 covering it — traction-gated (state=live + funded raised bucket over curated category_ids, daily, first sighting of a project id is the signal), no re-poll/snapshot machinery, one role only; ToS acceptance ADR-0008
  **Binds:** CRMA-985 gets a WEAK coverage constraint — actor OR Turnstile-defeating generic unblocker, which keeps both Apify and Bright Data alive — and must pilot-verify the raised filter survives the vendor route (if not, the design falls back to re-poll diffing and this reopens); no search-kickstarter tool exists or is deferred; Kickstarter is a corroborating commercial-intent family, not to be judged by promotion rate; CRMA-1006 owns source naming for all three platforms

- [Decide: the scraping tool — vendor choice and wrapper shape](https://mcclatchy.atlassian.net/browse/CRMA-985) — **Decided:** Bright Data is the single vendor (~$52–55/mo; first-party TikTok keyword/hashtag + Reddit subreddit datasets, Turnstile-capable Web Unlocker for Kickstarter), conditional on four free-tier trial checks — Apify's coverage edge evaporated once the route decisions relaxed the surfaces, and its actors turned out to be unvetted community code. The tool is `services/scrape-gateway` on Cloud Run: always-async job-and-poll, Level 1 platform-shaped records normalized by (platform, vendor) in `services/lib/`, stateless, enforcing no quota.
  **Binds:** CRMA-986 runs 4 free-tier gate checks before provisioning (Reddit `top?t=day` expressible; Turnstile on `?format=json`; no PAYG monthly minimum; TikTok sound field present) — a failure falls back PER PLATFORM to Apify, not wholesale. CRMA-989 gets the gateway's per-job `rejected` count as its scraper-breakage signal. Ingesters keep signal-shaping (CRMA-1006 owns METADATA); dedupe stays in the STG_EXTERNAL_SIGNALS MERGE on SIGNAL_ID. CRMA-1005 inherits a SOFT constraint, not a hard one — see the sync-discovery correction under Established facts.

- [Provision the scraping vendor and stand up the wrapper service](https://mcclatchy.atlassian.net/browse/CRMA-986) — **Decided:** All four gate checks PASS — Bright Data is unconditional, no Apify fallback needed; scrape-gateway is live at https://trend-tree-scrape-gateway-tu6gxkvema-uk.a.run.app (OIDC), secret brightdata-api-key v1, Web Unlocker zone trend_tree_scoping
  **Binds:** Reddit top?t=day works via UNDOCUMENTED sort_by_time (Now|Today|This Week|This Month|This Year|All Time) + sort_by (Top|New|Hot|Rising), both capitalized — Rising is available, so CRMA-981's Apify-only claim was wrong. Kickstarter schema is confirmed live and the raised filter works server-side, satisfying CRMA-984's pilot-verify binding. CRMA-989 gets {records, rejected, reject_reasons} per job. NEW RISK for CRMA-983: TikTok discovery has NO recency control (accepts only search_keyword, num_of_posts, country) and sampled records were 2-39 months old, so the ~7-day guard would discard all of them — the cost-per-usable-record model needs re-measuring.

## Not yet specified

- A reusable source-onboarding playbook (rubric checks, API vetting, mechanism choice). Interest expressed; value unclear until the three platforms have been walked.

## Out of scope

- Building the per-platform ingesters — past the destination; hands off via `/to-spec` or `/to-tickets` once a route is decided.
- An ingester scaffold/generator — execution-after-decision, downstream of the map.
- Kickstarter as product-sourcing feed — the sourcing tier's multi-tier contract (CRMA-745) owns that; this map ingests Kickstarter as signals only.
