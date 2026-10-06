-- CRMA-1344: oracle-route volume under the typed rubric.
-- Population = CRMA-1222 (i): subagent-decided PROMOTE_NEW/MERGE_INTO_EXISTING
-- rows in FCT_PROMOTION_LEDGER (INPUT_TOKENS > 0), joined to
-- STG_TREND_CANDIDATES.SOURCE_BREAKDOWN, vendor-aware family
-- (crma-1222-family.mjs sourceFamilyOfVendorAware).
WITH pop AS (
  SELECT l.AUDIT_ID, l.CANDIDATE_ID, l.DECISION, l.DECIDED_AT, c.SOURCE_BREAKDOWN
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER l
  LEFT JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
    ON c.CANDIDATE_ID = l.CANDIDATE_ID
  WHERE l.DECISION IN ('PROMOTE_NEW','MERGE_INTO_EXISTING')
    AND l.INPUT_TOKENS > 0
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
         COUNT(DISTINCT kf.fam)                                                   AS n_fam,
         COUNT(DISTINCT IFF(kf.fam IN ('chatgpt','gemini','grok'), kf.fam, NULL)) AS n_ai,
         COUNT(DISTINCT IFF(kf.fam NOT IN ('chatgpt','gemini','grok'), kf.fam, NULL)) AS n_direct
  FROM pop p LEFT JOIN keys kf ON kf.AUDIT_ID = p.AUDIT_ID
  GROUP BY 1,2,3,4
),
classed AS (
  SELECT *,
    CASE
      WHEN n_fam = 0                     THEN 'E  empty SOURCE_BREAKDOWN'
      WHEN n_direct = 0 AND n_ai >= 2    THEN 'A3 AI-only, 2+ families'
      WHEN n_direct = 0 AND n_ai = 1     THEN 'S1 AI-only, 1 family'
      WHEN n_fam = 1 AND n_direct = 1    THEN 'S2 direct-only, 1 family'
      ELSE                                    'M  2+ families incl. a direct one'
    END AS grp
  FROM per_row
)
SELECT grp,
       COUNT(*)                                          AS n,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct,
       COUNT_IF(DECISION = 'PROMOTE_NEW')                AS n_promote_new,
       COUNT_IF(DECISION = 'MERGE_INTO_EXISTING')        AS n_merge,
       COUNT(DISTINCT CANDIDATE_ID) AS n_cand,
       COUNT(DISTINCT IFF(DECIDED_AT < '2026-09-22 00:00'::TIMESTAMP_NTZ, CANDIDATE_ID, NULL)) AS n_cand_lt_0922,
       COUNT(DISTINCT IFF(DECIDED_AT < '2026-09-22 05:00'::TIMESTAMP_NTZ, CANDIDATE_ID, NULL)) AS n_cand_lt_0922_05,
       COUNT_IF(DECIDED_AT < '2026-09-21 00:00'::TIMESTAMP_NTZ) AS n_lt_0921,
       COUNT_IF(DECIDED_AT < '2026-09-22 00:00'::TIMESTAMP_NTZ) AS n_lt_0922,
       COUNT_IF(DECIDED_AT < '2026-09-22 05:00'::TIMESTAMP_NTZ) AS n_lt_0922_05,
       MIN(DECIDED_AT) AS first_at, MAX(DECIDED_AT) AS last_at
FROM classed
GROUP BY grp
ORDER BY grp;
