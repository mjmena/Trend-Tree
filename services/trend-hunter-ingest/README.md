# Operate the accepted Trend Hunter article feed

The Cloud Run job `trend-tree-trend-hunter-ingest` polls the accepted article list at minute 7 of every UTC hour. The daily job fires at 00:17 UTC and reconciles the preceding seven UTC days of provider pickup, clipped to enablement. Both schedules start the same container in `mcc-crm-automations/us-east4`. The original publisher URL and host are retained even when a native feed supplied the surviving signal.

**Release evidence is pending.** The fixtures exercise the real Snowflake handlers with synthetic records and session-temporary objects. A release owner must supply the article-scoped secret, enable intake, and record a scheduled execution, its Snowflake rows, and its subsequent replay.

## Release order

1. **Before merging to production**, install the warehouse dependencies from the reviewed commit. Pipedream syncs the distillation, native ingestion and promotion workflows as soon as that branch changes. Run the SQL under the owners of the affected objects, with a single installer. Install `sql/stg_article_evidence.sql` first for the identity function, mutex, first-observation, native and versioned receipts, aliases, and evidence view. Install `sql/trend_hunter_intake.sql` followed by `sql/trend_hunter_comparison.sql`. Check that each mutex/control table has exactly one row with `LOCK_ID=1`. The new control row has null enablement and progress until cutover.
2. Grant the actual runtime and workflow roles access **before** activating their consumers. `MARKETING_ENGINEER` needs database/schema and warehouse usage, usage on the identity UDF and caller-rights procedures, select on staging, embedded signals, candidates, aliases and evidence, and the DML those procedures perform. The resolver updates the mutex and evidence-key tables, inserts native/accepted sightings and alias history, and merges the first-observation table and presentation alias table. The intake job updates control, inserts/updates runs, pages and executions, and records per-page detail proofs. Distillation reads the evidence keys and writes and reads the opportunity and pool tables. Promotion and intake write candidate versions. Preserve other existing merge callers' rights and grant the presentation readers, task and dynamic-table owners access to `FCT_ARTICLE_SIGNAL_ALIASES` and `V_TREND_SIGNAL_EVIDENCE`. Verify with each effective role and `SHOW GRANTS ON` the affected objects. Then install `sql/proc_merge_external_signals.sql` and `sql/proc_promotion_apply.sql`. Existing native ingestion immediately starts calling the new resolver through the replaced merge procedure. Refresh the supporting-link task and the daily/dashboard dynamic-table definitions from the same reviewed release in their existing deployment order.
3. Provision an article-scoped credential in Secret Manager as `trend-hunter-articles-api-key`. Grant the runtime account `crm-runtime@mcc-crm-automations.iam.gserviceaccount.com` Secret Accessor on it. The checked-in bindings are `TREND_HUNTER_ARTICLES_API_KEY=trend-hunter-articles-api-key:latest` and `SNOWFLAKE_PRIVATE_KEY=snowflake-private-key:latest`. Install credentials through the secret owner's usual channel. The service sends its provider credential only in the Bearer header. Scheduler's OAuth account needs `run.jobs.run` on this job and `run.jobs.runWithOverrides` for the daily environment override. The job-scoped `roles/run.jobsExecutorWithOverrides` includes both. [Cloud Run jobs.run permissions](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.jobs/run)
4. Once the dependencies and grants are available, a human merges the reviewed production PR. Wait until the new Pipedream components are serving. Rerun `sql/stg_article_evidence.sql` to index surviving native first writers from the cutover, including the legacy Gemini writer. Verify the effective grants again. Deploy all three Cloud Run jobs from that same commit with `services/deploy.sh lifecycle --no-execute`, `services/deploy.sh attribution --no-execute` and `services/deploy.sh trend-hunter-ingest --no-execute`. The lifecycle and attribution images bundle the shared evidence queries. Before enabling intake, use `gcloud run jobs describe` for each job in `mcc-crm-automations/us-east4` and verify its configured image against the corresponding reviewed SHA tag or image digest, its service account and its secret binding names. The existing schedulers run lifecycle and attribution at their usual times. The intake scheduler owns the first article window.
5. Immediately before enabling the schedules, set the durable launch instant in a Snowflake session using the SQL below. The predicate makes a repeated release command preserve the original enablement. Then run `services/trend-hunter-ingest/schedule.sh`. Use `--dry-run` to print both definitions offline. The first forward firing whose UTC hour is after enablement reads from precisely that instant.

```sql
UPDATE MCC_RAW.MARKETING_DEV.STG_TREND_HUNTER_CONTROL
SET ENABLED_AT_UTC=CONVERT_TIMEZONE('UTC',CURRENT_TIMESTAMP())::TIMESTAMP_NTZ,
    FORWARD_THROUGH_UTC=CONVERT_TIMEZONE('UTC',CURRENT_TIMESTAMP())::TIMESTAMP_NTZ
WHERE LOCK_ID=1 AND ENABLED_AT_UTC IS NULL;
```

## Check an execution and its replay

Capture the Scheduler dispatch time and status, the corresponding Cloud Run execution name, image SHA, task attempt and terminal condition. A successful Scheduler HTTP request records acceptance of the job invocation. The Cloud Run outcome and Snowflake receipts establish completion. When two executions overlap, their `WINDOW_ID` connects them to the same work.

```sh
gcloud scheduler jobs describe trend-tree-trend-hunter-ingest-hourly --location us-east4 --project mcc-crm-automations
gcloud run jobs executions list --job trend-tree-trend-hunter-ingest --region us-east4 --project mcc-crm-automations --limit 5
gcloud run jobs executions describe "$execution" --region us-east4 --project mcc-crm-automations
```

Set `$execution` in the Snowflake worksheet to the execution name. Run the following in one session. The high-water mark and page counts expose freshness and progress even after an interrupted pull. An empty completed window is valid. Use a completed scheduled window with an eligible article for publisher and embedding evidence.

```sql
USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;
SET execution = '<Cloud Run execution name>';
SELECT e.EXECUTION_ID,e.TASK_ATTEMPT,e.OUTCOME,e.STARTED_AT_UTC,e.FINISHED_AT_UTC,r.*
FROM STG_TREND_HUNTER_EXECUTIONS e LEFT JOIN STG_TREND_HUNTER_RUNS r USING(WINDOW_ID)
WHERE e.EXECUTION_ID=$execution ORDER BY e.STARTED_AT_UTC;
SELECT ENABLED_AT_UTC,FORWARD_THROUGH_UTC,RETRY_AT_UTC,
       DATEDIFF(minute,FORWARD_THROUGH_UTC,CONVERT_TIMEZONE('UTC',CURRENT_TIMESTAMP())::TIMESTAMP_NTZ) AS PICKUP_LAG_MINUTES
FROM STG_TREND_HUNTER_CONTROL WHERE LOCK_ID=1;
SET window_id = (SELECT MAX(WINDOW_ID) FROM STG_TREND_HUNTER_EXECUTIONS WHERE EXECUTION_ID=$execution);
SELECT PAGE_NUMBER,OBSERVED_AT_UTC,COMMITTED_AT_UTC,COUNTS FROM STG_TREND_HUNTER_PAGES
WHERE WINDOW_ID=$window_id ORDER BY PAGE_NUMBER;

CREATE TEMPORARY TABLE TH_VERIFY_BEFORE AS
SELECT DISTINCT a.OBSERVATION_KEY,a.SIGNAL_ID,a.FIRST_OBSERVED_AT_UTC,a.PUBLISHER
FROM STG_TREND_HUNTER_ARTICLES a JOIN STG_TREND_HUNTER_ARTICLE_SIGHTINGS s USING(OBSERVATION_KEY)
WHERE s.WINDOW_ID=$window_id AND a.SIGNAL_ID IS NOT NULL;
SELECT b.OBSERVATION_KEY,a.ORIGINAL_URL,b.PUBLISHER,s.SOURCE_NAME AS FIRST_WRITER,s.SIGNAL_ID,
       s.METADATA:publisher::VARCHAR AS STAGED_ARTICLE_PUBLISHER,f.EMBEDDED_AT
FROM TH_VERIFY_BEFORE b JOIN STG_TREND_HUNTER_ARTICLES a USING(OBSERVATION_KEY)
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES x ON x.SIGNAL_ID=b.SIGNAL_ID
LEFT JOIN STG_EXTERNAL_SIGNALS s ON s.SIGNAL_ID=COALESCE(x.CREDITED_SIGNAL_ID,b.SIGNAL_ID)
LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f ON f.SIGNAL_ID=s.SIGNAL_ID
ORDER BY b.OBSERVATION_KEY;
```

Wait for the five-minute embedding task and verify at least one eligible publisher row through to its surviving embedded ID. Preserve the per-ID counts after embedding and retain the window's `FROM_UTC` and `TO_UTC`.

```sql
CREATE TEMPORARY VIEW TH_VERIFY_FACTS_NOW AS
WITH owners AS (
    SELECT DISTINCT b.SIGNAL_ID,COALESCE(x.CREDITED_SIGNAL_ID,b.SIGNAL_ID) AS CREDITED_ID
    FROM TH_VERIFY_BEFORE b LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_ARTICLE_SIGNAL_ALIASES x ON x.SIGNAL_ID=b.SIGNAL_ID
), staged AS (
    SELECT s.SIGNAL_ID,COUNT(*) AS N FROM STG_EXTERNAL_SIGNALS s
    WHERE s.SIGNAL_ID IN (SELECT CREDITED_ID FROM owners) GROUP BY s.SIGNAL_ID
), embedded AS (
    SELECT f.SIGNAL_ID,COUNT(*) AS N FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f
    WHERE f.SIGNAL_ID IN (SELECT CREDITED_ID FROM owners) GROUP BY f.SIGNAL_ID
)
SELECT o.*,COALESCE(s.N,0) AS STAGE_COUNT,COALESCE(f.N,0) AS EMBEDDED_COUNT
FROM owners o LEFT JOIN staged s ON s.SIGNAL_ID=o.CREDITED_ID LEFT JOIN embedded f ON f.SIGNAL_ID=o.CREDITED_ID;
CREATE TEMPORARY TABLE TH_VERIFY_FACTS_BEFORE AS SELECT * FROM TH_VERIFY_FACTS_NOW;
```

In a second terminal, run the exact half-open interval with both offsets. Each operator replay accepts at most seven days and can recover pickups that precede enablement.

```sh
gcloud run jobs execute trend-tree-trend-hunter-ingest --region us-east4 --project mcc-crm-automations \
  --update-env-vars "TREND_HUNTER_ORIGIN=replay,TREND_HUNTER_FROM=$from_utc,TREND_HUNTER_TO=$to_utc" --wait
```

Check the replay execution and its counts using its name. In the same Snowflake session that holds `TH_VERIFY_BEFORE`, verify zero missing or changed original observations. Compare the stage and embedded count per baseline ID with the preceding result. With identical provider records the replay has zero new signals. If acceptance or release proof changed in the interim, list those observations and their dispositions separately.

```sql
SELECT COUNT(*) AS ORIGINAL_OBSERVATIONS,
       COALESCE(COUNT_IF(a.OBSERVATION_KEY IS NULL OR a.SIGNAL_ID IS DISTINCT FROM b.SIGNAL_ID
                OR a.FIRST_OBSERVED_AT_UTC IS DISTINCT FROM b.FIRST_OBSERVED_AT_UTC),0) AS MISSING_OR_CHANGED
FROM TH_VERIFY_BEFORE b LEFT JOIN STG_TREND_HUNTER_ARTICLES a USING(OBSERVATION_KEY);
SELECT COUNT(*) AS CHANGED_BASELINE_FACTS
FROM TH_VERIFY_FACTS_BEFORE b FULL JOIN TH_VERIFY_FACTS_NOW n USING(SIGNAL_ID)
WHERE b.CREDITED_ID IS DISTINCT FROM n.CREDITED_ID OR b.STAGE_COUNT IS DISTINCT FROM n.STAGE_COUNT
   OR b.EMBEDDED_COUNT IS DISTINCT FROM n.EMBEDDED_COUNT;
```

Record the scheduled and replay execution names, Scheduler timestamps, UTC bounds, page/record counts, first-observation checks, publisher, surviving staging/embedded IDs, and any pending embeddings in the release evidence. The report window begins on the first complete UTC day at or after the recorded enablement.

## Pause, resume and recovery

`services/trend-hunter-ingest/schedule.sh --pause` pauses both schedulers. Already started Cloud Run executions can finish their current window. Use `--resume` to re-enable both schedules. Leave the enablement, forward checkpoint and page receipts intact. A forward retry finishes the saved window, then a later tick covers the gap to its current UTC hour. Daily reconciliation revisits the current verdict on pickups within seven days, starting at enablement. Use explicit bounded replay for earlier verdict changes and split longer recovery intervals into seven-day segments.

Each list request first claims its window and cursor in Snowflake. An overlapping execution records `in_progress` while another worker owns the fetch. A three-minute lease covers the one-minute HTTP timeout. A higher task attempt of the same Cloud Run execution can immediately take over its interrupted fetch. Other executions can claim the page when the lease expires. The new token fences out a delayed response from the original worker. A page receipt fixes the accepted list metadata and UTC observation clock before any optional detail request. All job executions share the provider cooldown. A long `Retry-After` produces a `rate_limited` execution outcome and a durable `RETRY_AT_UTC`. Rerun a manual replay with the same bounds after that UTC time. A short cooldown can be retried during the same execution. Verified and unavailable detail results are saved per article and page. Signal merge, eligible/unusable receipts, metrics, final cursor and forward progress commit together. A missing or cycling provider cursor fails the execution and retains its last valid progress for repair.

## Evidence available for comparison

All tables below are in `MCC_RAW.MARKETING_DEV`. The new `*_UTC` clocks are UTC `TIMESTAMP_NTZ`. Native staging and embedded NTZ clocks use the existing New York writer convention. A historical wall clock during the repeated fall-back hour may be ambiguous. The explicit UTC receipt clock avoids that ambiguity for new native sightings.

| Evidence | Recorded scope |
|---|---|
| `STG_TREND_HUNTER_ARTICLES` and `STG_TREND_HUNTER_ARTICLE_SIGHTINGS` | First accepted observation per provider item and every handled version per window/page. An eligible version has a surviving signal and a disposition other than `unusable`. Use the eligible receipt and the embedding clock for availability. `HANDLED_AT_UTC` bounds when its proof and credited identity were recorded. |
| `STG_NATIVE_ARTICLE_SIGHTINGS` | All URL-bearing native inputs entering the resolver, including same-batch and previously merged IDs, with original title/text/metadata, source clock, native and surviving IDs, warehouse UTC receipt, optional merge session, batch ID and input index. Sources are the three discovery agents, Google Trends RSS, on-demand GDELT and legacy Gemini. Pre-install native owners have keys, and discarded pre-install native representations are unavailable. |
| `STG_ARTICLE_ALIAS_HISTORY` | Each verified alias version, including changes to earlier aliases when a later proof joins identities. Select the latest verification at or before the comparison cutoff. |
| `STG_TREND_HUNTER_OPPORTUNITIES` and `STG_TREND_HUNTER_POOL_SIGNALS` | Every main/revisit poll, UTC time, chain/session, lookback, caps, floor and selected count. The pool snapshot retains the in-window staging representations, claims, verified owner, prior promotion, first available vector embedding, and actual rank for selected rows. `INPUT_ORDINAL` distinguishes staging duplicates. Floor misses and empty pools remain observable. |
| `STG_TREND_HUNTER_CANDIDATE_VERSIONS` | Immutable candidate emission fields and original creation clock are archived at forward job starts for candidates created from seven days before enablement onward, including pending candidates. Each successful promotion decision records its actual before/after row and decision inputs in the same transaction. Rejected, deferred and merged candidates remain available. Later mutable disposition and dedup targets are excluded from the creation projection. |

The native receipt boundary begins at submission to the shared merge. Discovery's lower-scoring within-run duplicates, RSS articles outside its two-per-query cap, GDELT's in-call repeats and sources outside the instrumented URL lanes have no receipt here. A native repeat after a feed-first signal may have a recoverable representation without its own embedding. Sampled native-only comparisons must label the availability estimate and missing native coverage.

After seven complete UTC days, the source owner can freeze a warehouse evidence packet, compare sampled movement opportunities and publish the reviewed outcomes. [First-week contribution report](contribution-report.md)
