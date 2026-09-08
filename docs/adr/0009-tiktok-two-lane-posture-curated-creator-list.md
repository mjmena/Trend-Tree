# TikTok runs two lanes over a curated creator list

**Status:** accepted (2026-09-08). **Supersedes ADR-0007** in full — do not
implement from that ADR. It was written before any of TikTok's surfaces had
been measured, and five of its decisions were wrong about the vendor's actual
behaviour.

## Context

ADR-0007 reopened TikTok as a vendor-scraped direct platform source on a
hashtag-funnel-first query posture, with a ~7-day freshness filter, curated
lists held in the repo, and a ~$1–2/1k cost model. Four measurement tickets
then took that design apart:

- **CRMA-986** (gate checks) found TikTok discovery accepts **no vendor-side
  recency control** in keyword mode — only `search_keyword`, `num_of_posts`
  and `country`. The freshness guard had to run after the pull, on records
  already paid for.
- **CRMA-1017** measured the resulting discard rate. Fresh-record yield was
  **7.3%** on plain keyword input and **15.0%** on `#`-prefixed keyword input
  against a 7-day guard (n=358), so the real cost was **$10–20/1k usable**,
  five to ten times the modelled figure. Discovery is **engagement-ranked, not
  recency-ranked** — fresh records had a median 8.9k plays against 271k
  overall — so raising `num_of_posts` cannot improve yield. There is no lever
  on the discard rate.
- **CRMA-1021** widened the guard to **90 days**, which lifts yield to 47.2%
  at $3.18/1k usable, and reframed the source's job: TikTok is for
  **corroboration and evidence breadth**, not emergence detection. It also
  established that `discover_by=url` — ADR-0007's hashtag-page funnel — is
  **dead**: 13 inputs over 2 days returned 0 records, including Bright Data's
  own documented example.
- **CRMA-1023** measured the dataset's third mode, `profile_url`, the only one
  accepting `start_date` / `end_date` / `sort_by`. The date filter **binds
  server-side at 100%** (139 of 139 records in window, median age 14 days),
  verified sharp in both directions by undated controls. Coverage is
  near-disjoint from `#`-keyword — **1 overlap in 239 records**. In-window
  cost falls to vendor list price, **$1.50/1k**.

CRMA-1005 separately settled the `search-tiktok` **agent search tool** —
ADR-0007's role B — as a blocking in-process call inside the migrated
enrichment service that **writes no signals**. That decision stands and is not
revisited here; this ADR governs the ingester only.

CRMA-1023 also moved the bottleneck. `profile_url` is a **precision** lane, not
an ambient one: 19 curated creators produced only ~2.8 records/day, and a
curated list **cannot discover a creator who is not already on it** — of the 96
distinct creators `#`-keyword search surfaced, exactly one was on the list.
Curation is measurably hard: **10 of 34** nominated handles were impostor or
empty accounts **returning HTTP 200**, so a naive existence check passes them,
and 2 more were dormant despite large back catalogues — invisible to anything
but a dated pull.

That left one question, decided on CRMA-1024: what feeds the list, and what is
`#`-keyword for now.

## Decision

**TikTok runs two lanes over one curated creator list held in Snowflake.**

- **`profile_url` is the quality spine.** Dated pulls over curated creator
  handles. Every delivered record is in window, so the freshness guard costs
  nothing instead of discarding 85–93% of what it bills for.
- **`#`-keyword is the breadth lane, and it does two jobs at once.** It writes
  guarded signals **and** nominates creators for the list. The records are
  billed on delivery either way, so extracting handles from them is free.
  It runs at lower volume than CRMA-1021's $15–25/mo, because `profile_url`
  now carries the fresh spine.
- **The list is sized by curation capacity, not by a volume target.**
  CRMA-1023's "300–1,000 handles" figure is **dropped as a design goal**.
  Matching `#`-keyword's throughput through `profile_url` alone would need
  roughly 1,300 nominations to save about $8 a month. Working figure: **~150
  handles**, with a **per-vertical floor** rather than a total.
- **The pull window is rolling — `start_date` is the last successful run, not
  a fixed 90 days.** Pulling a fixed 90-day window daily re-delivers and
  **re-bills** the same records: at 150 handles that is ~$101/month against
  ~$1.11/month for a rolling window. Dedupe in the `STG_EXTERNAL_SIGNALS`
  MERGE stops duplicate signals; it does not stop duplicate spend. The 90-day
  figure survives in two narrower roles — the **backfill ceiling** on a newly
  admitted creator's first pull, and the **post-write assertion** the
  distillation `SIGNAL_TIMESTAMP` guardrail needs.
- **The list lives in a Snowflake table on the `DIM_CATALOG_PRODUCT`
  soft-delist pattern** — rows never deleted, status flips, `LAST_SEEN_AT`
  drives detection. Each row carries a **vertical tag**, its rubric score, and
  its observed health.
- **Admission is automatic.** A nominated handle is validated for free by
  fetching `tiktok.com/@handle` and reading `uniqueId` / `followerCount` /
  `videoCount`, which catches the entire 29% impostor-and-empty class, then
  rubric-scored by an LLM against the #18 specificity rubric on a bounded
  probe pull. Probe records are written as signals **only if the creator
  passes**. Two guards: a **minimum record count** before the gate fires, since
  a rate over three records is noise, and an **absolute threshold** starting
  near 30% — corpus-wide rubric pass is 51.1%, so a 50% bar would halve the
  list on day one.
- **Only `dead_page` demotes automatically.** N consecutive dated pulls
  returning *"There are no public posts in the profile for the specified
  period"* means dormant, and it costs nothing to observe because unsuccessful
  deliveries are not billed. Rubric drift and a high missing-`description`
  rate surface on the row for human action but never fire on their own.
- **Bootstrap and steady state are the same mechanism at different volumes.**
  Seed with CRMA-1023's 19 measured handles, then run the nomination lane at
  elevated per-vertical volume until each vertical reaches its floor. Reaching
  ~150 handles costs roughly **$0.32** in vendor credits.

ToS risk acceptance carries forward from ADR-0007 unchanged: the scrape is
limited to public data, and the route carries audit-agent freshness coverage
(CRMA-989) as a launch requirement.

## Considered options (and why rejected)

- **`#`-keyword as a nomination lane only, writing no signals** — CRMA-1023's
  own recommendation. Rejected on three grounds: the records are already
  billed, so discarding the signal half throws away what you bought; they are
  safe to write, unlike the `search-tiktok` tool lane that CRMA-1005 barred
  precisely because it applies no freshness guard; and evidence breadth is the
  job CRMA-1021 assigned this source — Arm B's 100 records came from **96
  distinct creators** against Arm A's 139 from **17**. A corroboration source
  whose evidence all traces to seventeen voices is thin at any volume.
- **Dropping `#`-keyword entirely** — the list could then only grow by a human
  trawling TikTok, which is the cost this design exists to avoid.
- **Chasing 300–1,000 handles for volume parity** — needs ~1,300 nominations
  at the measured 65% survival rate to save about $8/month.
- **A repo-maintained creator list**, as ADR-0007 specified and as all seven
  of this repo's other curated lists are held. Rejected because the row carries
  state a *job* writes — `dead_page` count, last-seen date, rubric score — and
  on this repo a commit to `production` **is** a Pipedream deploy, so a
  liveness sweep would have to open pull requests to record what it observed.
- **`DIM_LLM_PROMPT`'s governance pattern** — migration-only edits, a manifest
  inside the audit agent, drift as a governance RED. Over-engineering here:
  that machinery exists because a prompt changes agent behaviour invisibly,
  whereas a creator list's effect is visible in the records it produces.
- **A hybrid — membership in the repo, observed state in Snowflake.** Two
  sources of truth needing reconciliation is exactly the problem the
  `DIM_LLM_PROMPT` manifest had to be built to solve; one instance is enough.
- **Human-gated nomination** — at ~96 candidate creators per 100 records the
  queue backlogs immediately, and a backlogged queue is indistinguishable from
  having no nomination lane.
- **Auto-demotion on rubric score** — a creator can have a quiet month, and a
  rolling auto-score would churn the list against the decision to gate at
  nomination.

## Consequences

- **This is the repo's first human-curated configuration in Snowflake outside
  `DIM_LLM_PROMPT`**, and the first curated list of any kind with a health
  sweep. Its health row — live handles, newly dormant, `dead_page` rate,
  per-vertical counts — belongs to **CRMA-989**, not to a governance drift
  check.
- **The vertical tag must reuse the discovery tier's existing vocabulary.**
  CRMA-1023 scored against food / wellness / travel / **home**, `CLAUDE.md`
  names four LLM verticals, and `discovery-p_5VCPP3N/build_discovery_context/`
  ships six. The spec reconciles those; what must not happen is a third set of
  vertical names entering the repo through this table.
- **Automatic admission means no human sees a creator before their content
  enters the evidence pool.** Accepted: these records are internal evidence
  attached to a trend, not published content, and demotion is a single row
  update. Recorded here because a future reader will ask.
- `/to-spec` inherits an unbuilt lane and six measured traps. `buildTikTok()`
  in `services/lib/scrape_requests.mjs` hard-codes `discoverBy: "keyword"` and
  has **no `profile_url` path**; `services/lib/sources/` and
  `services/lib/tools/` do not exist. `start_date` is **not format-validated** —
  `"banana"` passes and the job runs, silently no-opping the guard — so assert
  the format at the call site. `dead_page` is a **liveness signal, not an
  error**. The `hashtags` array is populated on only **37 of 139** records, so
  parse `description` as a fallback. `sort_by` governs selection, not delivery
  order. And **8 of 139 records (5.8%) fail `scrape_normalize`'s required
  `description` field, 7 of them from one creator** — a curation signal, not a
  scraper fault.
- Two bindings carry forward from CRMA-1021 unchanged: distillation gets the
  `SIGNAL_TIMESTAMP` drift guardrail as a `sql/update_prompts_*.sql` migration
  with the matching `q_prompt_drift` manifest bump (CRMA-469), and the
  rubric-plausibility filter must be **deterministic and pre-write** and must
  **not** match on query-term presence.
- **There is no US geo-targeting at any price.** Bright Data refuses
  `country: "US"` on both the async and sync paths while accepting CA, MX, FR,
  AU, GB, IN, BR, DE, JP, PR and GU. Un-geo-targeted is the only posture on
  offer, and 47.2% stands as the measured `#`-keyword yield.
- The reopen stays reversible: shutting TikTok off is a status flip on the
  table plus a cron removal, not schema surgery.
