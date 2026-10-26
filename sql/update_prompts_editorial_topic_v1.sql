-- editorial.topic v1 -- the editorial-ingest task handler's topic call
-- (CRMA-1668, spec docs/prd/editorial-trend-ingest-endpoint.md "The task
-- handler", step 1; decision CRMA-1658).
--
-- Inserts into MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT. This file is the
-- registration record; apply this single statement by hand. The audit agent's
-- q_prompt_drift manifest carries ('editorial.topic', 1) from the same commit
-- (CRMA-469).
--
-- The topic is the candidate's TOPIC (VARCHAR(200)) and becomes the trend's
-- TREND_TOPIC; enrichment names the trend later from it (ADR-0001), so this
-- writes a description, not a name. Register: distillation's
-- "noun-verb description, <=80 chars".
--
-- services/editorial-ingest/editorial_ingest/handler.py code-pins the model
-- and the call shape (gemini-3.7-flash, tool-free, responseMimeType
-- application/json, temperature 1.0 with thinking -- tt_services_lib.gemini)
-- and sends the user message as JSON {brief, url_titles}. It reads TEMPLATE
-- only; MODEL and MODEL_PARAMS record that shape.
--
-- The WHERE NOT EXISTS guard makes a re-run a safe no-op: the PRIMARY KEY
-- (PROMPT_KEY, VERSION) is informational-only in Snowflake.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  'editorial.topic',
  1,
  'gemini-3.7-flash',
  $$You write the topic for a consumer trend that a strategist or an editor has nominated by hand, for a trend-tracking pipeline.

You get JSON: "brief", the person's own free-text description of the trend, and "url_titles", the titles of the pages they attached as evidence.

Write ONE topic: a specific noun-verb description of the consumer behavior, at most 80 characters. Name the product, ingredient or practice, and what consumers are doing with it.
Good: "Cottage cheese eaten as a high-protein snack", "Mouth taping for better sleep", "Tinned fish boards replacing charcuterie at parties".

Rules:
- Describe the trend; do not coin a catchy name or a slogan.
- Use the brief's meaning, not its wording, when the brief is long or informal.
- Use the titles only to make the topic more specific; never invent facts that are in neither.
- No hashtags, no brand ads, no quotes, no trailing period.

Return JSON only: {"topic": "<the topic>"}.$$,
  PARSE_JSON('{"temperature": 1.0, "response_mime_type": "application/json", "thinking_level": "medium"}'),
  TRUE,
  SHA2(CONCAT('editorial.topic.v1', CURRENT_TIMESTAMP()::STRING)),  -- placeholder hash, matches this repo's existing insert-file convention
  'crma1668_editorial_ingest',
  'CRMA-1668: editorial nomination topic writer (brief + URL titles -> TOPIC).'
WHERE NOT EXISTS (
  SELECT 1 FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  WHERE PROMPT_KEY = 'editorial.topic' AND VERSION = 1
);
