# CRMA-1427: What the pipeline does with a trend that has no linked signals

Research date: 2026-10-06. Snowflake was read between 12:25 and 12:45 Eastern time (16:25 to 16:45 UTC), role `MARKETING_ENGINEER`, with `SELECT`, `SHOW` and `DESCRIBE` only. No workflow was fired. No table was written.

Parent map: CRMA-1424 "Map: an endpoint to ingest an editorial trend". This file reports facts. It makes no design decision.

Legend:

- **[MEASURED]** A number read from Snowflake on 2026-10-06. The SQL is in the appendix.
- **[CODE]** Read in this repo at the cited path and line. Where it matters, the live object was compared to the repo and that is stated.
- **[INFERENCE]** A conclusion drawn from code and measurements together. It was not observed directly.

Terms follow `CONTEXT.md`. A "linked signal" is a row in `FCT_TREND_SIGNALS` for the trend, with [link kind] `supporting` or `attributed`. A "live" trend is a `FCT_TRENDS` row whose latest `FCT_TREND_LIFECYCLE_LEDGER` row is not `RETIRED`.

A note on time: the ledger timestamps (`PROMOTED_AT`, `EVALUATED_AT`, `LINKED_AT`) are stored without a time zone and hold Eastern local time. [MEASURED: `MAX(EVALUATED_AT)` was 12:09 when the session clock read 12:28 Eastern and 16:28 UTC.] All ages below are computed against Eastern local time.

## The natural experiment

The pipeline already holds trends that were promoted with no evidence. They are the measured basis for most answers below.

- 20 trends were created from a [candidate] whose `SUPPORTING_SIGNAL_IDS` array is empty and whose `SOURCE_BREAKDOWN` is `{}`. All 20 have `ET_WAS_SECOND_SOURCE = TRUE`. They were promoted between 2026-08-28 and 2026-09-21. [MEASURED]
- 19 of the 20 still have zero rows in `FCT_TREND_SIGNALS` today. One gained `supporting` links later (not examined). [MEASURED]
- These 19 are the only live trends with zero linked signals. Example: trend `2264167e-680d-4a47-8449-a4f230713354` "Ghost Lashes", promoted 2026-08-28 19:15, candidate confidence 0.8, zero supporting signals. [MEASURED]

## TL;DR

1. **Heat.** A trend with 0 linked signals shows a `HEAT_INDEX` of 8.4 to 9.6 on `DT_TREND_DASHBOARD` (19 trends, median 8.6). That is 10 times the promotion confidence and nothing else. For the first two days it shows a higher number (33.0 to 34.5 at promotion) that decays. [MEASURED]
2. **Lifecycle.** The lifecycle agent sets `NEW` for the first 24 hours, then `STABLE`. It never sets `DORMANT` or `RETIRED` for such a trend. The rubric has no path to `DORMANT` from zero signals. All 19 are `STABLE` at 15 to 39 days old. [MEASURED + CODE]
3. **Enrichment.** The `dispatcher` → `sources` → `enrichment` → `write` chain completes. All 19 have a full `initial` enrichment record, written 2.1 to 3.0 minutes after promotion, with 3 to 6 evidence items. No step errors on an empty signal set. [MEASURED + CODE]
4. **Attribution.** Such a trend is eligible, and it has a `TREND_VECTOR` from promotion. In practice it gets nothing: 0 of the 20 trends has ever received an `attributed` link. The wider fact is that 0 of the 192 trends promoted since 2026-07-20 has one, whatever their evidence. [MEASURED]
5. **Population.** Of 540 live trends, 19 have 0 linked signals, 44 have 1, and 117 have 2. Their median heat is 8.6 in every group. [MEASURED]

Two findings outside the five questions change how to read them. The hourly lifecycle sweep is full: it evaluates 25 trends per hour, 394 are due, and 220 live trends have not been evaluated for more than 7 days. And the attribution sweep only reaches trends whose place in its queue is about 11 weeks old. Both are detailed under "Other findings".

## 1. Heat

### Answer

A trend with 0 linked signals scores only the confidence term. On `DT_TREND_DASHBOARD` the 19 such trends show `HEAT_INDEX` 8.4 to 9.6 (p25 8.4, median 8.6, p75 8.6). [MEASURED]

### The formula and which terms need linked signals

`heat_base = 25*recency + 25*velocity + 40*breadth + 10*confidence` [CODE: `lifecycle-subagent-p_gYC562o/run_subagent/entry.js:263-267`; same in `docs/dashboard/fields/heat-index.md:14-20`]

In this table `entry.js` is `lifecycle-subagent-p_gYC562o/run_subagent/entry.js` and `workflow.yaml` is `lifecycle-subagent-p_gYC562o/workflow.yaml`.

| Term | Points | Source | With 0 linked signals |
|---|---:|---|---|
| recency | 25 | Newest linked signal in the last 14 days: `exp(-hours/120)`. `entry.js:231-236`; prefetch `q_recent_signals`, `workflow.yaml:235-262`. | 0. "no-rows → 0" (`entry.js:230`). |
| velocity | 25 | Linked signals in the last 7 days, `min(1, n/3)`. `entry.js:240-245`. | 0. This is the "0 linked = 0 pts" comment at `entry.js:239`. |
| breadth | 40 | Distinct publisher domains among linked signals in the last 21 days, times Shannon entropy. `entry.js:253-258`; prefetch `q_signal_domains`, `workflow.yaml:133-212`. | 0. One domain also scores 0 (`log2(1) - 0.5` is below zero, and entropy of one value is 0). |
| confidence | 10 | `STG_TREND_CANDIDATES.CONFIDENCE`, joined through `FCT_TRENDS.CANDIDATE_ID`. `workflow.yaml:61` and `:75`; `entry.js:261`. | Unchanged. It does not read `FCT_TREND_SIGNALS`. |

The confidence term has a default. `Number(metrics?.confidence || 0.5)` (`entry.js:261`) gives 0.5 when the candidate row is missing, when `CONFIDENCE` is null, and when it is 0. That is 5.0 points. [CODE]

After `heat_base`, the commit applies a fixed factor per status: `GROWING` and `RESURGENT` +10%, `STABLE` and `NEW` 0, `DECLINING` −10%, `DORMANT` −15%. Then it smooths: `new_smoothed = 0.5 * prior_smoothed + 0.5 * new_heat`. [CODE: `sql/proc_lifecycle_apply.sql:65-69` and `:192-203`. The live procedure matches the repo on these lines, checked with `GET_DDL` on 2026-10-06.]

The dashboard shows the smoothed value: `ROUND(COALESCE(tb.TREND_HEAT_INDEX, 0), 1)` where `TREND_HEAT_INDEX = COALESCE(HEAT_INDEX_SMOOTHED, HEAT_INDEX)`. [CODE: `sql/dt_trend_dashboard.sql:409` and `:433`; the live dynamic table has the same two lines.]

### What promotion writes first

Promotion seeds one lifecycle row with a heat that assumes the signals were just linked: `25 + 25*min(1, supporting_count/3) + 40*log_score(source_families) + 10*confidence`. [CODE: `sql/proc_promotion_apply.sql:241-249`] With zero supporting signals that is `25 + 10*confidence`. The 25 recency points are granted even though there is no signal.

Measured on the 19 trends: seed `HEAT_BASE` 33.0 to 34.5 (confidence 0.80 to 0.95). The latest evaluation of each computes `HEAT_BASE` 8.0 to 9.5. [MEASURED]

Row-level example, "Ghost Lashes" (confidence 0.8):

| Evaluated at | Status | `HEAT_BASE` | Smoothed heat shown |
|---|---|---:|---:|
| 08-28 19:15 (promotion seed) | NEW | 33.0 | 33.0 |
| 08-28 21:09 | NEW | 8.0 | 20.5 |
| 08-29 10:09 | NEW | 8.0 | 14.2 |
| 08-29 23:09 | STABLE | 8.0 | 11.1 |
| 08-30 06:09 | STABLE | 8.0 | 9.6 |
| 08-30 13:09 | STABLE | 8.0 | 8.8 |
| 08-30 20:09 | STABLE | 8.0 | 8.4 |

It still shows 8.4 today because it has not been evaluated since 2026-08-30 (see "Other findings", A).

### Notes

- `docs/dashboard/fields/heat-index.md:68` says a trend with zero linked signals in 21 days scores "typically ~5–7". The measured value is 8.0 to 9.5, because the promotion confidence on these trends is 0.80 to 0.95.
- A trend with 1 or 2 linked signals ends at the same number once the signals age: recency and velocity reach 0 after 14 days, and breadth is 0 with one publisher. Median heat is 8.6 for the 1-signal and the 2-signal groups as well. [MEASURED]
- A `FCT_TRENDS` row with no lifecycle ledger row at all would show `HEAT_INDEX` 0.0 and a null `LIFECYCLE_STATUS`. [CODE: `sql/dt_trend_dashboard.sql:408-409`, `:433`, `:442`] No such row exists today: all 590 trends have a ledger row. [MEASURED]

## 2. Lifecycle

### Answer

`NEW` for the first 24 hours, then `STABLE`, and it stays `STABLE`. All 19 zero-signal trends are `STABLE`. Their ledgers hold only `NEW` and `STABLE` rows. The oldest is 38.7 days old. [MEASURED]

There is no number of days to `DORMANT` or `RETIRED` for a zero-signal trend. The rubric does not allow the move.

### The prompt text

The live prompts are `lifecycle.subagent.system` version 7 and `lifecycle.subagent.decision_rubric` version 7, both `IS_ACTIVE = TRUE` in `MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT`. [MEASURED] The repo text is `sql/update_prompts_lifecycle_v6_linked_evidence.sql`, with the Google Trends sentences removed by `sql/update_prompts_lifecycle_v7_remove_gtrends.sql`. The MD5 of the repo-derived version 7 text equals the live `CONTENT_HASH` for both keys (`69a5a8ed…` and `2b16f416…`), so the quotes below are the live text. [MEASURED]

Thresholds, quoted from the rubric (line numbers are in `sql/update_prompts_lifecycle_v6_linked_evidence.sql`):

- Line 190: "For trends < 7 days old with zero post-promotion linked signals: always default to STABLE — absence of post-promotion links is the expected system state, not decay."
- Lines 195-197, status `NEW`: "If the trend was promoted less than 24 hours ago: Status MUST remain NEW. … Return: status=NEW, next_eval_in_hours=12"
- Line 203, status `NEW` at 24 hours or older: "No new linked signals since promotion → STABLE"
- Lines 228-232, `STABLE` to `DECLINING`: "ALL THREE conditions required: 1. n7 ≤ half of n7_prior 2. Trend is ≥ 7 days old 3. (n7 + n7_prior) ≥ 5 If any condition is not met: keep STABLE."
- Lines 239-240, `DECLINING` to `DORMANT`: "Zero linked signals in the last 14d (no rows in the linked window)."
- Lines 257-259, `DORMANT` to `RETIRED`: "DORMANT for ≥ 30 days AND active_domains = 0 (no publisher activity in 21d). First proposal: log it; second consecutive proposal: commit."

`n7` is linked signals in the last 7 days and `n7_prior` is linked signals 7 to 14 days ago. A zero-signal trend has `n7 + n7_prior = 0`, so condition 3 fails and it can never leave `STABLE` for `DECLINING`. `DORMANT` is only offered from `DECLINING` and `RESURGENT`. `RETIRED` is only offered from `DORMANT`. [CODE]

The agent says the same thing in its own reasoning. Trend `0d291db0-…` "Stealth Cottage Cheese", evaluation of 2026-10-06 06:09, after 131 evaluations: "Zero linked signals in the last 14 days (n7=0, n7_prior=0). The override to DECLINING from STABLE requires a combined total of at least 5 linked signals in the 14-day window. Since this condition is not met (0 < 5), the trend must remain STABLE." [MEASURED]

Across all trends since 2026-07-11 (the first full day of the current rules): 53 of 54 moves into `DORMANT` came from `DECLINING`. One came from `STABLE`, for a trend with 4 linked signals. [MEASURED]

### The two-cycle confirm rule

System prompt, lines 107-111: "Retirement is IRREVERSIBLE. The commit step requires you to propose RETIRE on TWO consecutive evaluations before it actually flips LIFECYCLE_STATUS to RETIRED. Your first proposal lands in `lifecycle_history.RETIREMENT_PROPOSAL` as evidence; the second proposal is what commits."

It is enforced in code, not only in the prompt. On the first `RETIRED` proposal the procedure keeps the prior status and stores the proposal; it commits `RETIRED` only when the previous ledger row also holds a proposal. [CODE: `sql/proc_lifecycle_apply.sql:178-190`]

### For comparison, trends that do have signals

Since 2026-07-11: promotion to first `DORMANT` took a median of 76.2 days (minimum 13.9, 47 trends). First `DORMANT` to `RETIRED` took a median of 40.2 days (minimum 8.3, 35 trends). [MEASURED]

### Where the sweep cadence per status is set

- The agent picks `next_eval_in_hours` from the rubric's guidance: `NEW` under 24 hours 12; `NEW` at 24 hours or older 6; `GROWING` 4; `STABLE` 6; `DECLINING` 4; `DORMANT` 24; `RESURGENT` 4. [CODE: rubric lines 275-284]
- The commit clamps it to 1 to 168 hours and writes `NEXT_EVAL_AT`. `RETIRED` gets null. [CODE: `sql/proc_lifecycle_apply.sql:205-216`]
- The promotion seed sets the first `NEXT_EVAL_AT` to one hour after promotion. [CODE: `sql/proc_promotion_apply.sql:236`]
- The sweeper selects non-retired trends with `NEXT_EVAL_AT <= now`, ordered by heat, highest first, limited to `sweep_cap`. A trend with no ledger row is due 24 hours after `PROMOTED_AT` and sorts as heat 0. [CODE: `lifecycle-agent-p_JZCz73w/workflow.yaml:36-44`] `sweep_cap` defaults to 25. [CODE: `lifecycle-agent-p_JZCz73w/normalize_event/entry.js:26`]
- The cron is hourly. [MEASURED: one chain per hour for each of the last 30 hours; the evaluations land about nine minutes past the hour.]

The stated cadence does not hold for low-heat trends. See "Other findings", A.

## 3. Enrichment

### Answer

The chain completes. All 19 zero-signal trends have a `promotion_seed` row and an `initial` row in `FCT_TREND_ENRICHMENT_LEDGER`. The `initial` row landed 2.1 to 3.0 minutes after `PROMOTED_AT` (median 2.7). Each holds `summary_long`, a `descriptor`, a vector, and 3 to 6 evidence items (median 4). Median `LLM_COST_ESTIMATE` is $0.131. All 19 have a frozen `TREND_NAME` and a `CATEGORY` on `FCT_TRENDS`. [MEASURED]

Example record, "Ghost Lashes": `initial` written 2026-08-28 19:17:12, two minutes after promotion; category `beauty`; 4 evidence items (Vogue and Harper's Bazaar as `news`, two Bluesky posts as `social`); descriptor query `ghost lashes`. [MEASURED] There were no prefetched signals for this trend, so the evidence did not come from them. [INFERENCE] It came from the agent's own tool searches.

### Every step that reads `FCT_TREND_SIGNALS` or `SUPPORTING_SIGNAL_IDS`

| Workflow / step | What it reads | With an empty result |
|---|---|---|
| `dispatcher-p_8rCBgnl` (all steps) | Neither. It passes `trend_id` to the three workflows. `orchestrate/entry.js:105-165`. | Proceeds. |
| `sources-p_7NCy36w` / `query_metrics` | `COUNT(DISTINCT SIGNAL_ID)` from `FCT_TREND_SIGNALS`. `workflow.yaml:27-31`. | Proceeds. `COALESCE` gives `TOTAL_CLUSTER_SIZE = 0` (`:33`). |
| `sources` / `aggregate` | The count above, as a pass-through field. `aggregate/entry.js:42`. | Proceeds with `cluster_size: 0`. Nothing gates on it. |
| `enrichment-p_xMC995w` / `q_metrics` | `COUNT` over the candidate's `SUPPORTING_SIGNAL_IDS` and over `SOURCE_BREAKDOWN` keys. `workflow.yaml:31-38`. It does not read `FCT_TREND_SIGNALS`. | Proceeds. Both counts are 0. |
| `enrichment` / `q_signals` | The candidate's `SUPPORTING_SIGNAL_IDS`, joined to `STG_EXTERNAL_SIGNALS`, newest 10. `workflow.yaml:85-112`. | Returns zero rows. Not an error. |
| `enrichment` / `q_neighbors` | `SUPPORTING_SIGNAL_IDS` of other trends, for their cluster sizes. `workflow.yaml:185-206`. | Proceeds. `COALESCE` to 0. |
| `enrichment` / `run_enrichment_agent` | The rows from `q_signals`. The prop is optional (`entry.js:760`). | Proceeds. It renders "(no signals)" and "(no metadata)" into the prompt (`entry.js:833-856`) and runs the agent loop. |
| `write-p_o7CWa2K` (all steps) | Neither. `compute_scores` reads source metrics and the agent output; `PROC_ENRICHMENT_APPLY` reads `FCT_TRENDS.TREND_TOPIC`. `sql/proc_enrichment_apply.sql:116-126`. | Proceeds. |

Errors in this chain come from other causes: no `FCT_TRENDS` row (`sources/generate_search_terms/entry.js:34-37`, `enrichment/run_enrichment_agent/entry.js:774-777`), no `TREND_TOPIC` (`generate_search_terms/entry.js:39-41`), or an agent run that returns no output (`write/compute_scores/entry.js:141`). None depends on signals. [CODE]

The agent's tool schema requires an `evidence` array (`run_enrichment_agent/entry.js:312`), and the seed prompt says each evidence URL must come from the prefetched signals or from a tool call the agent made (`sql/insert_enrichment_agent_prompts.sql:85`). With no prefetched signals, the tools are the only source. The live enrichment prompt was not compared to the repo. [CODE]

A side effect: the enrichment searches write signals. For the 19 trends, 553 rows in `STG_EXTERNAL_SIGNALS` carry `signal_kind = 'enrichment_citation'` and the trend's id in `linked_trend_id` (sources `bluesky`, `grok_live`, `google_trends_explore`). All 553 are in `FCT_SIGNALS` with a vector. None is linked to its trend in `FCT_TREND_SIGNALS`. [MEASURED] The tag is written by `enrichment-p_xMC995w` step `tag_signals` (`workflow.yaml:321-350`). Nothing turns the tag into a link. [CODE]

## 4. Attribution

### Answer

A zero-signal trend is eligible and has what the sweep asks for. Measured outcome: none of the 20 trends promoted with zero supporting signals has ever received an `attributed` link, 15 to 39 days after promotion. This is not specific to zero-signal trends. No trend promoted since 2026-07-20 has one. [MEASURED]

### What a trend needs to be eligible

The sweeper `lifecycle-attribution-agent-p_KwCoaap` selects a trend when [CODE: `workflow.yaml:23-54`]:

- it has a row in `FCT_TRENDS`;
- it has at least one `FCT_TREND_ENRICHMENT_LEDGER` row with a non-null `TREND_VECTOR` (inner join, line 49);
- its latest lifecycle status is not `RETIRED` and not `DORMANT` (line 52; no ledger row counts as `NEW`);
- it falls inside the limit. The order is `COALESCE(last attributed LINKED_AT, PROMOTED_AT)` ascending (line 53). The limit is `sweep_cap`, default 30 (`normalize_event/entry.js:25`).

There is no minimum age and no minimum number of existing links.

The subagent `lifecycle-attribution-subagent-p_PACe77B` then takes as candidates the `FCT_SIGNALS` rows that [CODE: `workflow.yaml:76-107`]:

- were embedded in the last `lookback_hours`, default 24 (`handle_request/entry.js:35`);
- have a `SIGNAL_VECTOR`;
- are not already linked to this trend, under either link kind;
- have cosine similarity of 0.35 or more to the trend's latest non-null `TREND_VECTOR`; top 20.

With no candidates it exits without calling the model (`run_subagent/entry.js:353-369`). Otherwise Gemini judges each candidate and the confirmed ones are inserted with `LINK_KIND = 'attributed'` (`workflow.yaml:170-204`).

### Where `TREND_VECTOR` comes from at promotion

`FCT_TRENDS` has no vector column. [MEASURED: `DESCRIBE TABLE`] The vector lives on `FCT_TREND_ENRICHMENT_LEDGER`.

- At promotion, `seed_enrichment_v0` writes a `promotion_seed` row whose vector is `SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', t.TREND_TOPIC)`. It runs in the same transaction as the `FCT_TRENDS` insert. [CODE: `sql/proc_promotion_apply.sql:257-281` and `:450-451`; the live procedure matches.]
- The first enrichment writes an `initial` row whose vector is the same model over `FN_TREND_EMBED_DOC(topic, payload)`. That row becomes the latest. [CODE: `sql/proc_enrichment_apply.sql:71-93`]

Neither depends on signals. The vector exists only if one of these two procedures ran for the trend. All 19 zero-signal trends have both rows, with vectors. [MEASURED]

### What was measured

- All 19 zero-signal trends pass the eligibility query. [MEASURED]
- Each has candidate signals at the retrieval step: 2 to 18 signals embedded in the last 24 hours at similarity 0.35 or more (12 to 116 over 7 days; best match 0.41 to 0.77). [MEASURED]
- Yet 0 of the 20 has an `attributed` link. [MEASURED]
- By promotion month, trends with at least one `attributed` link: April 106 of 119; May 96 of 100; June 90 of 102; July 51 of 110; August 0 of 88; September 0 of 65; October 0 of 6. [MEASURED]
- Among trends promoted since 2026-07-20, by supporting-signal count: 0 signals 0 of 19; 1 signal 0 of 37; 2 signals 0 of 92; 3 or more 0 of 44. [MEASURED]
- In the last 14 days, every trend that received an `attributed` link had a queue value (its previous attributed link, or its promotion time) at least 70 days old. The newest was 2026-07-18. Daily volume was 1 to 6 links on 1 to 5 trends, except 67 links on 2026-09-29. [MEASURED]
- Replaying the sweeper's selection today: 491 trends are eligible and 211 of them have never had an `attributed` link. The first 30 in the order have queue values from 2026-04-28 to 2026-07-19. The 19 zero-signal trends sit at positions 259 to 417. [MEASURED]

### Why, as far as the evidence goes

[INFERENCE] A trend's place in the order only moves when an `attributed` link is written for it. A trend that is selected and gets no link keeps its old value and is selected again the next hour. So the front of the queue is held by old trends that rarely match, and a trend promoted today waits behind every trend with an older value. The front moved from about 2026-07-14 to 2026-07-18 over the last 14 days.

A second consequence follows from the 24-hour lookback. The signals that enrichment itself finds for a new trend are candidates for one day only. The sweep does not reach a new trend in that day. [INFERENCE]

## 5. Population

Measured 2026-10-06, about 12:35 Eastern. `FCT_TRENDS` holds 590 rows. 540 are live and 50 are `RETIRED`. "Linked signals" is `COUNT(DISTINCT SIGNAL_ID)` in `FCT_TREND_SIGNALS`; it equals the dashboard's `TOTAL_CLUSTER_SIZE` for every trend.

| Linked signals | Live trends | Status | Heat: min / p25 / median / p75 / p90 / max | Heat ≤ 10 | Days since promotion: min / median / max |
|---|---:|---|---|---:|---|
| 0 | 19 | 19 `STABLE` | 8.4 / 8.4 / 8.6 / 8.6 / 9.2 / 9.6 | 19 | 15.1 / 33.7 / 38.7 |
| 1 | 44 | 44 `STABLE` | 8.3 / 8.4 / 8.6 / 8.6 / 9.1 / 34.8 | 40 | 2.1 / 52.6 / 89.5 |
| 2 | 117 | 109 `STABLE`, 8 `DORMANT` | 8.2 / 8.4 / 8.6 / 9.1 / 20.0 / 42.1 | 96 | 2.7 / 50.6 / 113.7 |
| 3 or more | 360 | 313 `STABLE`, 41 `DORMANT`, 5 `DECLINING`, 1 `NEW` | 7.2 / 8.3 / 8.6 / 9.1 / 18.5 / 80.1 | 305 | 1.2 / 125.3 / 162.6 |

Not live: 3 `RETIRED` trends with 2 linked signals and 47 with 3 or more.

Low heat is the normal state, not a mark of missing evidence: 460 of 540 live trends show heat of 10 or less.

Where the low counts come from: the 19 zero-signal trends have candidates with an empty `SUPPORTING_SIGNAL_IDS`. The 44 one-signal trends have exactly one supporting id and no `attributed` link. Of the 117 two-signal trends, 5 hold an `attributed` link. Of the 360 with 3 or more, 306 do. [MEASURED]

The 8 `DORMANT` trends with 2 linked signals are 97 to 114 days old. The one examined (`5ad3d13a-…`) reached `DECLINING` on 2026-07-09 under the earlier rules, which counted unlinked signals, and `DORMANT` on 2026-07-16. [MEASURED]

### Example rows

| Trend id | Trend name | Heat | Status | Days since promotion | Linked signals |
|---|---|---:|---|---:|---:|
| `2264167e-680d-4a47-8449-a4f230713354` | Ghost Lashes | 8.4 | STABLE | 38.7 | 0 |
| `0d291db0-87d6-460b-a8c0-9bcf0b3b5bf7` | Stealth Cottage Cheese | 9.6 | STABLE | 38.6 | 0 |
| `1a45f446-7964-492f-8726-0695d8157631` | Dumbphone Conversion | 8.6 | STABLE | 15.1 | 0 |
| `fe268a65-4818-4644-a864-291e1a35f376` | Faux Freckle Pens | 34.8 | STABLE | 2.1 | 1 |
| `abe7128f-85c9-4d58-a503-ea50a6f264d1` | Urolithin A Supplements | 8.6 | STABLE | 45.5 | 1 |
| `bd08b822-5987-4ffa-b7b0-8e9838a50d8a` | Breath-Pacing Pendants | 8.6 | STABLE | 89.5 | 1 |
| `dd4e3957-6e48-4784-80a0-285eaba4596d` | Active EEG Sleep Headbands | 11.1 | STABLE | 2.7 | 2 |
| `267a2c6d-7f12-4a1c-969c-6141101ff85e` | Pre-Purchase Resale Audits | 9.1 | STABLE | 45.1 | 2 |
| `5ad3d13a-51ce-4706-aa61-598c1d525e40` | Sculpting Blush Draping | 8.2 | DORMANT | 97.0 | 2 |

## Other findings

### A. The lifecycle sweep is full, and low-heat trends stop being evaluated

- The sweep wrote exactly 25 evaluations in 27 of the last 30 hours, and 22 to 24 in the other three. [MEASURED]
- 394 of 540 live trends are due now (`NEXT_EVAL_AT` in the past). 203 were evaluated in the last 24 hours. 220 have not been evaluated for more than 7 days; the longest wait is 80.7 days. [MEASURED]
- The order is heat, highest first (`lifecycle-agent-p_JZCz73w/workflow.yaml:43`). The 220 trends waiting more than 7 days all have heat of 8.6 or less. [MEASURED]
- Of the 19 zero-signal trends: 17 are due now, 4 were evaluated in the last 24 hours, and 8 have not been evaluated for more than 7 days (longest 36.7 days). "Ghost Lashes" was evaluated 7 times in its first two days and not since 2026-08-30. The 8 that stopped all have confidence 0.8, so a heat of 8.4. The 8 with confidence 0.85 are evaluated on and off (15 to 27 evaluations each). The 3 with confidence 0.9 or 0.95 are evaluated steadily (116 to 131 evaluations each). [MEASURED]
- `DORMANT` trends are caught the same way. 49 trends are `DORMANT`. 45 have been `DORMANT` for 30 days or more. Their median time since the last evaluation is 71.2 days, and 1 was evaluated in the last 48 hours. The 30-day retirement rule is not being applied to them. [MEASURED]
- [INFERENCE] A trend with no ledger row sorts as heat 0, behind all 394. It would not be picked while the queue is this long.

### B. Fields a zero-signal trend leaves empty, and fields it fills

Measured on the 19 trends, from `DT_TREND_DASHBOARD`:

- `TOTAL_CLUSTER_SIZE` 0, `DISTINCT_SOURCE_COUNT` 0, `DISTINCT_PUBLISHER_COUNT` 0 for all 19. They come from `FCT_TREND_SIGNALS` only (`sql/dt_trend_dashboard.sql:217-231`, `:406-407`, `:441`).
- `PREDICTION_ELIGIBLE` false for all 19. `PREDICTION_FLAG` null for all 19. `PREDICTION_SCORE` null for 9 and about 35 for the other 10 (maximum 36.6).
- Filled by enrichment, with no linked signals: `TOP_SIGNALS` 19 of 19 and `SOCIAL_EVIDENCE` 19 of 19 (both built from the enrichment evidence, `sql/dt_trend_dashboard.sql:232-255`), `GENERAL_EVIDENCE` 9, `RELATED_TRENDS` 9, `NEAREST_CONTENT` 17, the trend vector 19.
- `SOURCING_STATUS` is `no_match` for all 19, so product sourcing ran for them.
- `DT_TREND_DAILY` shows `SIGNAL_COUNT` 0 and `SOURCE_COUNT` 0 (checked for one trend).

### C. Prediction agent

`PREDICTION_ELIGIBLE` requires `(source_delta > 0 OR signal_delta > 0)`, both counted from `FCT_TREND_SIGNALS`. [CODE: `prediction-agent-p_QPCkLP1/commit_to_ledger/entry.mjs:240-245`, deltas at `:183-188`] A zero-signal trend has both at 0 and cannot be eligible. Measured inputs for "Stealth Cottage Cheese": `INPUT_SOURCE_DELTA` 0, `INPUT_SIGNAL_DELTA` 0, score 35.1.

The score is null when the trend is under 14 days old or when there is no lifecycle row near 7 and near 14 days ago (`:201-206`, windows at `:92-117`). "Ghost Lashes" has a null score for that reason: it has no evaluation in those windows. [MEASURED]

### D. Audit agent

- `q_stuck_trends` flags a trend promoted more than 6 hours ago with no `initial` or `refinement` enrichment row. It does not read `FCT_TREND_SIGNALS`. [CODE: `audit-agent-p_xMC9nm3/workflow.yaml:234-273`]
- `q_orphan_trends` counts trends whose links all point at signal ids missing from `FCT_SIGNALS`. It starts from `FCT_TREND_SIGNALS`, so a trend with zero rows there is not counted. [CODE: `workflow.yaml:274-314`]
- No audit query counts trends with zero linked signals.

### E. Paths that assume a candidate row

- `FCT_TRENDS.CANDIDATE_ID` is `NOT NULL` in the live table. [MEASURED: `DESCRIBE TABLE`] `PROMOTED_AT` is nullable with default `CURRENT_TIMESTAMP()`.
- The promotion seed for the lifecycle ledger inner-joins `STG_TREND_CANDIDATES` on `CANDIDATE_ID`. Without a matching candidate row it inserts nothing. [CODE: `sql/proc_promotion_apply.sql:250-252`]
- The lifecycle subagent left-joins the candidate for `CONFIDENCE`; a miss gives the 0.5 default. [CODE: `lifecycle-subagent-p_gYC562o/workflow.yaml:75`, `run_subagent/entry.js:261`]
- Enrichment's `q_signals` inner-joins the candidate; a miss gives zero rows and the "(no signals)" path. [CODE: `enrichment-p_xMC995w/workflow.yaml:85-92`]
- The lifecycle subagent, the attribution subagent, `sources` and `enrichment` each throw when the `FCT_TRENDS` row itself is missing. [CODE: `lifecycle-subagent-p_gYC562o/run_subagent/entry.js:491-494`; `lifecycle-attribution-subagent-p_PACe77B/run_subagent/entry.js:325-326`]

### F. A retry that would pick up an unenriched trend

The promotion workflow selects every `FCT_TRENDS` row promoted more than 6 hours ago with no `initial` or `refinement` enrichment row, and re-dispatches the enrichment chain for it, at most once a day per trend. The query does not look at where the trend came from. [CODE: `promotion-p_xMC99jg/workflow.yaml:452-489`; `promotion-p_xMC99jg/fire_enrichment_chain/entry.mjs:10-15`] Not exercised here.

### G. The task that writes `supporting` links is not the one in the repo

`sql/fct_trend_signals.sql:46-94` defines `TASK_PROMOTE_TREND_SIGNALS`. In Snowflake that task is `suspended`, reason `SUSPENDED_DUE_TO_ERRORS`, since 2026-06-10. The task that runs is `MARKETING_TASK_PROMOTE_TREND_SIGNALS` (state `started`, every 5 minutes, owner `MARKETING_ENGINEER`). Its definition drops signal ids longer than 255 characters; the repo version drops ids longer than 2048. [MEASURED: `SHOW TASKS`] Effect on the low groups: none. No trend with 0, 1 or 2 linked signals has a supporting id over 255 characters. One id over 255 exists among trends with 3 or more.

Both versions build links only from `STG_TREND_CANDIDATES.SUPPORTING_SIGNAL_IDS` of promoted and merged candidates. An empty array yields no rows. [CODE + MEASURED]

### H. These 20 trends against ADR-0004

`docs/adr/0004-exploding-topics-corroboration-oracle-at-promotion.md:46-47` states that distillation "already enforces ≥2 supporting signals (schema `minItems: 2` + a hard code guard)". The 20 trends above came from candidates with zero supporting signals and an empty `SOURCE_BREAKDOWN`. Their `EVIDENCE_ADDED` values include `["ext_corroboration_01"]`, `["external_knowledge:home_design_trends"]` and `[]`. [MEASURED] In total 43 candidates with an empty array were acted on: 20 as `PROMOTE_NEW`, 23 as `MERGE_INTO_EXISTING`. How they passed the guard was not investigated.

## Not verified

- The body the crons send. The lifecycle sweep cap of 25 is confirmed by the measured 25 evaluations per hour. The attribution sweep cap of 30 is the code default only; the trigger configuration is not in the repo and the Pipedream API was not queried.
- What happens inside attribution runs. The subagent writes no run record to Snowflake. It is not known whether the trends at the front of the queue return no candidates or the model rejects them, or whether the 19 zero-signal trends were ever dispatched.
- The live enrichment and attribution prompts were not compared to the repo. Only the two lifecycle prompts were.
- No workflow was fired, so the behaviour of the chain on a trend with no candidate row at all, or with no lifecycle row, is read from code only.
- The one trend of the 20 that later gained `supporting` links was not examined.

## Appendix: SQL

All run with `snow sql -c claude` on 2026-10-06. Read-only.

**Groups by linked-signal count, with heat, status and age (section 5).**

```sql
WITH ln AS (SELECT TREND_ID, COUNT(DISTINCT SIGNAL_ID) AS N
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS GROUP BY 1),
base AS (
  SELECT d.TREND_ID, d.TREND_NAME, d.HEAT_INDEX, d.LIFECYCLE_STATUS,
         d.DISTINCT_PUBLISHER_COUNT, d.TOTAL_CLUSTER_SIZE, COALESCE(ln.N,0) AS LINKED,
         DATEDIFF('hour', t.PROMOTED_AT, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)/24.0 AS AGE_DAYS,
         d.PREDICTION_SCORE, d.PREDICTION_ELIGIBLE
  FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD d
  JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = d.TREND_ID
  LEFT JOIN ln ON ln.TREND_ID = d.TREND_ID
  WHERE d.LIFECYCLE_STATUS <> 'RETIRED')
SELECT CASE WHEN LINKED >= 3 THEN '3+' ELSE TO_VARCHAR(LINKED) END AS BUCKET, COUNT(*),
       MIN(HEAT_INDEX), PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY HEAT_INDEX),
       MEDIAN(HEAT_INDEX), PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY HEAT_INDEX),
       PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY HEAT_INDEX), MAX(HEAT_INDEX),
       COUNT_IF(HEAT_INDEX <= 10), MIN(AGE_DAYS), MEDIAN(AGE_DAYS), MAX(AGE_DAYS),
       COUNT_IF(LIFECYCLE_STATUS='STABLE'), COUNT_IF(LIFECYCLE_STATUS='DORMANT'),
       COUNT_IF(LIFECYCLE_STATUS='DECLINING'), COUNT_IF(LIFECYCLE_STATUS='NEW'),
       COUNT_IF(PREDICTION_SCORE IS NULL), MAX(PREDICTION_SCORE), COUNT_IF(PREDICTION_ELIGIBLE)
FROM base GROUP BY 1 ORDER BY 1;
```

**The zero-signal trends, with candidate and ledger detail (sections 1 and 2).**

```sql
WITH ln AS (SELECT TREND_ID, COUNT(DISTINCT SIGNAL_ID) AS N
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS GROUP BY 1),
lc AS (SELECT TREND_ID, COUNT(*) AS EVALS, MAX(EVALUATED_AT) AS LAST_EVAL,
              MAX_BY(NEXT_EVAL_AT, EVALUATED_AT) AS NEXT_EVAL_AT,
              MAX_BY(HEAT_BASE, EVALUATED_AT) AS HEAT_BASE,
              MIN_BY(HEAT_BASE, EVALUATED_AT) AS SEED_HEAT_BASE,
              LISTAGG(DISTINCT NEW_STATUS, '|') AS STATUSES_SEEN
       FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER GROUP BY 1)
SELECT d.TREND_ID, d.TREND_NAME, d.HEAT_INDEX, d.LIFECYCLE_STATUS, t.PROMOTED_AT,
       ARRAY_SIZE(c.SUPPORTING_SIGNAL_IDS), ARRAY_SIZE(OBJECT_KEYS(c.SOURCE_BREAKDOWN)),
       c.CONFIDENCE, c.ET_WAS_SECOND_SOURCE, lc.EVALS, lc.SEED_HEAT_BASE, lc.HEAT_BASE,
       lc.STATUSES_SEEN, lc.LAST_EVAL, lc.NEXT_EVAL_AT
FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD d
JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = d.TREND_ID
LEFT JOIN ln ON ln.TREND_ID = d.TREND_ID
LEFT JOIN lc ON lc.TREND_ID = d.TREND_ID
LEFT JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c ON c.CANDIDATE_ID = t.CANDIDATE_ID
WHERE COALESCE(ln.N,0) = 0 ORDER BY t.PROMOTED_AT;
```

**Lifecycle history of one trend (sections 1 and 2).**

```sql
SELECT EVALUATED_AT, PRIOR_STATUS, NEW_STATUS, HEAT_BASE, NEW_HEAT, NEW_HEAT_SMOOTHED,
       NEXT_EVAL_AT, DECISION_PAYLOAD:next_eval_in_hours::FLOAT, REASONING
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE TREND_ID = '2264167e-680d-4a47-8449-a4f230713354' ORDER BY EVALUATED_AT;
```

**Live prompt versions and hashes (section 2).**

```sql
SELECT PROMPT_KEY, VERSION, IS_ACTIVE, LENGTH(TEMPLATE), CONTENT_HASH
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY IN ('lifecycle.subagent.system','lifecycle.subagent.decision_rubric')
ORDER BY PROMPT_KEY, VERSION;
```

**Status moves since the current rules, and time to `DORMANT` / `RETIRED` (section 2).**

```sql
SELECT PRIOR_STATUS, NEW_STATUS, COUNT(*), COUNT(DISTINCT TREND_ID)
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE EVALUATED_AT >= '2026-07-11' AND COALESCE(PRIOR_STATUS,'') <> NEW_STATUS
GROUP BY 1,2 ORDER BY 1,2;
-- Times: MIN(EVALUATED_AT) per trend for NEW_STATUS = 'DORMANT' and 'RETIRED',
-- differenced against FCT_TRENDS.PROMOTED_AT, first event on or after 2026-07-11.
```

**Lifecycle sweep volume and coverage (Other findings, A).**

```sql
SELECT DATE_TRUNC('hour', EVALUATED_AT), COUNT(*), COUNT(DISTINCT CHAIN_ID)
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
WHERE EVALUATED_AT > DATEADD(hour, -30, (SELECT MAX(EVALUATED_AT)
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER))
  AND AGENT_SESSION_ID <> 'promotion'
GROUP BY 1 ORDER BY 1;

WITH lc AS (SELECT TREND_ID, NEW_STATUS, NEW_HEAT_SMOOTHED, EVALUATED_AT, NEXT_EVAL_AT
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
            QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) = 1)
SELECT COUNT(*), COUNT_IF(NEXT_EVAL_AT <= CURRENT_TIMESTAMP()::TIMESTAMP_NTZ),
       COUNT_IF(DATEDIFF('hour', EVALUATED_AT, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) <= 24),
       COUNT_IF(DATEDIFF('hour', EVALUATED_AT, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) > 168),
       MAX(IFF(DATEDIFF('hour', EVALUATED_AT, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) > 168,
               NEW_HEAT_SMOOTHED, NULL))
FROM lc WHERE NEW_STATUS <> 'RETIRED';
```

**Enrichment rows for the zero-signal trends (section 3).**

```sql
WITH ln AS (SELECT TREND_ID, COUNT(DISTINCT SIGNAL_ID) AS N
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS GROUP BY 1),
zero AS (SELECT t.TREND_ID, t.PROMOTED_AT FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
         LEFT JOIN ln ON ln.TREND_ID = t.TREND_ID WHERE COALESCE(ln.N,0) = 0)
SELECT e.ENRICHMENT_KIND, COUNT(*), COUNT(DISTINCT e.TREND_ID),
       COUNT_IF(e.TREND_VECTOR IS NOT NULL),
       MIN(DATEDIFF('second', z.PROMOTED_AT, e.WRITTEN_AT))/60.0,
       MEDIAN(DATEDIFF('second', z.PROMOTED_AT, e.WRITTEN_AT))/60.0,
       MAX(DATEDIFF('second', z.PROMOTED_AT, e.WRITTEN_AT))/60.0,
       MIN(ARRAY_SIZE(e.PAYLOAD:evidence)), MEDIAN(ARRAY_SIZE(e.PAYLOAD:evidence)),
       MAX(ARRAY_SIZE(e.PAYLOAD:evidence)), MEDIAN(e.LLM_COST_ESTIMATE)
FROM zero z JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER e
  ON e.TREND_ID = z.TREND_ID
GROUP BY 1;
```

**Attribution reach by promotion month (section 4).**

```sql
WITH ln AS (SELECT TREND_ID,
       COUNT(DISTINCT IFF(LINK_KIND='supporting', SIGNAL_ID, NULL)) AS N_SUP,
       COUNT(DISTINCT IFF(LINK_KIND='attributed', SIGNAL_ID, NULL)) AS N_ATT
     FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS GROUP BY 1)
SELECT TO_CHAR(DATE_TRUNC('month', t.PROMOTED_AT), 'YYYY-MM'), COUNT(*),
       COUNT_IF(COALESCE(ln.N_ATT,0) > 0)
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t LEFT JOIN ln ON ln.TREND_ID = t.TREND_ID
GROUP BY 1 ORDER BY 1;
```

**Replay of the attribution sweeper's order (section 4).** The `q` CTE is the query at `lifecycle-attribution-agent-p_KwCoaap/workflow.yaml:23-53` without the `LIMIT`, plus `ROW_NUMBER() OVER (ORDER BY COALESCE(la.LAST_ATTR_AT, t.PROMOTED_AT) ASC) AS QUEUE_POS` and the linked-signal count. Read from it: `COUNT(*)`, `COUNT_IF(LAST_ATTR_AT IS NULL)`, `MIN`/`MAX` of the sort value where `QUEUE_POS <= 30`, and `MIN`/`MAX(QUEUE_POS)` where the linked count is 0.

**Queue value of trends that received an attributed link in the last 14 days (section 4).**

```sql
WITH a AS (SELECT TREND_ID, DATE_TRUNC('hour', LINKED_AT) AS HR, COUNT(*) AS LINKS
           FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS
           WHERE LINK_KIND='attributed'
             AND LINKED_AT >= DATEADD(day, -14, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
           GROUP BY 1,2),
p AS (SELECT a.TREND_ID, a.HR, a.LINKS, t.PROMOTED_AT,
        (SELECT MAX(x.LINKED_AT) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS x
          WHERE x.TREND_ID = a.TREND_ID AND x.LINK_KIND='attributed'
            AND x.LINKED_AT < a.HR) AS PRIOR_ATTR
      FROM a JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = a.TREND_ID)
SELECT TO_DATE(HR), COUNT(*), SUM(LINKS),
       MIN(COALESCE(PRIOR_ATTR, PROMOTED_AT)), MAX(COALESCE(PRIOR_ATTR, PROMOTED_AT)),
       MIN(DATEDIFF('day', COALESCE(PRIOR_ATTR, PROMOTED_AT), HR))
FROM p GROUP BY 1 ORDER BY 1;
```

**Candidate signals available to each zero-signal trend (section 4).** For each trend's latest non-null `TREND_VECTOR`, `VECTOR_COSINE_SIMILARITY` against every `FCT_SIGNALS` row with `EMBEDDED_AT` in the last 7 days and a non-null `SIGNAL_VECTOR`; counted at 0.35 over 24 hours and 7 days, and at 0.45 over 7 days.

**Enrichment-search signals tagged to the zero-signal trends (section 3).**

```sql
-- zero = the 19 trend ids, as above
SELECT COUNT(DISTINCT x.METADATA:linked_trend_id::STRING), COUNT(*),
       COUNT_IF(f.SIGNAL_ID IS NOT NULL), COUNT_IF(f.SIGNAL_VECTOR IS NOT NULL)
FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS x
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f ON f.SIGNAL_ID = x.SIGNAL_ID
WHERE x.METADATA:signal_kind::STRING = 'enrichment_citation'
  AND x.METADATA:linked_trend_id::STRING IN (SELECT TREND_ID FROM zero);
```

**Live objects compared to the repo.** `GET_DDL('PROCEDURE', 'MCC_RAW.MARKETING_DEV.PROC_PROMOTION_APPLY(VARIANT, VARCHAR, NUMBER)')`, `GET_DDL('PROCEDURE', 'MCC_RAW.MARKETING_DEV.PROC_LIFECYCLE_APPLY(VARIANT, VARCHAR, BOOLEAN)')`, `GET_DDL('DYNAMIC_TABLE', 'MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD')`, and `SHOW TASKS LIKE '%PROMOTE_TREND_SIGNALS%' IN ACCOUNT`.
