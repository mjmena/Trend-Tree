-- Dimension: Multi-LLM enriched trend analysis
-- Database: MCC_PRESENTATION.TREND_AGENT
--
-- Populated by the LLM enrichment workflow (Trend-Tree/write-p_o7CWa2K).
-- Carries only fields the Trend Agent is responsible for: naming (B2B + B2C),
-- summaries (short + long), categorization (CATEGORY + SUBCATEGORY), and
-- cultural context (Grok). Validity/lifecycle are NOT tracked here — once a
-- trend arrives in FCT_TREND_METRICS the clustering has already validated it.
-- Audience/commercialization/content-strategy fields belong to downstream
-- Insights/Ecomm/Content agents.

CREATE OR REPLACE TABLE MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT (
    TREND_ID VARCHAR NOT NULL,

    -- Naming: split into B2B (direct/professional) and B2C (quirky/engaging)
    TREND_NAME_B2B VARCHAR,                  -- 2-5 words, professional register
    TREND_NAME_B2C VARCHAR,                  -- 2-5 words, consumer-facing / quirky

    -- Summaries: two tiers (short for card view, long for deep-dive)
    SUMMARY_SHORT VARCHAR,                   -- 1-2 sentences, dashboard card view
    SUMMARY_LONG VARCHAR,                    -- 1 paragraph, deep-dive view

    -- Classification (two-tier; macro-trend tier lives in MAP_TREND_MACROTRENDS)
    CATEGORY VARCHAR,                        -- 13-value canonical enum
    SUBCATEGORY VARCHAR,                     -- lowercase snake_case

    -- Cultural context (Grok — source-grounded via Bluesky)
    VOICE_OF_CUSTOMER VARIANT,               -- [{quote, sentiment, persona_type}]
    VIBE_SHIFT VARCHAR,
    SOCIAL_NARRATIVE VARCHAR,
    CULTURAL_DRIVERS VARIANT,                -- [{driver, explanation}]
    SEASONAL_RELEVANCE VARIANT,              -- {is_seasonal, peak_months: [], notes}
    GEOGRAPHIC_HOTSPOTS VARIANT,             -- [{region, strength, notes}]

    -- Provenance / multi-model
    LLM_RESPONSES VARIANT,                   -- {claude, gemini, grok} — raw outputs
    MODELS_USED VARIANT,                     -- ["claude-sonnet-4-6","gemini-2.5-flash","grok-3-mini-fast"]

    -- Cost / usage
    LLM_TOKEN_USAGE VARIANT,
    LLM_TOTAL_TOKENS NUMBER,
    LLM_COST_ESTIMATE FLOAT,

    -- Metadata
    ENRICHED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ENRICHMENT_VERSION NUMBER DEFAULT 1,

    PRIMARY KEY (TREND_ID)
);
