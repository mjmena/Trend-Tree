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

function stubSnowflake(t, { loseCompletionResponse = false, completionError = null } = {}) {
  const calls = { completions: [], costs: [] };
  t.mock.method(snowflake, "createConnection", () => ({
    connect: (done) => done(null),
    destroy: (done) => done(null),
    execute({ sqlText, binds, complete }) {
      if (sqlText.includes("'open'")) {
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
