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
  [publisher], source family, Evidence purity (the ticket-era name
  "provenance invariant" is not a `CONTEXT.md` term).
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
- Roles per platform (CRMA-1318, 2026-09-28). **TikTok** is a direct
  platform source (a scheduled ingester writing `FCT_SIGNALS`). **Reddit** is a
  corroboration oracle at the promotion gate: a `site:reddit.com` match on the
  decider's oracle keyword earns the missing second source family, no
  `FCT_SIGNALS` row, and it plugs into the same gate seam the CRMA-1214 map
  designs for Exploding Topics, not a new one. **Kickstarter** is dropped.
- A SerpApi ingester is a `services/` Cloud Run service started by a Cloud
  Scheduler job, with the fetch logic in `services/lib/sources/serpapi.mjs`.
  No new Pipedream workflow. The audit agent watches each new `SOURCE_NAME`
  for freshness via `EMBEDDED_AT` (CRMA-1319). This holds for TikTok only;
  Reddit runs as an oracle adapter inside `services/promotion` (CRMA-1326).
- The ingester looks outward. Each run searches a fixed list of **seed
  queries** (a constant in the service), never queries derived from signals,
  candidates or trends. TikTok and Reddit share one list keyed by discovery's
  6 verticals, 3-5 atomic consumer terms each. Reddit, now an oracle, needs
  no seed list (CRMA-1318). Daily run, past-day window, hard cap of 50 calls per
  run (CRMA-1320). Pipeline-derived lookups are the agent-search-tool role.
- Trend Tree draws on the shared `dev@trendhunter.com` SerpApi plan, not a
  plan of its own. The TikTok ingester and the Reddit oracle together stay at
  or below 100 searches per day (TikTok 50, Reddit 40, 10 headroom; CRMA-1326) (the owner agreed to 50-100/day while
  exploring). The key lives in Secret Manager as `serpapi-api-key` in
  `mcc-crm-automations`; the build creates it. Keeping the sources past
  exploration, or needing more, reopens the quota with the owner (CRMA-1321).
- The TikTok ingester keeps the CRMA-1320 query shape (`site:tiktok.com
  <seed>`, one atomic term per seed) and adds an LLM specificity filter on the
  result title before the `FCT_SIGNALS` write: `gemini-3.7-flash` with the
  distillation rubric's noun-phrase-plus-verb test. No changed query shape:
  `google_short_videos` returns 0 for most multi-word queries. Results are
  deduplicated by TikTok video ID across runs. The spec requires a spot-check
  of the first week of `tiktok` rows against the 30% bar (#18), with the rule
  fixed in advance: below 30%, TikTok drops (CRMA-1325).
- A TikTok result becomes one `FCT_SIGNALS` row with `SOURCE_NAME =
  'tiktok'`, its own source family (no change to `sourceFamilyOf()`). The
  URL plus the title satisfies Evidence purity: no page fetch, `SIGNAL_TEXT`
  NULL, empty-title results dropped. `SIGNAL_TIMESTAMP` is the post time
  decoded from the video ID, with a fetch-time fallback flagged in
  `METADATA.timestamp_source`. `SIGNAL_ID` is the link without its query
  string; the ingester dedups on `METADATA.video_id`. `METADATA` never
  carries `search_query`. The spec must make the `tiktok` freshness check read
  `EMBEDDED_AT`, not `SIGNAL_TIMESTAMP` as the audit SQL does today
  (CRMA-1330).
- The Reddit oracle is a second adapter in the injected oracle list that
  CRMA-1242 (map CRMA-1214) gives promotion's decider. It ships with the
  **typed Jev decider only**; the incumbent Gemini decider keeps
  `[exploding_topics]`, and the typed list is `[exploding_topics, reddit]`.
  The decider calls the oracles in that order and **stops at the first
  `same_concept`**, so Reddit runs only on an ET miss. Reddit takes the same
  keyword the decider sends every oracle (the rule CRMA-1332 tests); it has no
  keyword of its own. Its results go to the unchanged `oracle_match` question
  (no seventh `promotion.jev.*` row). The adapter makes one `engine=google`
  call, `site:reddit.com <keyword>`, `tbs=qdr:m`, `num=10`; keeps only
  `reddit.com/r/<sub>/comments/<id>` threads; drops threads with no comment
  count or fewer than 10 comments (unvalidated, like the ET floor of 1000);
  and sends every surviving thread to `oracle_match`. It enforces its own cap
  of 40 calls per day. At the cap it does not run: the candidate is decided on
  ET alone, with Reddit recorded as skipped for budget. A SerpApi error or
  timeout returns `Decision` `failed` at stage `oracle`, which CRMA-1219's
  bounded retry handles. Results live in `JUDGMENT_DETAIL`, each tagged with
  oracle name, URL, comment count and skip reason; no sibling ledger (this
  amends ADR-0004). The spec requires a first-week hand check of
  Reddit-rescued candidates, fixed in advance: below 70% real corroborations,
  Reddit comes off the list. The spec also requires a live measurement of the
  `needs_corroboration` rate once Snowflake is reachable. The Reddit adapter
  can ship only after the typed decider exists in `services/promotion`
  (CRMA-1326).

## Decisions so far

- [Research: What can SerpApi return for TikTok, Reddit, and Kickstarter?](https://mcclatchy.atlassian.net/browse/CRMA-1316) — **Decided:** No dedicated engines; all three go through Google, need a query, and have no top/trending feed. TikTok via google_short_videos is strong, Reddit thin, Kickstarter weak; shared quota at 80% used.

- [Decide: Where does a new SerpApi ingester run, Pipedream or the services/ Cloud Run tier?](https://mcclatchy.atlassian.net/browse/CRMA-1319) — **Decided:** Cloud Run service started by Cloud Scheduler, fetch logic in services/lib/sources/serpapi.mjs, no new Pipedream workflow; the platforms are planned as direct platform sources.

- [Decide: Where does a scheduled SerpApi ingester get its queries?](https://mcclatchy.atlassian.net/browse/CRMA-1320) — **Decided:** Outward-looking: a fixed seed-query list keyed by discovery's 6 verticals, shared by TikTok and Reddit, daily past-day pulls capped at 50 calls per run.

- [Prototype: Does a SerpApi sample pass the distillation specificity rubric?](https://mcclatchy.atlassian.net/browse/CRMA-1317) — **Decided:** No platform passes as-is: TikTok 10%, Reddit tab 0%, Kickstarter 4% against the 30% specificity-floor bar; TikTok is fresh but category seeds return routines and listicles.

- [Decide: Which platforms enter as direct platform sources?](https://mcclatchy.atlassian.net/browse/CRMA-1318) — **Decided:** TikTok stays a direct platform source if a fix prototype lifts it to 30%; Reddit becomes a corroboration oracle on the CRMA-1214 gate seam; Kickstarter is dropped and out of scope.

- [Task: Settle who owns the SerpApi quota](https://mcclatchy.atlassian.net/browse/CRMA-1321) — **Decided:** Trend Tree draws on the shared dev@trendhunter.com SerpApi plan at 50-100 searches/day while exploring, key in Secret Manager as serpapi-api-key; no plan of its own.

- [Prototype: Does a changed query shape or a specificity filter lift TikTok to the 30% bar?](https://mcclatchy.atlassian.net/browse/CRMA-1325) — **Decided:** A gemini-3.7-flash title filter lifts TikTok to 45% on the category seeds and 35% overall (small sample); changed query shapes fail. TikTok stays, with video-ID dedup and a first-week 30% spot-check that drops it on failure.

- [Decide: How is a TikTok search result written as an FCT_SIGNALS row?](https://mcclatchy.atlassian.net/browse/CRMA-1330) — **Decided:** TikTok is its own source family; URL plus title satisfies Evidence purity (no page fetch); SIGNAL_TIMESTAMP is the post time decoded from the video ID; dedup on METADATA.video_id; no search_query key.

- [Decide: How does the Reddit corroboration oracle reach the promotion gate?](https://mcclatchy.atlassian.net/browse/CRMA-1326) — **Decided:** Reddit is a second oracle adapter in services/promotion, typed decider only, called after ET with stop at first same_concept; same keyword, unchanged oracle_match, past-month thread search with a 10-comment floor, own cap of 40/day, errors return failed, results in JUDGMENT_DETAIL (ADR-0004 amended).

## Not yet specified

Nothing at present.

## Out of scope

- **Kickstarter, in any role.** It fails as a trend source (4%, index
  dominated by games and books, CRMA-1317). Its other homes, an input to
  `services/ecomm-agent` or CSA sourcing (PGS-836), are product-sourcing
  inputs, not trend signal, and belong to a different effort. Ruled in
  [Decide: Which platforms enter as direct platform sources?](https://mcclatchy.atlassian.net/browse/CRMA-1318).
