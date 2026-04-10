// Audit Agent — llm_plan
//
// Claude Sonnet 4.6 reads the rule-level candidates (split / category drift
// / stalled queue) plus a health snapshot and proposes a concrete action
// plan. The rule layer has already done the heavy filtering; the LLM's job
// is to (a) downgrade spurious splits to FLAG_ONLY if the signals look
// coherent, (b) prioritize under cost budget, and (c) attach a confidence.
//
// Output shape (consumed by apply_actions_sql via PROC_AUDIT_APPLY_ACTIONS):
//
//   {
//     health_assessment: string,
//     actions_json:       string,   // JSON-stringified array of action objects
//     actions:            array,    // the same array, for downstream JS inspection
//     cost_usd:           number,
//     tokens:             { input, output, total },
//     skipped:            string?,  // 'budget_exhausted' | 'dry_run' | 'no_candidates'
//   }
//
// Budget gate: if budget_remaining_usd < $0.10 the step returns an empty
// plan with skipped='budget_exhausted'. Dry-run short-circuits similarly.

const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 };
const MIN_BUDGET_USD = 0.10;

const ALLOWED_ACTIONS = [
  "SPLIT",
  "REQUEUE_FULL",
  "REQUEUE_REFRESH",
  "UNSTALL_QUEUE",
  "FLAG_ONLY",
];

function emptyPlan(skipped, extra = {}) {
  return {
    health_assessment: "",
    actions: [],
    actions_json: "[]",
    cost_usd: 0,
    tokens: { input: 0, output: 0, total: 0 },
    skipped,
    ...extra,
  };
}

function buildPrompt(healthRow, splitCandidates, driftCandidates, stalledQueue) {
  const health = healthRow || {};
  return `You are the auditor for an autonomous consumer-trends pipeline. Every few hours you receive a health snapshot and three lists of candidates that SQL rules have already pre-filtered. Your job: propose a concrete action plan grounded in the evidence. Be precise — the downstream system will execute your actions verbatim against production.

HEALTH SNAPSHOT
${JSON.stringify(health, null, 2)}

SPLIT CANDIDATES (trends the rules think are too broad — ${splitCandidates.length} shown)
${JSON.stringify(splitCandidates, null, 2)}

CATEGORY DRIFT CANDIDATES (trends whose categorization looks wrong/stale — ${driftCandidates.length} shown)
${JSON.stringify(driftCandidates, null, 2)}

STALLED QUEUE (enrichment queue rows stuck or failed — ${stalledQueue.length} shown)
${JSON.stringify(stalledQueue, null, 2)}

RULES OF ENGAGEMENT
1. For SPLIT candidates: look at cluster size, source count, heat, and average cohesion. If the trend genuinely spans multiple distinct consumer behaviors, return SPLIT. If the signals look coherent despite size, downgrade to FLAG_ONLY. The downstream split procedure is self-validating — if a SPLIT you recommend turns out to have only one coherent sub-community, it silently no-ops. So be willing to recommend SPLIT when unsure.
2. For CATEGORY_DRIFT candidates: return REQUEUE_FULL to force a fresh LLM enrichment pass (that's what fixes categorization). If the drift looks benign (e.g. a subcategory refinement), use FLAG_ONLY instead.
3. For STALLED_QUEUE rows: STATUS='IN_PROGRESS' with HOURS_STUCK >= 2 → UNSTALL_QUEUE. STATUS='FAILED' with RETRY_COUNT < 3 → also UNSTALL_QUEUE (flips it back to PENDING for the dispatcher to retry).
4. Only use these actions: ${ALLOWED_ACTIONS.join(", ")}. Anything else will be dropped by the guardrail.
5. Cap your plan at 20 actions total across all categories — we're on a budget.

RESPOND IN STRICT JSON ONLY, no prose wrapper:
{
  "health_assessment": "one short paragraph — current pipeline state and biggest concern",
  "action_plan": [
    {
      "trend_id": "uuid",
      "audit_type": "SPLIT_CANDIDATE" | "CATEGORY_DRIFT" | "STALLED_QUEUE",
      "action": "SPLIT" | "REQUEUE_FULL" | "REQUEUE_REFRESH" | "UNSTALL_QUEUE" | "FLAG_ONLY",
      "reason": "one sentence, grounded in the candidate evidence",
      "confidence": 0.0-1.0,
      "finding": { /* echo the key rule-level evidence you saw */ }
    }
  ]
}`;
}

export default defineComponent({
  name: "Audit: LLM plan",
  description: "Claude auditor — proposes action plan from rule-level candidates",
  version: "0.0.1",
  props: {
    anthropic: {
      type: "app",
      app: "anthropic",
    },
    budget_remaining_usd: { type: "string", label: "Budget remaining (USD)" },
    chain_id: { type: "string" },
    iteration: { type: "string" },
    dry_run: { type: "string" },
    health_rows: { type: "any", optional: true },
    split_candidates: { type: "any", optional: true },
    category_drift: { type: "any", optional: true },
    stalled_queue: { type: "any", optional: true },
  },
  async run() {
    const budget = Number(this.budget_remaining_usd || 0);
    const dryRun = String(this.dry_run) === "true";

    // snowflake-execute-sql-query returns the rows array directly as $return_value
    const healthRows = Array.isArray(this.health_rows) ? this.health_rows : [];
    const splitCandidates = Array.isArray(this.split_candidates) ? this.split_candidates : [];
    const driftCandidates = Array.isArray(this.category_drift) ? this.category_drift : [];
    const stalledQueue = Array.isArray(this.stalled_queue) ? this.stalled_queue : [];

    const totalCandidates =
      splitCandidates.length + driftCandidates.length + stalledQueue.length;

    if (budget < MIN_BUDGET_USD) {
      console.log(`budget exhausted ($${budget.toFixed(2)} < $${MIN_BUDGET_USD}), skipping LLM`);
      return emptyPlan("budget_exhausted");
    }
    if (totalCandidates === 0) {
      console.log("no candidates surfaced — nothing to plan");
      return emptyPlan("no_candidates", { health_assessment: "clean: no candidates surfaced" });
    }

    const prompt = buildPrompt(healthRows[0], splitCandidates, driftCandidates, stalledQueue);

    let data;
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.anthropic.$auth.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        }),
      });
      if (!resp.ok) throw new Error(`Claude HTTP ${resp.status}: ${await resp.text()}`);
      data = await resp.json();
    } catch (e) {
      console.log(`llm_plan error: ${e.message}`);
      return emptyPlan("llm_error", { error: e.message });
    }

    const text = data?.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log("llm_plan: no JSON in response");
      return emptyPlan("parse_error");
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.log(`llm_plan: JSON parse failed: ${e.message}`);
      return emptyPlan("parse_error");
    }

    const rawPlan = Array.isArray(parsed.action_plan) ? parsed.action_plan : [];

    // Guardrail: drop anything not in the allow-list or missing a trend_id
    const actions = rawPlan
      .filter(
        (a) =>
          a &&
          typeof a.trend_id === "string" &&
          ALLOWED_ACTIONS.includes(a.action),
      )
      .slice(0, 20);

    // Dry run: log the plan but send nothing to the action dispatcher.
    // We still return cost & tokens so the budget accounting is honest.
    const usage = data.usage || {};
    const tokensIn = usage.input_tokens || 0;
    const tokensOut = usage.output_tokens || 0;
    const cost =
      (tokensIn / 1_000_000) * RATES_PER_M.input +
      (tokensOut / 1_000_000) * RATES_PER_M.output;
    const costRounded = Math.round(cost * 10000) / 10000;

    console.log(
      `llm_plan: ${actions.length}/${rawPlan.length} actions kept (in=${tokensIn} out=${tokensOut} $${costRounded}) dry_run=${dryRun}`,
    );
    if (parsed.health_assessment) console.log(`  health: ${parsed.health_assessment.slice(0, 200)}`);

    // In dry_run mode, rewrite every proposed action to FLAG_ONLY so the
    // procedure still writes audit log rows (preserving reasoning/finding/
    // confidence) but performs no side effects. This makes dry_run useful
    // for "what would the agent do?" inspection.
    const effectiveActions = dryRun
      ? actions.map((a) => ({
          ...a,
          action: "FLAG_ONLY",
          finding: { ...(a.finding || {}), _dry_run_from: a.action },
        }))
      : actions;

    return {
      health_assessment: parsed.health_assessment || "",
      actions: effectiveActions,
      actions_json: JSON.stringify(effectiveActions),
      // proposed_actions preserves what the LLM originally returned pre-dry-run
      proposed_actions: actions,
      cost_usd: costRounded,
      tokens: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut },
      skipped: dryRun ? "dry_run" : null,
    };
  },
});
