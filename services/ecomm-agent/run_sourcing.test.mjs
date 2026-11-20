import { test } from "node:test";
import assert from "node:assert/strict";
import snowflake from "snowflake-sdk";
import { runSourcing } from "./run_sourcing.mjs";

const RUN_ID = "new-sourcing-run";
const missingHeader = (runId) =>
  `no running header found for sourcing_run_id ${runId} (already completed, or the id is wrong)`;

const request = {
  connOpts: {},
  apiKey: "unused",
  evt: { trend_id: "trend-1", tier: "shopify", agent_session_id: "session-1", chain_id: "chain-1" },
  ctx: { catalog_fresh: true, trend_found: true, pool: [] },
};

function stubSnowflake(t, { loseCompletionResponse = false, completionError = null, openError = null, costError = null } = {}) {
  const calls = { opens: [], completions: [], costs: [] };
  t.mock.method(snowflake, "createConnection", () => ({
    connect: (done) => done(null),
    destroy: (done) => done(null),
    execute({ sqlText, binds, complete }) {
      if (sqlText.includes("'open'")) {
        calls.opens.push(binds);
        if (openError) return complete(new Error(openError));
        complete(null, null, [{ receipt: { applied: true, sourcing_run_id: RUN_ID } }]);
      } else if (sqlText.includes("'complete'")) {
        calls.completions.push(binds);
        if (loseCompletionResponse && calls.completions.length === 1) {
          complete(new Error("socket disconnected after committing completion"));
          return;
        }
        const receipt = completionError ? { applied: false, error: completionError } : { applied: true };
        complete(null, null, [{ receipt }]);
      } else if (sqlText.includes("STG_AGENT_RUN_COSTS")) {
        calls.costs.push(binds);
        if (costError) return complete(new Error(costError));
        complete(null, null, []);
      } else {
        assert.fail(`Unexpected SQL: ${sqlText}`);
      }
    },
  }));
  return calls;
}

test("a lost completion response followed by a no-running-header receipt remains successful", async (t) => {
  const calls = stubSnowflake(t, { loseCompletionResponse: true, completionError: missingHeader(RUN_ID) });

  const result = await runSourcing(request);

  assert.equal(result.decision, "completed");
  assert.equal(result.header_recorded, true);
  assert.equal(result.outcome, "no_match");
  assert.equal(result.error_message, null);
  assert.equal(calls.completions.length, 2);
  assert.deepEqual(calls.completions[1], calls.completions[0]);
  assert.equal(calls.costs.length, 1);
  assert.equal(calls.costs[0].at(-2), "OK");
});

for (const completionError of ["invalid completion payload", missingHeader("different-run")]) {
  test(`completion rejection remains a failure: ${completionError}`, async (t) => {
    const calls = stubSnowflake(t, { completionError });

    const result = await runSourcing(request);

    assert.equal(result.decision, "failed");
    assert.equal(result.header_recorded, false);
    assert.ok(result.error_message.includes(completionError));
    assert.equal(calls.completions.length, 2);
    assert.equal(calls.completions[1][1], "failed");
    assert.equal(calls.costs.length, 1);
    assert.equal(calls.costs[0].at(-2), "ERROR");
  });
}

const product = { catalog_product_id: "mug", semantic_score: 0.8, product_title: "Travel mug" };
const selectorRequest = {
  ...request,
  ctx: {
    ...request.ctx,
    pool: [product, { catalog_product_id: "weak", semantic_score: 0.2 }],
    trend: { trend_name: "Coffee on the go" },
    prompt: { template: "Choose products" },
  },
};
const telemetry = {
  tokens: { input: 120, output: 30, thinking: 7 },
  tool_calls: [{ name: "propose_product_selection" }],
  turns: 1,
  cost_usd: 0.002,
  stop_reason: "tool_call",
};
const mustNotSelect = () => assert.fail("selector must not run");

test("stale catalog declines without opening a header, selecting, or recording cost", async (t) => {
  const calls = stubSnowflake(t);
  const result = await runSourcing({
    ...request,
    ctx: { ...request.ctx, catalog_fresh: false, decline_reason: "stale", catalog_age_days: 8 },
  }, { select: mustNotSelect });

  assert.deepEqual(result, {
    decision: "declined", header_recorded: false, trend_id: "trend-1", tier: "shopify",
    reason: "stale", catalog_age_days: 8,
  });
  assert.deepEqual(calls, { opens: [], completions: [], costs: [] });
});

test("an empty filtered pool records no_match without calling the selector", async (t) => {
  const calls = stubSnowflake(t);
  const result = await runSourcing({
    ...request, ctx: { ...request.ctx, pool: [{ ...product, semantic_score: 0.39 }] },
  }, { select: mustNotSelect });

  assert.equal(result.outcome, "no_match");
  assert.equal(result.header_recorded, true);
  assert.equal(result.selector_telemetry, null);
  assert.equal(calls.opens.length, 1);
  assert.deepEqual(calls.opens[0].slice(0, 3), ["trend-1", "shopify", 0.4]);
  assert.equal(calls.completions.length, 1);
  assert.equal(calls.completions[0][1], "no_match");
  assert.deepEqual(JSON.parse(calls.completions[0][4]), []);
  assert.equal(calls.costs.length, 1);
  assert.deepEqual(calls.costs[0].slice(6), [null, 0, 0, 0, 0, 0, 0, "OK", null]);
});

test("matched selection persists the filtered pool and selector telemetry", async (t) => {
  const calls = stubSnowflake(t);
  const select = t.mock.fn(async (args) => {
    assert.equal(args.apiKey, request.apiKey);
    assert.deepEqual(args.prompt, selectorRequest.ctx.prompt);
    assert.deepEqual(args.trend, selectorRequest.ctx.trend);
    assert.deepEqual(args.pool, [product]);
    assert.equal(calls.opens.length, 1);
    return {
      emit: { outcome: "matched", picks: [{ catalog_product_id: "mug", reasoned_fit: "strong", rationale: "Keeps coffee warm." }], pool_note: "One fit" },
      telemetry,
    };
  });
  const result = await runSourcing(selectorRequest, { select });

  assert.equal(select.mock.callCount(), 1);
  assert.equal(result.decision, "completed");
  assert.equal(result.outcome, "matched");
  assert.equal(result.header_recorded, true);
  assert.equal(calls.completions.length, 1);
  assert.equal(calls.completions[0][0], RUN_ID);
  assert.equal(calls.completions[0][1], "matched");
  const persisted = JSON.parse(calls.completions[0][4]);
  assert.deepEqual(persisted, result.candidates);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].catalog_product_id, "mug");
  assert.equal(persisted[0].selected, true);
  assert.equal(persisted[0].reasoned_fit_rationale, "Keeps coffee warm.");
  assert.equal(calls.costs.length, 1);
  assert.deepEqual(calls.costs[0].slice(7), [120, 23, 7, 1, 1, 0.002, "OK", null]);
  assert.equal(calls.costs[0][6], result.selector_telemetry.model);
  assert.deepEqual(calls.costs[0].slice(1, 3), ["session-1", "chain-1"]);
  assert.ok(calls.costs[0][5] >= 0);
});

for (const [name, emit, stopReason, outcome, costStatus] of [
  ["selector no_match", { outcome: "no_match", picks: [], pool_note: "No fit" }, "tool_call", "no_match", "OK"],
  ["missing emission", null, "max_iterations", "failed", "ERROR"],
  ["invalid picks", { outcome: "matched", picks: [{ catalog_product_id: "invented", reasoned_fit: "strong" }] }, "tool_call", "failed", "ERROR"],
  ["budget exhaustion", null, "budget_exhausted", "failed", "BUDGET_EXHAUSTED"],
]) {
  test(`${name} records ${outcome} with ${costStatus} cost status`, async (t) => {
    const calls = stubSnowflake(t);
    const result = await runSourcing(selectorRequest, {
      select: async () => ({ emit, telemetry: { ...telemetry, stop_reason: stopReason } }),
    });

    assert.equal(result.decision, "completed");
    assert.equal(result.header_recorded, true);
    assert.equal(result.outcome, outcome);
    assert.equal(calls.completions.length, 1);
    assert.equal(calls.completions[0][1], outcome);
    assert.equal(calls.costs.length, 1);
    assert.equal(calls.costs[0].at(-2), costStatus);
    assert.equal(calls.costs[0].at(-1), result.error_message);
  });
}

test("missing enrichment records a failed header and ERROR cost without selecting", async (t) => {
  const calls = stubSnowflake(t);
  const result = await runSourcing({ ...request, ctx: { ...request.ctx, trend_found: false } }, { select: mustNotSelect });

  assert.equal(result.decision, "completed");
  assert.equal(result.outcome, "failed");
  assert.equal(result.header_recorded, true);
  assert.equal(calls.completions[0][1], "failed");
  assert.equal(calls.costs[0].at(-2), "ERROR");
});

for (const completionError of [null, "completion unavailable"]) {
  test(`selector failure after open still attempts completion and cost: ${completionError ?? "recorded"}`, async (t) => {
    const calls = stubSnowflake(t, { completionError });
    const result = await runSourcing(selectorRequest, { select: async () => { throw new Error("selector unavailable"); } });

    assert.equal(result.decision, "failed");
    assert.equal(result.header_recorded, completionError === null);
    assert.equal(result.error_message, "selector unavailable");
    assert.equal(calls.completions.length, 1);
    assert.deepEqual(calls.completions[0], [RUN_ID, "failed", "selector unavailable", null, "[]"]);
    assert.equal(calls.costs.length, 1);
    assert.equal(calls.costs[0].at(-2), "ERROR");
  });
}

test("lost open response is not retried and cannot complete an unknown header", async (t) => {
  const calls = stubSnowflake(t, { openError: "socket disconnected after open" });
  const result = await runSourcing(selectorRequest, { select: mustNotSelect });

  assert.equal(result.decision, "failed");
  assert.equal(result.header_recorded, false);
  assert.equal(result.sourcing_run_id, null);
  assert.equal(calls.opens.length, 1);
  assert.equal(calls.completions.length, 0);
  assert.equal(calls.costs.length, 1);
  assert.equal(calls.costs[0].at(-2), "ERROR");
});

for (const selectorFails of [false, true]) {
  test(`lost cost response is not retried or allowed to change the ${selectorFails ? "failed" : "completed"} outcome`, async (t) => {
    const calls = stubSnowflake(t, { costError: "socket disconnected after cost insert" });
    const result = await runSourcing(selectorFails ? selectorRequest : request, {
      select: async () => { throw new Error("selector unavailable"); },
    });

    assert.equal(result.decision, selectorFails ? "failed" : "completed");
    assert.equal(result.outcome, selectorFails ? "failed" : "no_match");
    assert.equal(result.header_recorded, true);
    assert.match(result.cost_row_error, /socket disconnected after cost insert/);
    assert.equal(calls.completions.length, 1);
    assert.equal(calls.costs.length, 1);
  });
}
