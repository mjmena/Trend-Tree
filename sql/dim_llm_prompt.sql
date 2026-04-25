-- DIM_LLM_PROMPT — versioned prompt registry
--
-- Source of truth for every LLM prompt template used by Trend-Tree workflows.
-- Workflows fetch the active version at the top of each run via the registry
-- snowflake-execute-sql-query action; rendering substitutes {{var}} placeholders
-- against runtime-built vars in JS.
--
-- Versioning: a new version of a prompt is INSERT + UPDATE old IS_ACTIVE=FALSE
-- in one transaction. CONTENT_HASH guards against accidental no-op upserts.
--
-- Audit join: STG_LLM_PROMPT_LOGS gets PROMPT_KEY + PROMPT_VERSION columns
-- (see alter_stg_llm_prompt_logs.sql) so every call ties back to the exact
-- template that produced it. That makes A/B by prompt version a SQL JOIN.

CREATE TABLE IF NOT EXISTS MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT (
    PROMPT_KEY      VARCHAR    NOT NULL,
    VERSION         INTEGER    NOT NULL,
    MODEL           VARCHAR    NOT NULL,
    TEMPLATE        VARCHAR    NOT NULL,
    MODEL_PARAMS    VARIANT,
    IS_ACTIVE       BOOLEAN    NOT NULL DEFAULT FALSE,
    CONTENT_HASH    VARCHAR    NOT NULL,
    CREATED_AT      TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CREATED_BY      VARCHAR,
    NOTES           VARCHAR,
    CONSTRAINT PK_DIM_LLM_PROMPT PRIMARY KEY (PROMPT_KEY, VERSION)
);

COMMENT ON TABLE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT IS
'Versioned prompt registry. One row per (PROMPT_KEY, VERSION). Exactly one row per PROMPT_KEY should have IS_ACTIVE=TRUE — workflows query WHERE IS_ACTIVE=TRUE.';

COMMENT ON COLUMN MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT.PROMPT_KEY IS
'Stable identifier, e.g. enrichment.gemini.categorize, distillation.subagent.system.';

COMMENT ON COLUMN MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT.TEMPLATE IS
'Prompt body with {{var}} mustache placeholders. Calling code precomputes complex values (formatted lists, joined arrays) into flat strings before substitution.';

COMMENT ON COLUMN MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT.MODEL_PARAMS IS
'JSON of model invocation params: {temperature, max_tokens, response_format, system_role, ...}. Caller spreads into the API request body.';

COMMENT ON COLUMN MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT.CONTENT_HASH IS
'sha256 of TEMPLATE || JSON_STRING(MODEL_PARAMS). Caller computes and the seed verifies — guards against silent no-op updates.';
