-- Daily health view for the promotion agent.
-- One row per day for the last 30 days. Surfaces decision distribution,
-- cost, override rate, and avg neighbor similarity for at-a-glance drift
-- monitoring.
--
-- Drift alerts (manual review weekly to start):
--   verdict_overrides / decisions_total > 0.30  → distillation and promotion
--                                                 are fighting; one needs reconfig
--   defer_count / decisions_total > 0.20         → too many ambiguous calls;
--                                                 tighten the rubric
--   reject_count / decisions_total > 0.40        → agent over-eager on REJECT;
--                                                 check distillation quality
--   daily_cost_usd > $1.50                       → budget alarm

CREATE OR REPLACE VIEW MCC_PRESENTATION.TREND_AGENT.V_PROMOTION_HEALTH AS
SELECT
  DATE_TRUNC('day', DECIDED_AT)                  AS day,
  COUNT(*)                                       AS decisions_total,
  COUNT_IF(DECISION = 'PROMOTE_NEW')             AS promote_count,
  COUNT_IF(DECISION = 'MERGE_INTO_EXISTING')     AS merge_count,
  COUNT_IF(DECISION = 'REJECT')                  AS reject_count,
  COUNT_IF(DECISION = 'DEFER')                   AS defer_count,
  COUNT_IF(OVERRODE_VERDICT = TRUE)              AS verdict_overrides,
  ROUND(AVG(MAX_NEIGHBOR_SIM), 3)                AS avg_max_neighbor_sim,
  ROUND(AVG(CLUSTER_SIZE), 1)                    AS avg_cluster_size,
  ROUND(SUM(COST_ESTIMATE), 4)                   AS daily_cost_usd
FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
WHERE DECIDED_AT >= DATEADD(day, -30, CURRENT_TIMESTAMP())
GROUP BY day
ORDER BY day DESC;
