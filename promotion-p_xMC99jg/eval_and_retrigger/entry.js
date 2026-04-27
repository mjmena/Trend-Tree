// Promotion Lead — eval_and_retrigger
//
// Terminal step. Decides whether another pass is warranted and, if so,
// fire-and-forget POSTs back to this workflow's own HTTP endpoint with
// iteration + 1.
//
// The loop terminates on any of:
//   - iteration >= max_iterations            (hard stop)
//   - budget_remaining_usd < $0.10           (hard stop)
//   - apply_result.applied_count === 0       (nothing to do → converged)
//   - dry_run === true                       (never loops)
//
// Self-POST URL is wired in workflow.yaml as the `self_url` prop so the
// endpoint is visible alongside the rest of the step config (instead of
// hidden in an env var).

const MIN_BUDGET_USD = 0.10;

export default defineComponent({
  name: "Promotion: eval & retrigger",
  description: "Decide whether to self-loop, fire-and-forget the next iteration",
  version: "0.0.1",
  props: {
    chain_id: { type: "string" },
    iteration: { type: "string" },
    max_iterations: { type: "string" },
    budget_usd: { type: "string" },
    budget_remaining_usd: { type: "string" },
    dry_run: { type: "string" },
    max_candidates: { type: "string", optional: true },
    self_url: { type: "string", label: "This workflow's HTTP endpoint URL (for self-retrigger)" },
    lead_result: { type: "any", optional: true },
    apply_result: { type: "any", optional: true },
  },
  async run({ $ }) {
    const chain_id = this.chain_id;
    const iteration = Number(this.iteration || 1);
    const max_iterations = Number(this.max_iterations || 2);
    const budget_usd = Number(this.budget_usd || 0);
    const budget_remaining_usd = Number(this.budget_remaining_usd || 0);
    const dry_run = String(this.dry_run) === "true";

    const lead = this.lead_result || {};
    const leadCost = Number(lead.cost_usd || 0);
    const newBudget = Math.max(0, budget_remaining_usd - leadCost);

    // apply_promotion returns the rows from CALL PROC_PROMOTION_APPLY(...).
    // Defensive parsing: column name is the procedure name, value may be a
    // JSON string or already-parsed object.
    let appliedCount = 0;
    let promoteCount = 0;
    let mergeCount = 0;
    let rejectCount = 0;
    let deferCount = 0;
    let errorCount = 0;
    let applyResultParsed = null;
    const raw = this.apply_result;
    try {
      let row = null;
      if (Array.isArray(raw) && raw.length > 0) row = raw[0];
      else if (raw && typeof raw === "object") row = raw;
      if (row) {
        const value =
          row.PROC_PROMOTION_APPLY ??
          row.proc_promotion_apply ??
          Object.values(row)[0];
        applyResultParsed = typeof value === "string" ? JSON.parse(value) : value;
        if (applyResultParsed && typeof applyResultParsed === "object") {
          appliedCount = Number(applyResultParsed.applied_count || 0);
          promoteCount = Number(applyResultParsed.promote_count || 0);
          mergeCount = Number(applyResultParsed.merge_count || 0);
          rejectCount = Number(applyResultParsed.reject_count || 0);
          deferCount = Number(applyResultParsed.defer_count || 0);
          errorCount = Number(applyResultParsed.error_count || 0);
        }
      }
    } catch (e) {
      console.log(`eval: could not parse apply_result: ${e.message}`);
    }

    const reasons = [];
    if (dry_run) reasons.push("dry_run");
    if (iteration >= max_iterations) reasons.push(`max_iterations reached (${iteration}/${max_iterations})`);
    if (newBudget < MIN_BUDGET_USD) reasons.push(`budget exhausted ($${newBudget.toFixed(2)} < $${MIN_BUDGET_USD})`);
    if (appliedCount === 0) reasons.push("no decisions applied this pass (converged)");

    const shouldLoop = reasons.length === 0;

    console.log(
      `\n=== Promotion iteration ${iteration}/${max_iterations} for chain ${chain_id} ===`,
    );
    console.log(`  lead: cost=$${leadCost.toFixed(4)} budget_remaining=$${newBudget.toFixed(2)}`);
    console.log(`  applied: total=${appliedCount} promote=${promoteCount} merge=${mergeCount} reject=${rejectCount} defer=${deferCount} errors=${errorCount}`);
    console.log(`  shouldLoop=${shouldLoop}${reasons.length ? ` (${reasons.join("; ")})` : ""}`);

    $.export(
      "$summary",
      `iter ${iteration}/${max_iterations} — applied ${appliedCount} (${promoteCount}P/${mergeCount}M/${rejectCount}R/${deferCount}D), ${shouldLoop ? "looping" : `stopping: ${reasons.join("; ")}`}`,
    );

    if (!shouldLoop) {
      return {
        looped: false,
        stop_reasons: reasons,
        iteration,
        applied_count: appliedCount,
        budget_remaining_usd: newBudget,
        lead_cost_usd: leadCost,
        apply_result: applyResultParsed,
      };
    }

    const selfUrl = this.self_url;
    if (!selfUrl || selfUrl.includes("PLACEHOLDER")) {
      console.log(
        `self-retrigger: self_url prop is not configured (got '${selfUrl}') — aborting loop`,
      );
      return {
        looped: false,
        stop_reasons: ["self_url_not_configured"],
        iteration,
        applied_count: appliedCount,
        budget_remaining_usd: newBudget,
        lead_cost_usd: leadCost,
        apply_result: applyResultParsed,
      };
    }

    const nextPayload = {
      chain_id,
      iteration: iteration + 1,
      max_iterations,
      budget_usd,
      budget_remaining_usd: newBudget,
      dry_run: false,
      max_candidates: Number(this.max_candidates) || undefined,
    };

    try {
      // Fire-and-forget — don't await the response
      fetch(selfUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextPayload),
        signal: AbortSignal.timeout(5000),
      }).catch((e) => console.log(`self-retrigger send failed: ${e.message}`));
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      console.log(`self-retrigger scheduling failed: ${e.message}`);
    }

    return {
      looped: true,
      next_iteration: iteration + 1,
      budget_remaining_usd: newBudget,
      applied_count: appliedCount,
      lead_cost_usd: leadCost,
      apply_result: applyResultParsed,
    };
  },
});
