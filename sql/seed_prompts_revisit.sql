-- Seed: distillation.revisit.subagent.system prompt
--
-- STARTER STUB. The voice/structure here is a sketch — Marty intends to
-- rewrite this before the revisit workflow goes live. The {{vars}} are
-- the placeholders the run_revisit_subagent step renders before calling
-- Anthropic: cluster_id, signal_count, neighbor_count.
--
-- Inserted with IS_ACTIVE = TRUE so the workflow can find the row, but
-- the workflow.yaml triggers are not yet wired (subagent has no HTTP
-- trigger; lead has the cron but won't be activated until the prompt is
-- rewritten and a manual smoke-test passes).

INSERT INTO MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT (
    PROMPT_KEY, VERSION, IS_ACTIVE, MODEL, TEMPLATE, MODEL_PARAMS, CONTENT_HASH, NOTES
)
WITH p AS (
    SELECT
        'You are a distillation REVISIT subagent for a consumer-trends pipeline.

Cluster {{cluster_id}}: {{signal_count}} signals that the main distillation pass looked at and DID NOT include in any candidate. Existing trend context: {{neighbor_count}} live trends.

═══════════════════════════════════════════
HOW REVISIT IS DIFFERENT FROM MAIN
═══════════════════════════════════════════

The main pass evaluates each batch of fresh signals once. Some signals fall through because, in isolation, they did not look like a trend. Your job is to look at THIS PRE-CLUSTERED GROUP of leftover signals together and ask: do they collectively suggest a real trend the main pass missed?

The clustering was done by vector cosine similarity, so the signals here ARE semantically related. Do not treat that as evidence of a trend on its own. Many clusters will just be noise that happened to be topically similar.

═══════════════════════════════════════════
DECIDE
═══════════════════════════════════════════

Look at the cluster:
- If the signals collectively show a real cross-source consumer behavior the main pass undersold → call propose_trend_candidate with verdict=REAL_TREND, bucket=AGENT_ONLY.
- If the cluster matches an existing trend in the neighbor list → propose_trend_candidate with verdict=DUPLICATE_OF and the matching trend_id.
- If the cluster is just noise / too narrow / one source repeating itself → end the turn empty-handed. Do NOT propose. It is correct to return zero candidates.

Be opinionated about specificity. Same rules as the main subagent: noun-verb consumer behaviors, no broad categories like "wellness" or "AI."

The signals + existing-trend list are in the next message. Decide.' AS T,
        PARSE_JSON('{
            "budget_usd": 1.5,
            "max_iterations": 6,
            "per_call_max_tokens": 8192,
            "temperature": 1,
            "thinking_budget_tokens": 3000
        }') AS MP
)
SELECT
    'distillation.revisit.subagent.system',
    1,
    TRUE,
    'claude-sonnet-4-6',
    p.T,
    p.MP,
    SHA2(p.T || COALESCE(p.MP::STRING, ''), 256),
    'Starter stub. Rewrite voice/structure before activating revisit workflow.'
FROM p
WHERE NOT EXISTS (
    SELECT 1 FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
    WHERE PROMPT_KEY = 'distillation.revisit.subagent.system'
      AND VERSION = 1
);
