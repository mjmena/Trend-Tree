-- ingestion.tiktok.filter v1 — the TikTok ingester's title filter (CRMA-1337,
-- epic CRMA-1336, spec docs/prd/serpapi-sources.md "TikTok ingester").
--
-- Inserts into MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT. This file is the
-- registration record; apply this single statement by hand. The audit agent's
-- q_prompt_drift manifest carries ('ingestion.tiktok.filter', 1) from the same
-- commit (CRMA-469).
--
-- The text is the CRMA-1325 prototype prompt (docs/wayfinder/assets/crma-1325-filter.py
-- on the serpapi-sources map), adapted to title-only input: google_short_videos
-- returns no snippet. It restates the distillation rubric's test and drop list.
-- The prototype's grades on gemini-3.7-flash: 45% PASS on the category seeds,
-- 35% overall, against the 30% bar (#18).
--
-- services/lib/tiktok_filter.mjs code-pins the model and the call shape
-- (gemini-3.7-flash, temperature 0, responseMimeType application/json) and
-- builds the user message: "Results:" plus one "<i>. <title>" line per title,
-- about 40 per call. MODEL and MODEL_PARAMS below record that shape; the
-- service does not read them. temperature 0 departs from the CRMA-726
-- convention on purpose: the filter was validated at temperature 0.
--
-- The WHERE NOT EXISTS guard makes a re-run a safe no-op: the PRIMARY KEY
-- (PROMPT_KEY, VERSION) is informational-only in Snowflake.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  'ingestion.tiktok.filter',
  1,
  'gemini-3.7-flash',
  $$You screen TikTok search results for a consumer-trends pipeline. Each result is one video title.

KEEP a result only if its title names a SPECIFIC product, ingredient, or practice that a consumer is doing: "a noun phrase you can put on a slide and a verb a consumer is doing".
Good: "Cottage cheese as high-protein snack", "Mouth taping for sleep", "Sleepy girl mocktail (tart cherry + magnesium)".

DROP:
- categories ("skincare", "supplements")
- generic routines
- listicles ("20 Amazon finds")
- hauls
- rankings
- unboxings of a long-established product
- brand ads
- deal posts
- titles with no nameable product or practice

Return JSON only: a list with one object per result, {"i": <index>, "keep": true|false, "phrase": "<the noun phrase, or empty>"}.$$,
  PARSE_JSON('{"temperature": 0, "response_mime_type": "application/json", "batch_size": 40}'),
  TRUE,
  SHA2(CONCAT('ingestion.tiktok.filter.v1', CURRENT_TIMESTAMP()::STRING)),  -- placeholder hash, matches this repo's existing insert-file convention
  'crma1337_tiktok_ingest',
  'CRMA-1337: TikTok ingester title filter, from the CRMA-1325 prototype prompt (title-only input).'
WHERE NOT EXISTS (
  SELECT 1 FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  WHERE PROMPT_KEY = 'ingestion.tiktok.filter' AND VERSION = 1
);
