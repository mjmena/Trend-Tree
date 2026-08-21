// Ecomm Agent — the selector call (CRMA-776, epic CRMA-772).
//
// Ported from the removed Pipedream step ecomm-agent/run_sourcing/entry.mjs
// (commit 61d0318). Code-pinned model + call shape, per the CRMA-754 prototype
// contract — deliberately NOT registry-driven for the model/params beyond what
// DIM_LLM_PROMPT's MODEL_PARAMS overrides, matching this repo's fleet
// convention that only discovery lanes take their model from the registry.
//
// The prompt TEXT is registry-driven: sourcing.selector v1 in
// MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT (already live — see
// sql/insert_sourcing_selector_prompt.sql, which is the registration record,
// not something this service runs).
//
// rates_per_m is a public-pricing ESTIMATE for gemini-3.7-flash (this repo has
// no confirmed-invoice rate for it yet), sanity-checked against the CRMA-754
// prototype's measured $0.0013-$0.0032/call.

import { runAgentLoop } from "../lib/gemini_loop.mjs";
import { MAX_SOURCED_PRODUCTS, formatCandidatesForPrompt } from "../lib/sourcing_run.mjs";

export const SELECTOR_MODEL = "gemini-3.7-flash";
export const SELECTOR_RATES_PER_M = { input: 0.30, output: 2.50 }; // ESTIMATE — see comment above

// Built per-call (not a static constant) so the `{slots}` placeholder in
// picks.description is actually rendered — it must match the slots count
// stated in the (separately rendered) system prompt, not leak the literal
// template text into what Gemini reads as its own tool schema.
export function buildProposeProductSelectionSchema(slots) {
  return {
    name: "propose_product_selection",
    description: "Emit the sourcing pass's product selection for this trend. Call this exactly once.",
    input_schema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["matched", "no_match"],
          description: "matched if at least one product genuinely serves the trend; no_match otherwise.",
        },
        picks: {
          type: "array",
          description: `Up to ${slots} picks. Empty when outcome=no_match.`,
          items: {
            type: "object",
            properties: {
              catalog_product_id: { type: "string", description: "Echoed verbatim from the shown candidate pool." },
              reasoned_fit: { type: "string", enum: ["strong", "partial", "weak"] },
              rationale: { type: "string", description: "One sentence, max 25 words, operator-facing. No scores, no hedging." },
            },
            required: ["catalog_product_id", "reasoned_fit", "rationale"],
          },
        },
        pool_note: {
          type: "string",
          description: "One sentence on the pool overall — what was rejected and why, or why nothing matched.",
        },
      },
      required: ["outcome", "picks", "pool_note"],
    },
  };
}

// The emit tool is terminal and shallow: there is nothing to execute, the
// arguments ARE the output. Acknowledging it keeps the loop's contract intact.
async function dispatchSelectorTool() {
  return { accepted: true };
}

export function renderSlots(template, slots) {
  return String(template ?? "").split("{slots}").join(String(slots));
}

export function buildSelectorUserMessage(trend, pool) {
  const t = trend || {};
  return [
    "Trend:",
    `  Name: ${t.trend_name || "(unnamed)"}`,
    `  Category: ${t.category || "?"} / ${t.subcategory || "?"}`,
    `  Summary: ${t.summary_short || "(none)"}`,
    "",
    "Candidates (score-descending):",
    formatCandidatesForPrompt(pool),
  ].join("\n");
}

export async function callSelector({ apiKey, prompt, trend, pool, slots = MAX_SOURCED_PRODUCTS }) {
  const system = renderSlots(prompt.template, slots);
  const user_message = buildSelectorUserMessage(trend, pool);
  const params = prompt.params || {};

  // ?? (not ||): a deliberate falsy override in MODEL_PARAMS — e.g.
  // budget_usd:0 as an incident kill-switch — must take effect, not get
  // silently discarded by a truthiness fallback.
  const result = await runAgentLoop({
    api_key: apiKey,
    tool_names: ["propose_product_selection"],
    all_schemas: { propose_product_selection: buildProposeProductSelectionSchema(slots) },
    system,
    user_message,
    context: {},
    dispatchTool: dispatchSelectorTool,
    model: SELECTOR_MODEL,
    function_calling_mode: params.function_calling_mode ?? "ANY",
    thinking_level: params.thinking_level ?? "low",
    temperature: null, // deprecated fleet-wide — never sent for this lane
    max_iterations: params.max_iterations ?? 1,
    budget_usd: params.budget_usd ?? 0.02,
    per_call_max_tokens: params.per_call_max_tokens ?? 1024,
    rates_per_m: SELECTOR_RATES_PER_M,
  });

  const call = result.tool_calls.find((c) => c.name === "propose_product_selection");
  return { emit: call ? call.input : null, telemetry: result };
}
