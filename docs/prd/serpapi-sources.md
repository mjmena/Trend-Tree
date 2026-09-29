<!-- prd: serpapi-sources · epic: see JIRA remote link · map: CRMA-1315 -->

# PRD: SerpApi sources — a TikTok source and a Reddit corroboration oracle

> **Outcome (2026-09-28).** The TikTok source shipped: CRMA-1337 delivered the ingester, and
> CRMA-1338 delivered the daily schedule and the audit freshness row. The Reddit corroboration
> oracle will not ship. [CRMA-1344](https://mcclatchy.atlassian.net/browse/CRMA-1344) rejected
> Jev, so the typed promotion decider that Reddit extends will not be built. CRMA-1339 and
> CRMA-1341 closed as wontfix. The Reddit sections below record the design as decided. They do
> not describe planned work.

Produced 2026-09-28 from wayfinder map [CRMA-1315](https://mcclatchy.atlassian.net/browse/CRMA-1315)
(`docs/wayfinder/serpapi-sources.md` on branch `wayfinder/serpapi-sources`). Every decision
below was settled on that map's tickets; this document assembles them into one buildable spec.
The terms [source], direct platform source, [agent search tool], [corroboration oracle],
[publisher], Evidence purity and [candidate query] are used exactly as `CONTEXT.md` defines them.
"Source family" means what `sourceFamilyOf()` in `agents/lib/promotion_gate.mjs` returns;
`CONTEXT.md` has no entry of its own for it.

## Problem Statement

Trend Tree finds trends late in one specific place: early consumer and product signal.
Discovery covers social (Bluesky, `grok_live`), news (GDELT) and search demand (Google Trends).
Nothing covers short-video culture or forum discussion:

- The TikTok lane is empty. `ingestion/tiktok-p_yKCm9Am` was deactivated on 2026-06-09, because
  TikTok retired the Creative Center page and its hashtag-level output never met the
  distillation specificity rubric (#18). Consumer products and practices often surface on TikTok
  first.
- The promotion gate turns away single-family candidates. Exploding Topics (ADR-0004) is the
  only corroboration oracle, and it misses many real movements. A candidate that forum users
  discuss at length, but that ET does not list, is rejected for lack of a second source family.
- A third platform, Kickstarter, was a candidate for pre-retail product signal. It failed as a
  trend source (see **Out of Scope**).

SerpApi, on a shared plan the team already pays for, reaches both TikTok and Reddit through
Google. It has no dedicated engine for either, needs a query for every call, and offers no
"top" or "trending" feed (CRMA-1316). The spec therefore uses it in two different roles.

## Solution

Two independent additions, one per platform:

1. **TikTok becomes a direct platform source.** A new Cloud Run job, `trend-tree-tiktok-ingest`,
   runs once a day from Cloud Scheduler. It searches a fixed list of outward-looking seed
   queries through SerpApi's `google_short_videos` engine, keeps only past-day videos, passes the
   titles through a `gemini-3.7-flash` specificity filter, and writes the survivors as signals
   with `SOURCE_NAME = 'tiktok'`. The signals then flow through the pipeline like any other
   source: embedding, clustering, distillation, promotion. TikTok is its own source family, so a
   TikTok signal plus a Bluesky signal clears the promotion gate's two-family rule.
2. **Reddit becomes a second corroboration oracle at the promotion gate.** When the typed Jev
   decider (map CRMA-1214) marks a candidate `needs_corroboration`, it asks Exploding Topics
   first. If ET does not return a `same_concept` match, the decider asks Reddit: one
   `site:reddit.com` search for recent discussion threads on the same oracle keyword. A Reddit
   thread that Jev judges the same concept earns the missing second source family. Reddit writes
   no signal.

Both additions are exploratory. Each one carries a first-week check with a pass bar fixed in
advance. If the check fails, that platform comes out.

## User Stories

### Trend consumers

1. As an ATLAS reader, I want trends that surface on TikTok to appear in ATLAS, so that I see
   consumer products and practices before news covers them.
2. As an ATLAS reader, I want TikTok-sourced trends to be as specific as other trends, so that
   the feed does not fill with "skincare routine" and "20 Amazon finds".
3. As an ATLAS reader, I want a TikTok link to open the actual video, so that I can see the
   evidence for myself.
4. As an ATLAS reader, I want TikTok to count as its own publisher (`tiktok.com`), so that
   `DISTINCT_PUBLISHER_COUNT` reflects it correctly.
5. As an ATLAS reader, I want trends that Reddit discussion corroborates to be promoted, so that
   real movements that ET has not listed yet still reach me.
6. As an ATLAS reader, I want Reddit never to remove a trend, so that a thin forum result
   cannot hide a trend that other sources already support.

### Pipeline operator (Martin)

7. As the pipeline operator, I want the TikTok ingester to run on Cloud Run from Cloud Scheduler,
   so that it lives in the `services/` tier the fleet is moving to (CRMA-429) and not in a new
   Pipedream workflow.
8. As the pipeline operator, I want the seed queries to be a fixed constant in the code, so that
   no row exists because the pipeline asked for it (Evidence purity).
9. As the pipeline operator, I want the seed list keyed by discovery's six verticals, so that
   TikTok coverage follows the same consumer categories the rest of the pipeline covers.
10. As the pipeline operator, I want a hard cap of 50 SerpApi calls per TikTok run, so that the
    ingester cannot overspend the shared plan.
11. As the pipeline operator, I want the Reddit oracle capped at 40 SerpApi calls per day, so that
    the two consumers together stay at or below the 100 searches a day agreed with the plan owner.
12. As the pipeline operator, I want the Reddit oracle to skip itself at its daily cap and record
    that it skipped for budget, so that a capped day is visible and not mistaken for "no
    corroboration found".
13. As the pipeline operator, I want a SerpApi error or timeout in the Reddit oracle to return a
    `failed` decision at stage `oracle`, so that CRMA-1219's bounded retry handles it the same way
    it handles any other machine failure.
14. As the pipeline operator, I want the TikTok ingester to fail without writing anything when
    SerpApi or Snowflake fails before the write, so that a partial run never leaves half a batch.
15. As the pipeline operator, I want a failed TikTok run retried once by the Cloud Run job, so
    that a transient error does not cost a day of signal.
16. As the pipeline operator, I want the audit agent to report `tiktok` freshness from
    `EMBEDDED_AT`, so that a stopped ingester shows up as RED even after a later backfill.
17. As the pipeline operator, I want the SerpApi key read from Secret Manager (`serpapi-api-key`),
    so that no secret value lives in `deploy.env` or in git.
18. As the pipeline operator, I want the Cloud Scheduler job created by a script in the service's
    directory, so that the schedule is code and re-running the script is how it changes.
19. As the pipeline operator, I want each TikTok row's `METADATA` to record which seed, vertical,
    filter model and filter verdict produced it, so that I can trace any signal back to the query
    and the filter decision.
20. As the pipeline operator, I want a TikTok row never to carry a `search_query` key, so that it
    does not read as an agent-search-tool row (`CONTEXT.md`, mixed-provenance note).
21. As the pipeline operator, I want each Reddit oracle result recorded in `JUDGMENT_DETAIL` with
    oracle name, URL, comment count and skip reason, so that a rescue can be audited later
    without a separate ledger.
22. As the pipeline operator, I want to query how many candidates Reddit rescued, so that I can
    measure its lift against ET alone.

### Data quality owner

23. As the data quality owner, I want every TikTok title filtered for a specific noun phrase plus a
    consumer verb before the write, so that the rows meet the 30% specificity-floor bar (#18).
24. As the data quality owner, I want the filter to reuse the distillation rubric's test, so that
    TikTok signals are judged by the same standard that later clusters them.
25. As the data quality owner, I want results with an empty title dropped before the filter, so
    that no row reaches the promote task only to be skipped there.
26. As the data quality owner, I want a video deduplicated by its TikTok video ID across runs, so
    that a renamed handle does not create a second row for the same video.
27. As the data quality owner, I want `SIGNAL_TIMESTAMP` to be the video's post time decoded from
    its ID, so that TikTok follows the source-dated rule that Bluesky, GDELT and the Google Trends
    RSS feed follow.
28. As the data quality owner, I want a fetch-time fallback flagged in `METADATA.timestamp_source`
    when the decode fails or falls outside the query window, so that a guessed time is never
    presented as a real one.
29. As the data quality owner, I want the first week of `tiktok` rows spot-checked against the 30%
    bar, with the rule fixed in advance that TikTok drops below 30%, so that the source stays only
    if it earns its place.
30. As the data quality owner, I want the Reddit oracle to keep only `reddit.com/r/<sub>/comments/<id>`
    threads with at least 10 comments, so that subreddit pages, profiles and dead threads never
    reach the judge.
31. As the data quality owner, I want every surviving Reddit thread judged by the same
    `oracle_match` question ET results use, so that "same concept" means the same thing for both
    oracles.
32. As the data quality owner, I want Reddit-rescued candidates from the first week hand-checked,
    with the rule fixed in advance that Reddit comes off the oracle list below 70% real
    corroborations, so that a noisy oracle cannot inflate promotion.
33. As the data quality owner, I want a live measurement of the `needs_corroboration` rate once
    Snowflake is reachable, so that the Reddit budget of 40 a day is checked against real demand.

### Promotion decider

34. As the typed promotion decider, I want Reddit to be a second adapter in my injected oracle
    list, so that adding an oracle needs no change to my decision rules.
35. As the typed promotion decider, I want to call the oracles in list order and stop at the first
    `same_concept`, so that Reddit costs a SerpApi call only on an ET miss.
36. As the typed promotion decider, I want Reddit to take the same keyword I send every oracle, so
    that the keyword rule (candidate query when present, trend topic otherwise) stays in one place.
37. As the typed promotion decider, I want the oracle to run only on `needs_corroboration`, so that
    Reddit can never veto a candidate whose evidence already stands (additive-only).
38. As the incumbent Gemini promotion path, I want my oracle list to stay `[exploding_topics]`, so
    that the Reddit oracle never changes the production path while the Jev decision is open.

### Plan owner (shared `dev@trendhunter.com` SerpApi account)

39. As the SerpApi plan owner, I want Trend Tree to stay at or below 100 searches a day while it
    explores, so that other consumers of the shared plan are not starved.
40. As the SerpApi plan owner, I want Trend Tree to come back to me before it keeps these sources
    past exploration or needs more quota, so that the plan's capacity stays a decision I make.

## Implementation Decisions

### Shared SerpApi client

- A new module in `services/lib/sources/` holds the SerpApi fetch logic. It is the only code that
  knows SerpApi's URL, parameters and error shapes. Both the TikTok ingester and the Reddit oracle
  adapter use it.
- The client takes the API key and a `fetch` function as inputs. It returns parsed results or
  throws a typed error for HTTP failure, a SerpApi `error` field, and timeout.
- The key lives in Secret Manager as `serpapi-api-key` in `mcc-crm-automations`. The build creates
  the secret from the existing key (macOS Keychain service `serpapi-api`). `crm-runtime@` already
  holds project-level `secretAccessor`.

### TikTok ingester (direct platform source)

- **Where it runs.** A Cloud Run **job** (`KIND=job`), `trend-tree-tiktok-ingest`, under
  `services/tiktok-ingest/`, deployed by `services/deploy.sh`. A Cloud Scheduler job starts it once
  a day through the Cloud Run Admin API `jobs/<name>:run`, with an OAuth access token as
  `crm-runtime@`. This is the shape `services/catalog-sync` uses. `MAX_RETRIES=1`. No new
  Pipedream workflow.
- **Orchestration.** One function in `services/lib` runs the whole ingest. The job's entrypoint
  supplies three I/O functions: the SerpApi search, the title filter, and a Snowflake `query`.
  The order is the safety property: every search and the filter complete **before** the first
  Snowflake write. A failure before the write writes nothing.
- **Seed queries.** A fixed constant in the code, keyed by discovery's 6 verticals, with 3–5
  atomic consumer terms per vertical. Never derived from signals, candidates or trends
  (pipeline-derived lookups are the agent-search-tool role).
- **Query shape.** `engine=google_short_videos`, `q=site:tiktok.com <seed>` (one atomic term per
  seed), past-day window, `gl=us`, `hl=en`. No other query shape: `google_short_videos` returns 0
  for most multi-word queries (CRMA-1325).
- **Budget.** A hard cap of 50 SerpApi calls per run, enforced in the orchestration, not left to
  the seed list's length.
- **Filter.** Results with an empty title are dropped first. The remaining titles go to
  `gemini-3.7-flash` in batches of about 40, temperature 0, JSON output. The prompt restates the
  distillation rubric's test ("a noun phrase you can put on a slide and a verb a consumer is
  doing") and its drop list: categories, routines, listicles, hauls, rankings, unboxings of
  established products, brand ads, deal posts. A result is written only if the filter keeps it.
  The filter prompt is a new `DIM_LLM_PROMPT` row, which lands as a committed
  `sql/update_prompts_*.sql` migration **plus** the manifest bump in the audit agent's
  `q_prompt_drift` step (both copies), per `CLAUDE.md`.
- **Dedup.** Before the write, the ingester skips any video whose ID already exists in
  `METADATA.video_id` for `SOURCE_NAME = 'tiktok'`, and any duplicate within the same run.
- **Row shape.** One signal per kept video, written through the shared `MERGE … ON SIGNAL_ID` into
  `STG_EXTERNAL_SIGNALS`. `MARKETING_TASK_PROMOTE_SIGNALS_TO_FCT` moves it to `FCT_SIGNALS`; that task and
  the shared MERGE do not change.

  | Column | Value |
  | --- | --- |
  | `SOURCE_NAME` | `'tiktok'` |
  | `SIGNAL_ID` | the returned `tiktok.com/@<handle>/video/<id>` link, query string stripped |
  | `SIGNAL_TITLE` | the result title |
  | `SIGNAL_TEXT` | NULL — the ingester never writes synthesized text; the row embeds on its title |
  | `SIGNAL_TIMESTAMP` | post time, `video_id >> 32` as UTC seconds; fetch time if the decode fails or falls outside the query window |
  | `METADATA` | `video_id`, `channel`, `duration`, `seed_query`, `vertical`, `filter_model`, `filter_verdict`, `timestamp_source` (`video_id` or `fetch`) — **never** `search_query` |

- **Evidence purity.** The URL plus the title is the verifiable external artifact. No page fetch.
  Because the seed list is fixed and outward-looking, no row exists because the pipeline asked for
  it.
- **Source family and publisher.** `tiktok` is its own source family. `sourceFamilyOf()` (both
  copies) already returns it through the default branch — no code change. `DT_TREND_DASHBOARD`
  already maps `tiktok` to the `tiktok.com` publisher — no change.
- **Freshness monitoring.** The audit agent gains a `tiktok` freshness check that reads
  `EMBEDDED_AT`, not `SIGNAL_TIMESTAMP` as its ingestion SQL does today. `SIGNAL_TIMESTAMP` hides an
  outage after a backfill.

### Reddit corroboration oracle

> **Superseded (2026-09-28).** This oracle will not be built, because CRMA-1344 rejected Jev for
> promotion. See the Outcome note at the top of this spec.

- **Dependency.** The adapter lives in `services/promotion`, which the CRMA-1214 map designs and
  which does not exist yet. It ships only after the typed Jev decider exists there, with the
  injected oracle list from CRMA-1242.
- **Oracle lists.** The incumbent Gemini decider keeps `[exploding_topics]`. The typed decider's
  list is `[exploding_topics, reddit]`. The decider calls the oracles in order and stops at the
  first `same_concept`. Reddit therefore runs only on an ET miss.
- **Keyword.** Reddit takes the keyword the decider sends every oracle: the candidate query when
  present, the trend topic otherwise (the rule CRMA-1332 tests). The adapter has no keyword logic
  of its own.
- **Search.** One SerpApi call per candidate: `engine=google`, `q=site:reddit.com <keyword>`,
  `tbs=qdr:m` (past month), `num=10`.
- **Result filter (code, before the judge).** Keep only links of the form
  `reddit.com/r/<sub>/comments/<id>`. Drop a thread with no comment count or fewer than 10 comments.
  The 10-comment floor is unvalidated, like ET's volume floor of 1000.
- **Judgment.** Every surviving thread goes to the unchanged `oracle_match` question. No new
  `promotion.jev.*` prompt row.
- **Budget.** The adapter enforces its own cap of 40 SerpApi calls per day. At the cap it does not
  run: the candidate is decided on ET alone, and Reddit is recorded as skipped for budget.
- **Failure.** A SerpApi error or timeout returns `Decision` `failed` at stage `oracle`.
  CRMA-1219's bounded retry handles it. The adapter never turns an error into "no match".
- **Persistence.** Results live in `JUDGMENT_DETAIL`, each tagged with oracle name, URL, comment
  count and skip reason. No sibling ledger: ADR-0004's amendment of 2026-09-28 records why. No
  `FCT_SIGNALS` row, no `SOURCE_BREAKDOWN` entry.
- **Additive-only.** The oracle runs only on `needs_corroboration`, so it can never veto a
  candidate whose evidence already stands. A miss is a no-op.

### Quota

- Trend Tree draws on the shared `dev@trendhunter.com` SerpApi plan ($275/mo, 30,000 searches,
  ~$0.009/call). The agreed ceiling while exploring is 100 searches a day: TikTok 50, Reddit 40,
  10 headroom. Keeping either source past exploration, or needing more, reopens the quota with the
  plan owner (CRMA-1321).

## Testing Decisions

- **What a good test is here.** A test drives one seam with fakes for every external system and
  asserts only on what crosses the seam: the SerpApi requests made, the rows written, the value
  returned. It never asserts on helper functions, intermediate arrays or prompt text.
- **Seam 1 — the TikTok ingest function in `services/lib`.** Tests call it with a fake SerpApi
  search, a fake title filter and a fake Snowflake `query` that records every statement. This one
  seam covers the seed list, the query shape, the 50-call cap, empty-title drops, the filter's
  keep/drop, dedup against existing video IDs and within a run, the video-ID timestamp decode and
  its fetch-time fallback, the row and `METADATA` shape (including the absent `search_query`), and
  the rule that a failure before the write sends no Snowflake statement. The SerpApi client's
  request building is covered here through the parameters the fake search receives. Prior art:
  `services/lib/catalog_sync.test.mjs` (fake `query` that records statements, feed failure writes
  nothing). The tests run under `scripts/test_services_lib.sh`, and the new test file joins its
  explicit file list.
- **Seam 2 — the oracle adapter contract in `services/promotion`.** The Reddit adapter is tested
  the way CRMA-1242 tests the ET adapter: through the typed decider, with a fake Jev and a fake
  SerpApi search. Tests cover call order and stop-at-first-`same_concept` (Reddit not called on an
  ET match), the shared keyword, the thread-link and 10-comment filters, the daily cap and its
  skip-for-budget record, the `failed`-at-stage-`oracle` path, the `JUDGMENT_DETAIL` tags, and
  that the oracle never runs when evidence stands. Prior art is whatever CRMA-1242 lands for the
  ET adapter; the CRMA-1332 keyword test is the model for the keyword case.
- **Deploy layout.** `services/deploy_layout.test.mjs` covers the new service's Dockerfile and
  staging, as it does for every service.
- **No new seam for the audit change or the prompt row.** The `tiktok` freshness check is verified
  live: after the first run, query the audit's row for `tiktok` and confirm it reads `EMBEDDED_AT`.
  The prompt row is verified by the audit's own prompt-drift check staying GREEN.
- **Live verification, not tests.** "It worked" means rows landed: `tiktok` rows in `FCT_SIGNALS`
  with `EMBEDDED_AT` set after the first scheduled run; Reddit-tagged `JUDGMENT_DETAIL` entries after
  the first corroboration-needing candidate on the typed path.
- **First-week checks (fixed in advance, not tests).** TikTok: hand-grade a sample of the first
  week's `tiktok` rows with the distillation rubric; below 30% PASS, TikTok drops. Reddit:
  hand-check the first week's Reddit-rescued candidates; below 70% real corroborations, Reddit
  comes off the oracle list. Also measure the live `needs_corroboration` rate once Snowflake is
  reachable, against the 40-a-day budget.

## Out of Scope

- **Kickstarter, in any role.** It fails as a trend source: 4% PASS, an index dominated by games
  and books (CRMA-1317). Its other homes, an input to `services/ecomm-agent` or CSA sourcing
  (PGS-836), are product-sourcing inputs, not trend signal, and belong to a different effort.
- **Reddit as a source.** Reddit writes no `FCT_SIGNALS` row. Its `site:reddit.com` coverage was 0%
  PASS as a source (CRMA-1317).
- **SerpApi as an agent search tool.** No distillation or enrichment agent gains a SerpApi tool.
- **Reddit on the incumbent Gemini decider.** The incumbent path keeps `[exploding_topics]`.
- **The typed Jev decider itself.** It is the CRMA-1214 map's work; this spec only adds an adapter
  to it.
- **Changes to `sourceFamilyOf()`, the shared MERGE, `MARKETING_TASK_PROMOTE_SIGNALS_TO_FCT`, or the
  dashboard's publisher mapping.** All already handle `tiktok`.
- **A Reddit or provider-neutral oracle ledger.** Rejected in ADR-0004's amendment.
- **Surfacing Reddit corroboration in ATLAS.**
- **A Trend Tree SerpApi plan of its own, or quota above 100 searches a day.**
- **Reviving the Creative Center scraper** (`ingestion/tiktok-p_yKCm9Am`). It stays deactivated.

## Further Notes

- **The two halves ship independently.** The TikTok ingester has no dependency on the CRMA-1214
  map. The Reddit adapter is blocked until the typed decider exists in `services/promotion`. If
  the CRMA-1214 map rejects Jev, the Reddit adapter does not ship, and its role needs a new
  decision.
- **The TikTok filter result rests on a small sample.** The LLM filter lifted TikTok to 45% PASS on
  the category seeds and 35% overall, over 108 results (CRMA-1325). Its known leak is sneaker model
  and colorway posts. The first-week spot-check is the real measurement.
- **Evidence behind each decision** lives in the map's assets:
  `docs/wayfinder/assets/crma-1316-serpapi-coverage.md`,
  `docs/wayfinder/assets/crma-1317-serpapi-sample-grades.md`,
  `docs/wayfinder/assets/crma-1325-tiktok-fix-sample.md` and
  `docs/wayfinder/assets/crma-1325-filter.py` (the prototype filter prompt).
- **Decision tickets:** CRMA-1316 (coverage), CRMA-1317 (sample grades), CRMA-1318 (roles),
  CRMA-1319 (where it runs), CRMA-1320 (seed queries), CRMA-1321 (quota), CRMA-1325 (TikTok
  filter), CRMA-1330 (TikTok row shape), CRMA-1326 (Reddit oracle).
- **Test seams were chosen without a check-in** because this spec was written in a background job.
  Review them in the spec PR: one seam per half, both at the highest point that already exists or
  is already planned.
