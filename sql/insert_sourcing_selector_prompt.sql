-- sourcing.selector v1 — the ecomm agent's product-selector prompt (CRMA-776,
-- epic CRMA-772 "Trend-to-product sourcing").
--
-- Inserts into MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT.
--
-- Verbatim system/instruction content, settled and validated live against
-- gemini-3.7-flash during the CRMA-754 prototype (22/22 clean emits across
-- 7 contract cases + 15 stability repeats — see
-- docs/wayfinder/assets/crma-754-selector-contract.md). MODEL is a code
-- constant in the ecomm agent (agents/lib per this repo's fleet convention:
-- only discovery lanes are registry-driven), but is recorded here too so
-- this row is a complete, replayable record of the call shape.
--
-- {slots} is a single-brace placeholder (verbatim from the prototype,
-- deliberately NOT this repo's {{mustache}} convention used elsewhere in
-- DIM_LLM_PROMPT) — the ecomm agent substitutes it with a plain string
-- replace, not the generic double-brace renderer, before sending. For this
-- single-tier build {slots} is always MAX_SOURCED_PRODUCTS (5, see
-- agents/lib/sourcing_run.mjs) — the multi-tier top-up math that would
-- otherwise reduce it is out of scope.
--
-- The user message (trend block + numbered candidate pool) is NOT a
-- registry row — it's assembled directly in ecomm-agent/run_sourcing by
-- agents/lib/sourcing_run.mjs's formatCandidatesForPrompt(), mirroring how
-- enrichment.agent.user differs from enrichment.agent.system: only the
-- fixed instruction content is worth versioning here.
--
-- No `temperature` key in MODEL_PARAMS — deprecated fleet-wide as of
-- 2026-07-21 (CRMA-726 strips it fleet-wide); this lane is born without it.

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
  (PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS, IS_ACTIVE, CONTENT_HASH, CREATED_BY, NOTES)
SELECT
  'sourcing.selector',
  1,
  'gemini-3.7-flash',
  $$You are the product selector for the Trend Tree sourcing pass.

A trend is an emerging consumer behavior our pipeline has verified. You receive one
trend and a short list of store products that a vector search ranked most similar to
it. Similarity is geometry, not fit: near-identical scores can hide both a perfect
match and an irrelevant product. Your job is the judgement the score cannot make.

Rules:
- Select only products a shopper following this trend would recognize as serving it.
- You may select at most {slots} products. Fewer is normal.
- Returning nothing is a first-class outcome, not a failure. If no candidate genuinely
  serves the trend, emit outcome "no_match" with an empty picks list. Most trends have
  no match in this small catalog; never return the least-irrelevant items to fill space.
- Sharing an ingredient, a category, or vocabulary with the trend is not fit. The
  product must serve the trend's actual behavior.
- Grade each pick honestly with reasoned_fit:
  - "strong": the product IS the trend item, or a direct instance of the behavior — an
    operator sees the connection instantly.
  - "partial": the product serves the trend's underlying need or ritual, but is not the
    trend item itself.
  - "weak": connected only through an ingredient, category, or audience; defensible but
    a stretch. Use sparingly; never to fill slots.
- rationale: one sentence (max 25 words) an operator will read on the Decision Page.
  Plain language, no scores, no hedging.
- pool_note: one sentence on the pool overall — what you rejected and why, or why
  nothing matched.
$$,
  PARSE_JSON('{"thinking_level": "low", "function_calling_mode": "ANY", "max_iterations": 1, "budget_usd": 0.02, "per_call_max_tokens": 1024}'),
  TRUE,
  SHA2(CONCAT('sourcing.selector.v1', CURRENT_TIMESTAMP()::STRING)),  -- placeholder hash, matches this repo's existing insert-file convention
  'crma776_ecomm_agent',
  'CRMA-776/CRMA-772: Shopify-tier product selector. Ungrounded gemini-3.7-flash, forced-function mode=ANY on propose_product_selection, thinkingLevel=low, no temperature param. Filter, never a ranker — no rank field in the emit schema. Validated live during the CRMA-754 prototype (docs/wayfinder/assets/crma-754-selector-contract.md).';
