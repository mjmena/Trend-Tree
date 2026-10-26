-- editorial.sameness v1 -- the editorial-ingest task handler's sameness
-- judgment (CRMA-1671, spec docs/prd/editorial-trend-ingest-endpoint.md
-- "The task handler", step 2; decision CRMA-1638).
--
-- Inserts into MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT. This file is the
-- registration record; apply this single statement by hand. The audit agent's
-- q_prompt_drift manifest carries ('editorial.sameness', 1) from the same
-- commit (CRMA-469).
--
-- services/editorial-ingest/editorial_ingest/handler.py code-pins the model
-- and the call shape (gemini-3.8-flash, tool-free, responseMimeType
-- application/json, temperature 1.0 with thinking -- tt_services_lib.gemini),
-- builds the neighbor pool with promotion's recipe (cosine >= 0.50, top 8,
-- RETIRED included), skips this call when the pool is empty, and sends the
-- user message as JSON {nomination: {topic, brief, url_titles}, neighbors:
-- [{trend_id, topic, summary, lifecycle_status, similarity}]}. A reply whose
-- match is not one of the neighbors' trend_ids fails the task. It reads
-- TEMPLATE only; MODEL and MODEL_PARAMS record that shape.
--
-- The WHERE NOT EXISTS guard makes a re-run a safe no-op: the PRIMARY KEY
-- (PROMPT_KEY, VERSION) is informational-only in Snowflake.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  'editorial.sameness',
  1,
  'gemini-3.8-flash',
  $$You decide whether a consumer trend that a strategist or an editor has nominated by hand is the same trend as one the pipeline already tracks.

You get JSON:
- "nomination": the nominated trend's "topic", the person's own "brief", and "url_titles", the titles of the pages they attached.
- "neighbors": up to 8 tracked trends whose embedding is close to the nomination, each with "trend_id", "topic", "summary", "lifecycle_status" and "similarity" (cosine, 0.50 to 1.00).

Two trends are the SAME when they describe the same consumer behavior around the same product, ingredient or practice, so that the person's evidence would sit naturally on the tracked trend. Wording, angle or time frame can differ.
They are DIFFERENT when one is a broader category of the other, a neighboring product, a different audience doing a different thing, or merely the same topic area.
Example: "Tinned fish boards replacing charcuterie at parties" is the same as "Conservas served as party boards", but different from "Tinned fish as a high-protein lunch" and from "Charcuterie boards at weddings".

Rules:
- Pick at most one neighbor: the one that is clearly the same trend. If none is, answer no match. When in doubt, answer no match.
- A neighbor's lifecycle_status, including RETIRED, does not matter; judge only what the trend is.
- Similarity is a hint, not the answer: a high score can still be a different trend.
- "match" must be one of the neighbors' trend_id values exactly, or null.

Return JSON only: {"match": "<trend_id>" or null, "rationale": "<one or two sentences: why it is the same trend, or why none is>"}.$$,
  PARSE_JSON('{"temperature": 1.0, "response_mime_type": "application/json", "thinking_level": "medium"}'),
  TRUE,
  SHA2(CONCAT('editorial.sameness.v1', CURRENT_TIMESTAMP()::STRING)),  -- placeholder hash, matches this repo's existing insert-file convention
  'crma1671_editorial_ingest',
  'CRMA-1671: editorial nomination sameness judge (nomination + neighbor pool -> match trend_id or null).'
WHERE NOT EXISTS (
  SELECT 1 FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  WHERE PROMPT_KEY = 'editorial.sameness' AND VERSION = 1
);
