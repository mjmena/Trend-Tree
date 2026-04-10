-- One-time backfill: normalize CATEGORY and SUBCATEGORY in DIM_TREND_ENRICHMENT
-- to the canonical 14-value enum and lowercase snake_case subcategories.
-- Run once after deploying the updated enrichment pipeline.

UPDATE MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
SET CATEGORY = CASE LOWER(TRIM(CATEGORY))
  -- Old enum → new enum
  WHEN 'food_diet'            THEN 'food_beverage'
  WHEN 'home'                 THEN 'home_living'
  WHEN 'tech'                 THEN 'consumer_tech'
  WHEN 'cultural_shift'       THEN 'social_lifestyle'
  -- LLM drift variants
  WHEN 'health & wellness'    THEN 'wellness'
  WHEN 'health and wellness'  THEN 'wellness'
  WHEN 'health_wellness'      THEN 'wellness'
  WHEN 'health'               THEN 'wellness'
  WHEN 'food & diet'          THEN 'food_beverage'
  WHEN 'food and diet'        THEN 'food_beverage'
  WHEN 'nutrition'            THEN 'food_beverage'
  WHEN 'diet'                 THEN 'food_beverage'
  WHEN 'food & beverage'      THEN 'food_beverage'
  WHEN 'beverages'            THEN 'food_beverage'
  WHEN 'skincare'             THEN 'beauty'
  WHEN 'grooming'             THEN 'personal_care'
  WHEN 'personal care'        THEN 'personal_care'
  WHEN 'technology'           THEN 'consumer_tech'
  WHEN 'consumer technology'  THEN 'consumer_tech'
  WHEN 'culture'              THEN 'social_lifestyle'
  WHEN 'cultural shift'       THEN 'social_lifestyle'
  WHEN 'lifestyle'            THEN 'social_lifestyle'
  WHEN 'social'               THEN 'social_lifestyle'
  WHEN 'home decor'           THEN 'home_living'
  WHEN 'home & living'        THEN 'home_living'
  WHEN 'unknown'              THEN 'other'
  WHEN 'none'                 THEN 'other'
  -- Already-canonical values pass through
  ELSE LOWER(TRIM(CATEGORY))
END,
SUBCATEGORY = LOWER(TRIM(REGEXP_REPLACE(SUBCATEGORY, '\\s+', '_')));

-- Verify: should show only canonical values
SELECT CATEGORY, COUNT(*) AS CNT
FROM MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
GROUP BY CATEGORY
ORDER BY CNT DESC;
