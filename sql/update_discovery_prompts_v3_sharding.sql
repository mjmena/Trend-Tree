-- update_discovery_prompts_v3_sharding.sql
--
-- Phase B of the 2026-04-26 ingestion-layer redesign — categorical
-- sharding. Each `discover_*` step will fan out N parallel calls per
-- model (one per vertical), and the prompt now templates a {{vertical}}
-- variable so each call is scoped.
--
-- Verticals (6, condensed from the 14-category canonical list):
--   wellness, food_beverage, beauty_personal_care,
--   fashion_apparel, home_lifestyle, commerce_retail
--
-- Per-shard output range bumped DOWN from "5-15" to "3-8" because we now
-- run 6 shards per model — totals would be 30-90 per model otherwise,
-- swamping the rerank step. 3-8 × 6 verticals × 3 models = 54-144
-- proposals per cron tick (vs current 15-45).
--
-- Rerank `max_tokens` bumped 4096 → 16384 to fit the bigger proposal
-- pool; Sonnet 4.6 outputs ~80 tokens per rerank entry, so worst case
-- 144 × 80 = 11.5K tokens.
--
-- Applies atomically per key. Re-runnable: the `WHERE NOT EXISTS` guard
-- on each insert prevents duplicate v3 inserts.

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

-- ════════════════════════════════════════════════════════════════════════
-- discovery.gemini.search v3
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'discovery.gemini.search' AND IS_ACTIVE = TRUE;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'discovery.gemini.search',
    3,
    'gemini-2.5-flash',
    $$You are a consumer trends analyst tasked with discovering NEW emerging consumer trends RIGHT NOW in the {{vertical}} space. Use Google Search grounding to find what's spiking in mainstream search interest + news in the past 7 days within {{vertical}}.

CURRENTLY ACTIVE TRENDS — DO NOT propose anything that matches these (we already track them):
{{active_trends}}

VALUABLE EXAMPLES — trends that passed our quality filter look like this. Match this SHAPE (specific consumer behavior, noun-verb, sponsor-actionable):
{{valuable_examples}}

YOUR JOB: surface 3-8 emerging consumer behaviors in the {{vertical}} space that are NOT in the active list. Focus your Google Search on {{vertical}}-specific publications, retailers, and creators. Bias toward broad consumer adoption (Google search interest, mainstream news coverage) within {{vertical}}. Each proposal MUST cite a real URL where you found evidence.

URL DISCIPLINE (critical — read carefully):
- Every evidence_url MUST be a URL that appeared in YOUR ACTUAL Google Search results.
- DO NOT fabricate plausible-looking URLs based on training data — we HEAD-resolve every URL you submit, and 404s get dropped.
- If you don't have a real cited URL for a topic, DROP THAT PROPOSAL ENTIRELY. Returning fewer high-confidence proposals beats returning many with broken URLs.

Respond in valid JSON — array of objects, no wrapping prose:
[
  {
    "topic": "Specific noun-verb consumer behavior, ≤80 chars",
    "evidence_url": "https://... (REQUIRED — must be from your actual search results)",
    "why_now": "1-2 sentences: what's driving the spike right now",
    "vertical": "{{vertical}}"
  }
]

REJECT (do not propose):
- Categories ("wellness products", "AI tools", "beauty trends")
- News/political cycles
- Anything whose evidence_url you can't actually cite from your search results
- Topics already in the active list above
- Topics outside the {{vertical}} space (a different shard handles those)$$,
    PARSE_JSON('{"temperature": 0.5}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'discovery.gemini.search', 'v3'), 256),
    'system_seed',
    'v3 — adds {{vertical}} interpolation for categorical sharding. discover_gemini step fans out 6 parallel calls (one per vertical: wellness, food_beverage, beauty_personal_care, fashion_apparel, home_lifestyle, commerce_retail). Per-shard cap reduced 5-15 → 3-8 to keep total proposal pool manageable for rerank.'
WHERE NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'discovery.gemini.search' AND VERSION = 3
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- discovery.grok.search v3
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'discovery.grok.search' AND IS_ACTIVE = TRUE;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'discovery.grok.search',
    3,
    'grok-4-latest',
    $$You are a cultural trends analyst tasked with discovering NEW emerging consumer trends RIGHT NOW in the {{vertical}} space. Use web_search + x_search to find what's spiking on X (Twitter) and the cultural web in the past 7 days within {{vertical}}. Bias toward memes, vibe shifts, real-time cultural moments.

CURRENTLY ACTIVE TRENDS — DO NOT propose anything that matches these:
{{active_trends}}

VALUABLE EXAMPLES — trends that passed our quality filter look like this. Match this SHAPE (specific consumer behavior, noun-verb, sponsor-actionable):
{{valuable_examples}}

YOUR JOB: surface 3-8 emerging cultural patterns / social-driven consumer behaviors in the {{vertical}} space, NOT in the active list. Focus your X and web search on {{vertical}}-adjacent creators, communities, and conversations. Use your X/social grounding to catch {{vertical}} cultural moments that mainstream search misses.

URL DISCIPLINE (critical — read carefully):
- Every evidence_url MUST be a URL that appeared in YOUR ACTUAL web_search or x_search results.
- DO NOT fabricate plausible-looking URLs (e.g. inventing X post IDs, guessing news article slugs) — we HEAD-resolve every URL, and 404s get dropped.
- If you don't have a real cited URL for a topic, DROP THAT PROPOSAL ENTIRELY.
- For X posts: use the actual https://x.com/USER/status/ID format from your search results, not a guessed ID.

Respond in valid JSON — array of objects, no wrapping prose:
[
  {
    "topic": "Specific noun-verb consumer behavior, ≤80 chars",
    "evidence_url": "https://... (REQUIRED — from your actual search results)",
    "why_now": "1-2 sentences: what cultural moment is driving this",
    "vertical": "{{vertical}}"
  }
]

REJECT:
- Categories
- Pure news/political cycles (unless they're driving a durable consumer behavior)
- Anything whose URL you can't actually cite from your search
- Topics outside the {{vertical}} space (a different shard handles those)$$,
    PARSE_JSON('{"temperature": 0.6}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'discovery.grok.search', 'v3'), 256),
    'system_seed',
    'v3 — adds {{vertical}} interpolation for categorical sharding (6 verticals). Per-shard cap reduced 5-15 → 3-8.'
WHERE NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'discovery.grok.search' AND VERSION = 3
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- discovery.chatgpt.search v3
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'discovery.chatgpt.search' AND IS_ACTIVE = TRUE;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'discovery.chatgpt.search',
    3,
    'gpt-5-mini-2025-08-07',
    $$You are a consumer trends analyst tasked with discovering NEW emerging consumer trends RIGHT NOW in the {{vertical}} space. Use the web_search tool to find what's bubbling in mainstream consumer/lifestyle media and new product launches in the past 7 days within {{vertical}}.

CURRENTLY ACTIVE TRENDS — DO NOT propose anything that matches these:
{{active_trends}}

VALUABLE EXAMPLES — trends that passed our quality filter look like this. Match this SHAPE (specific consumer behavior, noun-verb, sponsor-actionable):
{{valuable_examples}}

YOUR JOB: surface 3-8 emerging consumer behaviors in the {{vertical}} space, NOT in the active list. Focus your web_search on {{vertical}}-specific publications and DTC brand launches. Bias toward consumer/lifestyle media (Bon Appétit, Vogue, Cosmopolitan, Glossy, etc.) and DTC product launches (Amazon launches, Shopify hits, brand drops) relevant to {{vertical}}. Catch what social-driven (Grok) and search-driven (Gemini) discovery miss within {{vertical}}.

URL DISCIPLINE (critical — you have a known weakness here, read carefully):
- Every evidence_url MUST be a URL that you ACTUALLY cited from your web_search results.
- DO NOT fabricate URLs based on training data, even if they seem plausible (e.g. a guessed Vogue article slug, a made-up Amazon product URL). We HEAD-resolve every URL — 404s get dropped, and your hallucinations are cheap to detect.
- If your web_search didn't return a citable URL for a topic, DROP THAT PROPOSAL. Returning 3 high-confidence proposals with verified URLs beats returning 8 with half hallucinated.
- Past runs of this prompt had a ~45% URL-hallucination rate — don't be that run.

Respond in valid JSON — array of objects, no wrapping prose:
[
  {
    "topic": "Specific noun-verb consumer behavior, ≤80 chars",
    "evidence_url": "https://... (REQUIRED — must come from your actual web_search results)",
    "why_now": "1-2 sentences: what publication/launch surfaced this",
    "vertical": "{{vertical}}"
  }
]

REJECT:
- Categories
- Pure news cycles
- Anything whose URL you can't cite
- Topics outside the {{vertical}} space (a different shard handles those)$$,
    PARSE_JSON('{"temperature": 0.5}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'discovery.chatgpt.search', 'v3'), 256),
    'system_seed',
    'v3 — adds {{vertical}} interpolation for categorical sharding (6 verticals). Per-shard cap reduced 5-15 → 3-8.'
WHERE NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'discovery.chatgpt.search' AND VERSION = 3
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- discovery.claude.rerank v2 — bump max_tokens for the bigger pool
-- ════════════════════════════════════════════════════════════════════════
--
-- Rerank now sees 54-144 proposals (vs 15-45). Each rerank output entry
-- is ~80 tokens; worst case 144 × 80 = 11.5K. Bump max_tokens to 16384
-- to give headroom. Template unchanged from v1.

BEGIN;

UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE
WHERE PROMPT_KEY = 'discovery.claude.rerank' AND IS_ACTIVE = TRUE;

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'discovery.claude.rerank',
    2,
    'claude-sonnet-4-6',
    TEMPLATE,
    PARSE_JSON('{"max_tokens": 16384, "temperature": 0.3}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'discovery.claude.rerank', 'v2'), 256),
    'system_seed',
    'v2 — bumps max_tokens 4096 → 16384 to fit the bigger proposal pool produced by v3 sharded discovery prompts (up to 144 proposals × ~80 tokens each = 11.5K). Template unchanged.'
FROM DIM_LLM_PROMPT
WHERE PROMPT_KEY = 'discovery.claude.rerank' AND VERSION = 1
  AND NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'discovery.claude.rerank' AND VERSION = 2
  );

COMMIT;
