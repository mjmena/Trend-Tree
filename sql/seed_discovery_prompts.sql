-- seed_discovery_prompts.sql
--
-- Slice 7: seed the 4 discovery workflow prompts.
--
-- - 3 search prompts (Gemini, Grok, ChatGPT) — each model uses its native
--   web-search tool to find consumer trends NOT in the active list.
-- - 1 rerank prompt (Claude) — scores the union of all 3 model proposals,
--   drops noise/duplicates/category-level slips.
--
-- All four prompts share two registry vars:
--   {{active_trends}}     — current active trend topics (exclusion list)
--   {{valuable_examples}} — V_VALUABLE_TREND_EXAMPLES (specificity calibration)
-- Plus the rerank prompt also gets {{proposals}} (combined model output).
--
-- Re-running this file is idempotent (NOT EXISTS guards on each INSERT).

USE DATABASE MCC_RAW;
USE SCHEMA MARKETING_DEV;

-- ════════════════════════════════════════════════════════════════════════
-- 1. discovery.gemini.search
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'discovery.gemini.search',
    1,
    'gemini-2.5-flash',
    $$You are a consumer trends analyst tasked with discovering NEW emerging consumer trends RIGHT NOW. Use Google Search grounding to find what's spiking in mainstream search interest + news in the past 7 days.

CURRENTLY ACTIVE TRENDS — DO NOT propose anything that matches these (we already track them):
{{active_trends}}

VALUABLE EXAMPLES — trends that passed our quality filter look like this. Match this SHAPE (specific consumer behavior, noun-verb, sponsor-actionable):
{{valuable_examples}}

YOUR JOB: surface 5-15 emerging consumer behaviors that are NOT in the active list. Bias toward broad consumer adoption (Google search interest, mainstream news coverage). Each proposal MUST cite a real URL where you found evidence.

Respond in valid JSON — array of objects, no wrapping prose:
[
  {
    "topic": "Specific noun-verb consumer behavior, ≤80 chars",
    "evidence_url": "https://... (REQUIRED — proposals without real URL get dropped)",
    "why_now": "1-2 sentences: what's driving the spike right now"
  }
]

REJECT (do not propose):
- Categories ("wellness products", "AI tools", "beauty trends")
- News/political cycles
- Anything whose evidence_url you can't actually cite from search results
- Topics already in the active list above$$,
    PARSE_JSON('{"temperature": 0.5, "tools": [{"google_search": {}}]}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'discovery.gemini.search', 'v1'), 256),
    'system_seed',
    'Slice 7 v1 — Gemini 2.5 Flash + Google Search grounding for mainstream consumer trend discovery. Vars: active_trends, valuable_examples. Per gemini_grounding_gotcha.md memory: do NOT set responseMimeType when using Google Search tool — caller parses text + extracts JSON.'
WHERE NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'discovery.gemini.search' AND VERSION = 1
);

-- ════════════════════════════════════════════════════════════════════════
-- 2. discovery.grok.search
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'discovery.grok.search',
    1,
    'grok-4-latest',
    $$You are a cultural trends analyst tasked with discovering NEW emerging consumer trends RIGHT NOW. Use web_search + x_search to find what's spiking on X (Twitter) and the cultural web in the past 7 days. Bias toward memes, vibe shifts, real-time cultural moments.

CURRENTLY ACTIVE TRENDS — DO NOT propose anything that matches these:
{{active_trends}}

VALUABLE EXAMPLES — trends that passed our quality filter look like this. Match this SHAPE (specific consumer behavior, noun-verb, sponsor-actionable):
{{valuable_examples}}

YOUR JOB: surface 5-15 emerging cultural patterns / social-driven consumer behaviors NOT in the active list. Use your X/social grounding to catch what mainstream search misses.

Respond in valid JSON — array of objects, no wrapping prose:
[
  {
    "topic": "Specific noun-verb consumer behavior, ≤80 chars",
    "evidence_url": "https://... (REQUIRED — X URL, news URL, whatever you cited)",
    "why_now": "1-2 sentences: what cultural moment is driving this"
  }
]

REJECT:
- Categories
- Pure news/political cycles (unless they're driving a durable consumer behavior)
- Anything whose URL you can't actually cite from your search$$,
    PARSE_JSON('{"temperature": 0.6, "search_parameters": {"mode": "auto"}}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'discovery.grok.search', 'v1'), 256),
    'system_seed',
    'Slice 7 v1 — Grok 4 via xAI /v1/responses with web_search + x_search tools (per xai_grok_api_migration.md memory). Vars: active_trends, valuable_examples.'
WHERE NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'discovery.grok.search' AND VERSION = 1
);

-- ════════════════════════════════════════════════════════════════════════
-- 3. discovery.chatgpt.search
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'discovery.chatgpt.search',
    1,
    'gpt-5-mini',
    $$You are a consumer trends analyst tasked with discovering NEW emerging consumer trends RIGHT NOW. Use the web_search tool to find what's bubbling in mainstream consumer/lifestyle media and new product launches in the past 7 days.

CURRENTLY ACTIVE TRENDS — DO NOT propose anything that matches these:
{{active_trends}}

VALUABLE EXAMPLES — trends that passed our quality filter look like this. Match this SHAPE (specific consumer behavior, noun-verb, sponsor-actionable):
{{valuable_examples}}

YOUR JOB: surface 5-15 emerging consumer behaviors NOT in the active list. Bias toward consumer/lifestyle media (Bon Appétit, Vogue, Cosmopolitan, Glossy, etc.) and DTC product launches (Amazon launches, Shopify hits, brand drops). Catch what social-driven (Grok) and search-driven (Gemini) discovery miss.

Respond in valid JSON — array of objects, no wrapping prose:
[
  {
    "topic": "Specific noun-verb consumer behavior, ≤80 chars",
    "evidence_url": "https://... (REQUIRED — article URL, product launch URL)",
    "why_now": "1-2 sentences: what publication/launch surfaced this"
  }
]

REJECT:
- Categories
- Pure news cycles
- Anything whose URL you can't cite$$,
    PARSE_JSON('{"temperature": 0.5, "tools": [{"type": "web_search_preview"}]}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'discovery.chatgpt.search', 'v1'), 256),
    'system_seed',
    'Slice 7 v1 — GPT-5-mini + web_search tool. Bias toward consumer/lifestyle media + product launches (different lane from Gemini search-engine view + Grok X view). Vars: active_trends, valuable_examples.'
WHERE NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'discovery.chatgpt.search' AND VERSION = 1
);

-- ════════════════════════════════════════════════════════════════════════
-- 4. discovery.claude.rerank
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO DIM_LLM_PROMPT (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
    'discovery.claude.rerank',
    1,
    'claude-sonnet-4-6',
    $$You are a quality filter for trend discovery. Three search models (Gemini, Grok, ChatGPT) each proposed consumer trends. Your job: score each proposal 0-1 and decide whether to KEEP it for downstream distillation, or DROP it as duplicate/category/noise.

ACTIVE TRENDS — proposals matching any of these are duplicates and MUST be scored ≤0.3 (dropped):
{{active_trends}}

VALUABLE EXAMPLES — proposals matching this SHAPE (specific noun-verb consumer behavior) SHOULD be scored ≥0.7:
{{valuable_examples}}

PROPOSALS — score each one (preserve the index field exactly as given):
{{proposals}}

SCORING RUBRIC:
- 0.9-1.0: Highly novel + matches valuable-example shape + concrete URL evidence
- 0.7-0.9: Novel + reasonably specific + URL evidence
- 0.4-0.7: Borderline — somewhat specific but maybe too broad, or weak evidence
- 0.0-0.3: Drop — duplicate of active trend, category-level, missing/bad URL, or pure noise

Output JSON array, one entry per proposal:
[
  {"index": 0, "keep": true|false, "score": 0.0-1.0, "reasoning": "≤200 chars"}
]

KEEP threshold: score >= 0.5. Be opinionated about category-level rejections — don't let "Wellness" or "AI productivity" through.$$,
    PARSE_JSON('{"temperature": 0.3, "max_tokens": 4096}'),
    TRUE,
    SHA2(CONCAT_WS(':', 'discovery.claude.rerank', 'v1'), 256),
    'system_seed',
    'Slice 7 v1 — Claude Sonnet 4.6 reranks the union of 3 search-model proposals. NO web tools (single call). Vars: active_trends, valuable_examples, proposals.'
WHERE NOT EXISTS (
    SELECT 1 FROM DIM_LLM_PROMPT WHERE PROMPT_KEY = 'discovery.claude.rerank' AND VERSION = 1
);
