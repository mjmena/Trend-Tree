-- Procedure: Aggregate Amazon Movers & Shakers into category-level trend signals
-- Database: MCC_RAW.MARKETING_DEV
--
-- Individual product signals ("Dove Beauty Bar Soap") embed poorly against LLM
-- trend signals ("gentle skincare routines"). This procedure groups products by
-- Amazon department, uses Cortex LLM to extract 2-3 consumer trend themes per
-- department, and writes aggregated signals back to STG_EXTERNAL_SIGNALS.
--
-- The DT_EXTERNAL_TREND_EMBEDDINGS dynamic table reads these aggregated signals
-- (source_name = 'amazon_trends') instead of individual products.
--
-- Called by TASK_AGGREGATE_AMAZON on a schedule (runs before clustering).

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_AGGREGATE_AMAZON()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
    result VARCHAR;
    dept_count INTEGER DEFAULT 0;
    theme_count INTEGER DEFAULT 0;
BEGIN
    USE DATABASE MCC_RAW;
    USE SCHEMA MARKETING_DEV;

    -- 1. Build temp table of products grouped by department for last 24 hours
    CREATE OR REPLACE TEMPORARY TABLE TEMP_AMAZON_DEPT_PRODUCTS AS
    SELECT
        METADATA:department::STRING AS DEPARTMENT,
        DATE_TRUNC('day', SIGNAL_TIMESTAMP)::DATE AS SIGNAL_DATE,
        LISTAGG(SIGNAL_TITLE, '\n') WITHIN GROUP (ORDER BY SIGNAL_TITLE) AS PRODUCT_LIST,
        COUNT(*) AS PRODUCT_COUNT
    FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
    WHERE SOURCE_NAME = 'amazon_movers'
        AND SIGNAL_TIMESTAMP >= DATEADD('hour', -30, CURRENT_TIMESTAMP())
        AND METADATA:department IS NOT NULL
    GROUP BY 1, 2;

    SELECT COUNT(*) INTO :dept_count FROM TEMP_AMAZON_DEPT_PRODUCTS;

    IF (dept_count = 0) THEN
        RETURN '{"status": "no_data", "message": "No recent Amazon products found"}';
    END IF;

    -- 2. Build LLM prompts — one per department/day, ask for consumer trend themes
    CREATE OR REPLACE TEMPORARY TABLE TEMP_AMAZON_PROMPTS AS
    SELECT
        DEPARTMENT,
        SIGNAL_DATE,
        PRODUCT_COUNT,
        CONCAT(
            'You are a consumer trend analyst. Below is a list of ', PRODUCT_COUNT::VARCHAR,
            ' trending products from Amazon''s "', DEPARTMENT,
            '" Movers & Shakers category today.\n\n',
            'Identify 2-4 distinct consumer lifestyle THEMES (not individual products) that these ',
            'products represent. Focus on niche, monetizable trends in wellness, beauty, food/diet, ',
            'fitness, home improvement, or cultural shifts. Ignore generic/commodity products.\n\n',
            'PRODUCT LIST:\n',
            LEFT(PRODUCT_LIST, 12000), -- Cortex input limit
            '\n\nReturn a JSON array of objects, each with:\n',
            '- "theme": short trend name (3-6 words, e.g. "Natural Deodorant Alternatives")\n',
            '- "description": 1-2 sentence description of the consumer trend, mentioning specific ',
            'product types and brands as examples\n',
            '- "product_count": approximate number of products from the list that fit this theme\n\n',
            'Only return the JSON array, no other text. If no clear themes emerge, return [].'
        ) AS PROMPT
    FROM TEMP_AMAZON_DEPT_PRODUCTS;

    -- 3. Batch LLM call — one Cortex query processes all departments in parallel
    CREATE OR REPLACE TEMPORARY TABLE TEMP_AMAZON_THEMES AS
    SELECT
        p.DEPARTMENT,
        p.SIGNAL_DATE,
        p.PRODUCT_COUNT,
        SNOWFLAKE.CORTEX.COMPLETE('llama3.1-70b', p.PROMPT) AS LLM_RESPONSE
    FROM TEMP_AMAZON_PROMPTS p;

    -- 4. Parse LLM responses and flatten into individual theme rows
    CREATE OR REPLACE TEMPORARY TABLE TEMP_AMAZON_PARSED AS
    SELECT
        t.DEPARTMENT,
        t.SIGNAL_DATE,
        t.PRODUCT_COUNT AS DEPT_PRODUCT_COUNT,
        theme.value:theme::STRING AS THEME_NAME,
        theme.value:description::STRING AS THEME_DESCRIPTION,
        theme.value:product_count::NUMBER AS THEME_PRODUCT_COUNT
    FROM TEMP_AMAZON_THEMES t,
    LATERAL FLATTEN(input => TRY_PARSE_JSON(
        -- Extract JSON array from response (handle markdown code blocks)
        CASE
            WHEN LLM_RESPONSE LIKE '%```json%'
            THEN REGEXP_SUBSTR(LLM_RESPONSE, '```json\\s*(.+?)\\s*```', 1, 1, 's', 1)
            WHEN LLM_RESPONSE LIKE '%```%'
            THEN REGEXP_SUBSTR(LLM_RESPONSE, '```\\s*(.+?)\\s*```', 1, 1, 's', 1)
            ELSE TRIM(LLM_RESPONSE)
        END
    )) theme
    WHERE theme.value:theme IS NOT NULL;

    SELECT COUNT(*) INTO :theme_count FROM TEMP_AMAZON_PARSED;

    -- 5. Delete previous aggregated amazon signals for these dates (idempotent)
    DELETE FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
    WHERE SOURCE_NAME = 'amazon_trends'
        AND SIGNAL_TIMESTAMP::DATE IN (SELECT DISTINCT SIGNAL_DATE FROM TEMP_AMAZON_PARSED);

    -- 6. Insert aggregated theme signals
    INSERT INTO MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
        (SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP, SIGNAL_TITLE, SIGNAL_TEXT, METADATA)
    SELECT
        CONCAT('amazon_trends_', DEPARTMENT, '_', SIGNAL_DATE::VARCHAR, '_', ROW_NUMBER() OVER (PARTITION BY DEPARTMENT, SIGNAL_DATE ORDER BY THEME_PRODUCT_COUNT DESC)) AS SIGNAL_ID,
        'amazon_trends' AS SOURCE_NAME,
        SIGNAL_DATE::TIMESTAMP_NTZ AS SIGNAL_TIMESTAMP,
        THEME_NAME AS SIGNAL_TITLE,
        CONCAT(
            'Consumer trend in Amazon ', REPLACE(DEPARTMENT, '-', ' '),
            ': ', THEME_DESCRIPTION,
            ' (Based on ', THEME_PRODUCT_COUNT::VARCHAR, ' of ', DEPT_PRODUCT_COUNT::VARCHAR,
            ' trending products in this category)'
        ) AS SIGNAL_TEXT,
        OBJECT_CONSTRUCT(
            'department', DEPARTMENT,
            'theme_product_count', THEME_PRODUCT_COUNT,
            'dept_product_count', DEPT_PRODUCT_COUNT,
            'aggregation_date', SIGNAL_DATE::VARCHAR
        ) AS METADATA
    FROM TEMP_AMAZON_PARSED;

    result := OBJECT_CONSTRUCT(
        'status', 'complete',
        'departments_processed', dept_count,
        'themes_extracted', theme_count
    )::VARCHAR;

    RETURN result;
END;
$$;
