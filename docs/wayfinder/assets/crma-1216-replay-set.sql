-- READ-ONLY. Builds the CRMA-1216 widened promotion replay set.
-- SELECT only. Deterministic: per-stratum sampling orders by MD5(CANDIDATE_ID),
-- so the same set regenerates from the same ledger state.
--
-- Two row-pickers, because DEFER is never a candidate's terminal state:
--   term  — each candidate's LATEST decision (what the lane replays today)
--   defer — the DEFER rows themselves, which `term` hides behind a later REJECT
WITH term AS (
  SELECT * FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
   WHERE MODEL_USED = 'gemini-3.1-pro-preview'
     AND (COALESCE(INPUT_TOKENS,0) > 0 OR COALESCE(OUTPUT_TOKENS,0) > 0)
   QUALIFY ROW_NUMBER() OVER (PARTITION BY CANDIDATE_ID ORDER BY DECIDED_AT DESC) = 1
),
defer AS (
  SELECT * FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
   WHERE MODEL_USED = 'gemini-3.1-pro-preview'
     AND DECISION = 'DEFER'
),
fam AS (
  SELECT c.CANDIDATE_ID,
         COUNT(DISTINCT CASE
           WHEN LOWER(f.key) LIKE 'amazon%'        THEN 'amazon'
           WHEN LOWER(f.key) LIKE 'google_trends%' THEN 'google_trends'
           ELSE LOWER(f.key) END) AS N_FAMILIES
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
         LATERAL FLATTEN(input => c.SOURCE_BREAKDOWN) f
   GROUP BY 1
),
-- Every replayable row, tagged with the axes the strata cut on.
pool AS (
  SELECT p.AUDIT_ID, p.CANDIDATE_ID, p.CHAIN_ID, p.DECIDED_AT,
         p.DECISION, p.DECISION_CATEGORY, p.TARGET_TREND_ID,
         p.MAX_NEIGHBOR_SIM, p.CONFIDENCE, p.DISTILLATION_VERDICT,
         p.CLUSTER_SIZE, p.SOURCE_COUNT, p.RATIONALE,
         c.TOPIC, c.SPECIFICITY_SCORE, c.CONFIDENCE AS CAND_CONFIDENCE,
         c.ET_WAS_SECOND_SOURCE, c.PROMOTED_TO,
         COALESCE(fm.N_FAMILIES, 0) AS N_FAMILIES,
         (p.RATIONALE = 'agent did not call propose_decision') AS TURN_EXHAUSTED,
         (COALESCE(fm.N_FAMILIES,0) < 2
            AND COALESCE(c.CONFIDENCE,0) >= 0.5
            AND COALESCE(c.SPECIFICITY_SCORE,0) >= 0.5)      AS ET_RESCUE_ROUTED,
         CASE WHEN p.MAX_NEIGHBOR_SIM IS NULL   THEN 'none'
              WHEN p.MAX_NEIGHBOR_SIM  < 0.60   THEN 'lt060'
              WHEN p.MAX_NEIGHBOR_SIM  < 0.70   THEN 'b060_070'
              WHEN p.MAX_NEIGHBOR_SIM  < 0.80   THEN 'contested'
              ELSE 'ge080' END                                AS SIM_BAND
    FROM (SELECT * FROM term UNION ALL SELECT * FROM defer) p
    JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c USING (CANDIDATE_ID)
    LEFT JOIN fam fm USING (CANDIDATE_ID)
),
-- Stratum assignment. First match wins, so the rare/enriched strata claim
-- their rows before the base-rate strata see them.
tagged AS (
  SELECT pool.*,
    CASE
      WHEN TURN_EXHAUSTED                                        THEN 'S01_turn_exhausted'
      WHEN DECISION = 'DEFER'                                    THEN 'S02_defer_needs_signal'
      WHEN DECISION_CATEGORY IN ('CONFIRM_DUPE','CORRECTED_DEDUP_TARGET')
                                                                 THEN 'S03_dedup_branch'
      WHEN DECISION_CATEGORY = 'OVER_REJECT_PROMOTE'             THEN 'S04_over_reject_promote'
      WHEN DECISION_CATEGORY = 'NEEDS_MORE_SIGNAL'               THEN 'S05_reject_needs_signal'
      -- Take-all strata claim before any quota'd stratum can strand them.
      -- The contested non-merges are the only over-dedup probes production has:
      -- high similarity where the incumbent still refused to merge.
      WHEN SIM_BAND = 'ge080'                                    THEN 'S06_ge080_all'
      WHEN SIM_BAND = 'contested' AND DECISION <> 'MERGE_INTO_EXISTING'
                                                                 THEN 'S07_contested_not_merge'
      -- ET corroboration and CONFIRM_REJECT are the two shapes CRMA-1221 must
      -- draw Score levels for; band sampling alone left them too thin to read.
      WHEN ET_WAS_SECOND_SOURCE                                  THEN 'S07a_et_earned_2nd'
      WHEN DECISION_CATEGORY = 'CONFIRM_REJECT'                  THEN 'S07b_confirm_reject'
      WHEN SIM_BAND = 'contested'                                THEN 'S08_contested_merge'
      WHEN SIM_BAND = 'b060_070'                                 THEN 'S09_b060_070_' || DECISION
      WHEN SIM_BAND = 'lt060'                                    THEN 'S10_lt060_' || DECISION
      ELSE 'S11_none_' || DECISION
    END AS STRATUM
  FROM pool
),
-- Per-stratum quota. Enriched strata take everything; base-rate strata sample.
quota AS (
  SELECT 'S01_turn_exhausted' S, 99 N UNION ALL
  SELECT 'S02_defer_needs_signal', 12 UNION ALL
  SELECT 'S03_dedup_branch', 99 UNION ALL
  SELECT 'S04_over_reject_promote', 99 UNION ALL
  SELECT 'S05_reject_needs_signal', 99 UNION ALL
  SELECT 'S07a_et_earned_2nd', 16 UNION ALL
  SELECT 'S07b_confirm_reject', 12 UNION ALL
  SELECT 'S06_ge080_all', 99 UNION ALL
  SELECT 'S07_contested_not_merge', 99 UNION ALL
  SELECT 'S08_contested_merge', 30 UNION ALL
  SELECT 'S09_b060_070_PROMOTE_NEW', 8 UNION ALL
  SELECT 'S09_b060_070_MERGE_INTO_EXISTING', 8 UNION ALL
  SELECT 'S09_b060_070_REJECT', 8 UNION ALL
  SELECT 'S10_lt060_PROMOTE_NEW', 6 UNION ALL
  SELECT 'S10_lt060_MERGE_INTO_EXISTING', 4 UNION ALL
  SELECT 'S10_lt060_REJECT', 6 UNION ALL
  SELECT 'S11_none_PROMOTE_NEW', 6 UNION ALL
  SELECT 'S11_none_REJECT', 6
)
SELECT t.STRATUM, t.AUDIT_ID, t.CANDIDATE_ID, t.CHAIN_ID,
       TO_VARCHAR(t.DECIDED_AT,'YYYY-MM-DD"T"HH24:MI:SS') AS DECIDED_AT,
       t.DECISION, t.DECISION_CATEGORY, t.TARGET_TREND_ID, t.PROMOTED_TO,
       t.SIM_BAND, ROUND(t.MAX_NEIGHBOR_SIM,4) AS MAX_NEIGHBOR_SIM,
       t.TURN_EXHAUSTED, t.ET_RESCUE_ROUTED,
       COALESCE(t.ET_WAS_SECOND_SOURCE, FALSE) AS ET_WAS_SECOND_SOURCE,
       t.N_FAMILIES, t.CLUSTER_SIZE, t.SOURCE_COUNT,
       ROUND(t.CAND_CONFIDENCE,3) AS CAND_CONFIDENCE,
       ROUND(t.SPECIFICITY_SCORE,3) AS SPECIFICITY_SCORE,
       t.DISTILLATION_VERDICT, t.TOPIC
  FROM tagged t
  JOIN quota q ON q.S = t.STRATUM
 QUALIFY ROW_NUMBER() OVER (PARTITION BY t.STRATUM ORDER BY MD5(t.CANDIDATE_ID)) <= q.N
 ORDER BY t.STRATUM, MD5(t.CANDIDATE_ID);
