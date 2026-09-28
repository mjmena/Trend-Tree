# CRMA-1344: oracle-route volume and throughput cost of the typed path

Measured live 2026-09-28. Read-only: SELECTs against Snowflake, and the committed CRMA-1222/1332 replay files read locally.

## How CRMA-1222's 41.8% was computed (reconstructed)

Commit 0969d97 committed the numbers but not the SQL. The prose describes the method: subagent-decided `PROMOTE_NEW`/`MERGE_INTO_EXISTING` rows in `FCT_PROMOTION_LEDGER` (`INPUT_TOKENS > 0`), joined to `STG_TREND_CANDIDATES.SOURCE_BREAKDOWN`, grouped with `sourceFamilyOfVendorAware`. The SQL below implements that method.

The unit is **distinct candidates**, not ledger rows: some candidates have two rows (ITERATION 1 and 2). With the cutoff `DECIDED_AT < 2026-09-22` the SQL reproduces 1222's table:

| Group | 1222 (2026-09-22) | This SQL, same cutoff |
| --- | ---: | ---: |
| (a3) AI-only, 2+ families | 319 | 319 |
| AI-only, 1 family | 286 | 286 |
| Has a directly-observed source | 116 | 116 (76 mixed + 40 direct-only single family) |
| Empty SOURCE_BREAKDOWN | 42 | 43 |
| Total | 763 | 764 |

The difference is one candidate with an empty `SOURCE_BREAKDOWN`, probably a `DECIDED_AT` timezone edge at the cutoff. The definition is otherwise the same.

## Current population (through 2026-09-27 22:15, 22.0 weeks from 2026-04-26)

796 distinct candidates, of which 538 are PROMOTE_NEW (latest subagent row per candidate).

| Group | n | % of 796 | PROMOTE_NEW | MERGE | Last 8 weeks (all / PN) |
| --- | ---: | ---: | ---: | ---: | ---: |
| (a3) AI-only, 2+ families | 325 | 40.8% | 262 | 63 | 66 / 39 |
| **AI-only, 1 family (S1)** | **305** | **38.3%** | 147 | 158 | 180 / 71 |
| **Direct-only, 1 family (S2)** | **42** | **5.3%** | 38 | 4 | 5 / 4 |
| 2+ families including a direct one | 78 | 9.8% | 70 | 8 | 14 / 10 |
| Empty SOURCE_BREAKDOWN | 46 | 5.8% | 21 | 25 | 44 / 20 |

### Q1: one-family rows

- 347 rows (43.6%) rest on exactly one family: 305 AI-only (38.3%) and 42 directly observed (5.3%).
- On the 2026-09-22 snapshot this is 326 of 764 (42.7%): 286 AI-only and 40 directly observed.

### Q2: rows on the oracle route (a3 + one-family)

- **672 of 796 (84.4%).** On the 09-22 snapshot it is 645 of 764, also 84.4%.
- Only 78 rows (9.8%) have independent evidence, meaning at least one directly-observed family plus a second family.
- Another 46 (5.8%) have no source data at all. The mechanical estimates below leave these out; they are added as a separate line.

### Q3: share of historical throughput the typed path would reject

Two estimates. Rates come from the signal_frequency arm, the keyword rule CRMA-1332 adopted.

**(A) Mechanical, as the ticket frames it.** Every (a3) and one-family row goes to the oracle.
- The oracle success rate for (a3) is 0/19 (CRMA-1332).
- For one family it is **8/45 = 17.8%**, the ledger-promoted/merged S1 cases in the signal_frequency arm. The 11/77 in the scorecard also includes ledger-REJECT cases. S2 has n=1 (0/1), so it borrows the S1 rate.
- Result: **610 of 796 rejected (76.7%), about 27.7/week** out of 36.2/week. New trends lost: 414 of 538 PROMOTE_NEW (77.0%), **18.8/week**.
- Last-8-weeks mix: 27.3/week of 38.6 (70.6%). PROMOTE_NEW: 12.6/week of 18.0.
- If the empty-SOURCE_BREAKDOWN rows also reject: 82.5%, 29.8/week.

**(B) Replay end-to-end.** This uses the actual composed outcome from CRMA-1222 Request A plus the 1332 signal_frequency oracle, for the ledger promote/merge replay cases in each group × decision. Two effects make it lower than (A):
- **Merge comes before the evidence route.** Most historical merges still merge: S1 26/53, (a3) 5/11.
- **Jev does not apply (a3) uniformly.** 12 of 36 historical (a3) promotions scored `stands_alone` and promote with no oracle. So "0/19" covers only the (a3) cases Jev sent to the oracle.

Replay reject rates used:

| Group | PROMOTE_NEW reject rate | MERGE reject rate |
| --- | ---: | ---: |
| (a3) | 17/25 = 68% | 2/11 = 18% |
| S1 | 16/22 = 73% | 22/53 = 42% |
| S2 | S1 rates (n=1) | S1 rates (n=1) |
| Mixed | assumed 0 (not sampled) | assumed 0 |

Result:
- **391 of 796 rejected (49.2%), about 17.8/week.** New trends lost: 313 of 538 (58.1%), **14.2/week**.
- Last-8-weeks mix: 16.5/week of 38.6 (42.6%). PROMOTE_NEW: 10.1/week of 18.0 (56.3%).
- If the empty rows also reject (7/7 in the replay, mostly `not_a_topic`): 55.0% and 19.9/week.

## Assumptions and caveats

- Family definition: vendor-aware (CRMA-1231 rule 4). "AI-discovery" means the chatgpt, gemini or grok family. Every other key counts as directly observed, including gdelt, tiktok, wikimedia and the six single-occurrence outlet-shaped names.
- The replay set (187 cases, stratified toward hard cases) is not a random sample. The per-group rates in (B) have small n (22–53), so treat (B) as roughly ±10 points.
- (A) is the upper bound the ticket's framing implies. (B) is closer to what the composed code would actually do.
- Weekly rates come from the 22.0-week ledger span. The mix has shifted: S1 dominates the last 8 weeks (180 of 309), and (a3) has fallen (66).
- **Data-quality flag:** 44 of the 46 empty-SOURCE_BREAKDOWN promotions fall in the last 8 weeks (14% of recent throughput). This looks like an upstream regression worth checking separately.

## SQL

File: `crma-1344-volume.sql`. It gives the group breakdown with row and candidate counts at the 09-22 cutoffs, to reproduce 1222.

```sql
WITH pop AS (
  SELECT l.AUDIT_ID, l.CANDIDATE_ID, l.DECISION, l.DECIDED_AT, c.SOURCE_BREAKDOWN
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER l
  LEFT JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c ON c.CANDIDATE_ID = l.CANDIDATE_ID
  WHERE l.DECISION IN ('PROMOTE_NEW','MERGE_INTO_EXISTING') AND l.INPUT_TOKENS > 0
),
keys AS (
  SELECT p.AUDIT_ID,
         CASE
           WHEN k LIKE 'amazon%' THEN 'amazon'
           WHEN k = 'agent_gemini_discovery' OR k LIKE 'gemini\\_%' ESCAPE '\\' THEN 'gemini'
           WHEN k = 'agent_grok_discovery'   OR k LIKE 'grok\\_%'   ESCAPE '\\' THEN 'grok'
           WHEN k = 'agent_chatgpt_discovery' THEN 'chatgpt'
           WHEN k LIKE 'google_trends%' THEN 'google_trends'
           ELSE k
         END AS fam
  FROM pop p,
       LATERAL FLATTEN(input => OBJECT_KEYS(TRY_PARSE_JSON(p.SOURCE_BREAKDOWN::STRING))) f,
       LATERAL (SELECT LOWER(f.value::STRING) AS k) x
),
per_row AS (
  SELECT p.AUDIT_ID, p.CANDIDATE_ID, p.DECISION, p.DECIDED_AT,
         COUNT(DISTINCT kf.fam) AS n_fam,
         COUNT(DISTINCT IFF(kf.fam IN ('chatgpt','gemini','grok'), kf.fam, NULL)) AS n_ai,
         COUNT(DISTINCT IFF(kf.fam NOT IN ('chatgpt','gemini','grok'), kf.fam, NULL)) AS n_direct
  FROM pop p LEFT JOIN keys kf ON kf.AUDIT_ID = p.AUDIT_ID
  GROUP BY 1,2,3,4
),
classed AS (
  SELECT *, CASE
      WHEN n_fam = 0                  THEN 'E  empty SOURCE_BREAKDOWN'
      WHEN n_direct = 0 AND n_ai >= 2 THEN 'A3 AI-only, 2+ families'
      WHEN n_direct = 0 AND n_ai = 1  THEN 'S1 AI-only, 1 family'
      WHEN n_fam = 1 AND n_direct = 1 THEN 'S2 direct-only, 1 family'
      ELSE                                 'M  2+ families incl. a direct one' END AS grp
  FROM per_row
)
-- reproduction (09-22 cutoff):
SELECT grp, COUNT(DISTINCT IFF(DECIDED_AT < '2026-09-22'::TIMESTAMP_NTZ, CANDIDATE_ID, NULL)) FROM classed GROUP BY grp;
```

File: `weekly.sql`. It uses the same CTEs, then one row per candidate (its latest row), with span and 8-week counts:

```sql
cand AS (SELECT * FROM classed QUALIFY ROW_NUMBER() OVER (PARTITION BY CANDIDATE_ID ORDER BY DECIDED_AT DESC) = 1),
span AS (SELECT MIN(DECIDED_AT) a, MAX(DECIDED_AT) b, DATEDIFF('second', MIN(DECIDED_AT), MAX(DECIDED_AT))/604800.0 AS weeks FROM cand)
SELECT grp, COUNT(*) n_cand, COUNT_IF(DECISION='PROMOTE_NEW') n_pn, COUNT_IF(DECISION='MERGE_INTO_EXISTING') n_merge,
       COUNT_IF(DECIDED_AT >= DATEADD('day',-56, span.b)) n_last8w,
       COUNT_IF(DECISION='PROMOTE_NEW' AND DECIDED_AT >= DATEADD('day',-56, span.b)) n_pn_last8w, MAX(span.weeks) weeks
FROM cand, span GROUP BY grp;
```

The replay rates come from `rescue.mjs` (in the same directory). It reads the committed `crma-1222-cases.json`, `crma-1222-results.jsonl` and `crma-1332-oracle-*.jsonl`, classifies each case with `familyDelta().fixed_families`, and tabulates the Request A `composed_criteria.decision_rule` plus the signal_frequency oracle decision by group × ledger decision.
