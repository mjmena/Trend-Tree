-- signal.attribution.rubric v2/v3 backfill (CRMA-469)
--
-- GOVERNANCE GAP THIS FILE CLOSES: live DIM_LLM_PROMPT.signal.attribution.rubric
-- was edited directly in Snowflake at least twice after the v1 seed
-- (sql/seed_prompts_signal_attribution.sql) landed, with no committed
-- migration. Worse than the usual drift case: those edits were made by
-- UPDATE-ing the ORIGINAL row's VERSION/TEMPLATE columns in place, not by
-- inserting new versioned rows. So today only ONE row exists for this key
-- (VERSION=3, IS_ACTIVE=TRUE) — there is no surviving v2 row to read back.
--
-- v2's exact content is UNRECOVERABLE:
--   - Table DATA_RETENTION_TIME_IN_DAYS = 1, so Time Travel cannot reach
--     back to the intermediate edit.
--   - This account has no SNOWFLAKE.ACCOUNT_USAGE access, and
--     INFORMATION_SCHEMA.QUERY_HISTORY's window doesn't reach back to the
--     row's CREATED_AT (2026-04-30) either.
-- So this migration backfills v3 only — the current live content, which
-- IS recoverable — and documents v2 as a real but unrecoverable step.
--
-- DRIFT-ARCHAEOLOGY (v1 committed vs. v3 live, diffed by hand — v2's
-- intermediate state is folded in here since it can't be isolated):
--   - Similarity-score guidance completely recalibrated: v1's thresholds
--     (>=0.85 high / 0.75-0.85 moderate / 0.70-0.75 lower) assumed
--     well-matched-text cosine ranges. v3 replaces them with >=0.55 /
--     0.50-0.55 / 0.45-0.50 and explains why: snowflake-arctic-embed-l-v2.0
--     compresses cross-text similarity (rich trend summary vs. short signal
--     text), so raw cosine scores never approached v1's thresholds in
--     production — v1's rubric likely under-attributed almost everything.
--   - Added a SKIP criterion for hashtag/title-only signals with no
--     substantive text.
--   - Added a guardrail clarifying SIGNAL_TIMESTAMP reflects content
--     creation date, not ingestion time, so it must not be used to judge
--     recency (candidates are already pre-filtered to the last 24h).
--
-- Idempotent: NOT EXISTS guard on (PROMPT_KEY, VERSION). Live already has
-- VERSION=3 active, so this is expected to no-op against current state —
-- its purpose is parity for the repo (and correctness on any future
-- from-scratch replay of these migrations), not a live write today.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'signal.attribution.rubric',
    3,
    'gemini-3.1-pro-preview',
    $$For each candidate signal, decide: ATTRIBUTE or SKIP. Then assign a link_type for attributed signals.

═══ ATTRIBUTE when ═══

The signal clearly extends, corroborates, or adds new evidence to the trend topic as described in TREND_TOPIC and SUMMARY_SHORT.

Good attribution signals:
- Covers the same behavior, product category, cultural moment, or named concept
- Could plausibly appear in a news story or social post *about* this trend
- Adds a new data point (e.g., new brand, new geography, new format) that fits the trend's frame
- Is from a source type not yet represented in the trend's signal set (increases breadth - more valuable)

═══ SKIP when ═══

The signal is only superficially related by vocabulary, not by topic:
- Shares keywords with the trend topic but describes a different concept (e.g., "thermal" in a heat-pump story when the trend is thermal recovery spas)
- Is about a macro category the trend belongs to, not the trend itself (e.g., signal about "skincare industry growth" when the trend is specifically about microneedling patches)
- Comes from a clearly distinct semantic cluster that happened to score high on cosine similarity
- Is promotional/spam/noise (press release language, bot-generated, duplicate of another candidate)
- Is a hashtag-only or title-only signal with no substantive text - skip unless the title alone is unambiguous

Note: all candidate signals have been pre-filtered to those ingested within the last 24 hours, so do NOT use SIGNAL_TIMESTAMP to judge recency - that reflects content creation date, not when we observed it.

═══ Similarity score guidance ═══

Vectors are produced by snowflake-arctic-embed-l-v2.0 comparing a rich trend summary against short signal text. Cross-text similarities are compressed - 0.55 here is equivalent to a strong match.

- >= 0.55: high prior; review and almost always attribute unless topic mismatch is clear
- 0.50-0.55: moderate prior; read the signal text carefully before attributing
- 0.45-0.50: lower prior; attribute only if topic alignment is unmistakable

═══ link_type assignment ═══

Assign based on signal source and content:
- news: GDELT, editorial/journalistic content, press coverage of the trend
- social: Bluesky, TikTok, Pinterest, Reddit, consumer-generated posts
- commerce: Amazon Trends, product launches, purchase-intent signals
- other: Google Trends, Wikimedia, Grok live search, anything not fitting above

═══ Breadth bonus (do not over-weight) ═══

A signal from a source type not yet in the trend's link set adds more value than a third signal from the same source. Note this in your reasoning but do not lower the attribution bar for breadth alone - topic alignment still governs.

═══ Cap ═══

Attribute at most 20 signals per run. If more than 20 candidates qualify, take the 20 with the highest cosine similarity. Logging volume is not the goal; accurate velocity signal is.$$,
    NULL,
    TRUE,
    '49c6da0dc48fbd2d2199249fada19cd1c63fc73a8af895b02b75c54ba66fe0c9',
    'crma469_backfill',
    'v3 (recovered from live DIM_LLM_PROMPT, 2026-08-18). v2 is unrecoverable — the v1 row was edited in place rather than versioned by insert, so no v2 snapshot survives; CONTENT_HASH reused verbatim from the live row rather than recomputed, to match it exactly. See CRMA-469 and the file header for the reconstructed v1->v3 diff.'
WHERE NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'signal.attribution.rubric' AND VERSION = 3
);

-- Deactivate v1 so exactly one row stays IS_ACTIVE=TRUE. On today's live table
-- this is a no-op (v1 no longer exists as its own row — it was mutated in
-- place into what is now the v3 row). It matters on a from-scratch replay:
-- run seed_prompts_signal_attribution.sql (inserts v1, IS_ACTIVE=TRUE) then
-- this file — without this UPDATE, v1 and v3 would both end up active.
UPDATE DIM_LLM_PROMPT
SET IS_ACTIVE = FALSE WHERE PROMPT_KEY = 'signal.attribution.rubric' AND VERSION = 1;

-- Verify: v3 present, matches live CONTENT_HASH, and is the only active row.
SELECT VERSION, IS_ACTIVE, CONTENT_HASH,
  CASE WHEN CONTENT_HASH = '49c6da0dc48fbd2d2199249fada19cd1c63fc73a8af895b02b75c54ba66fe0c9' THEN 'ok' ELSE 'MISMATCH' END AS HASH_CHECK
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'signal.attribution.rubric' ORDER BY VERSION;

SELECT COUNT(*) AS ACTIVE_ROW_COUNT
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'signal.attribution.rubric' AND IS_ACTIVE = TRUE;
