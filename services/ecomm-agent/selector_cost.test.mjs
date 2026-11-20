import { test } from "node:test";
import assert from "node:assert/strict";
import snowflake from "snowflake-sdk";
import { selectorRatesPerM } from "./selector.mjs";
import { runSourcing } from "./run_sourcing.mjs";

test("selector uses the published rates on both sides of the introductory pricing boundary", () => {
  assert.deepEqual(selectorRatesPerM(new Date("2026-12-31T23:59:59Z")), { input: 0.75, output: 3.75 });
  assert.deepEqual(selectorRatesPerM(new Date("2027-01-01T00:00:00Z")), { input: 1.50, output: 7.50 });
});

test("a sourcing run writes reconciled output, thinking and cost to the telemetry table", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-19T12:00:00Z") });
  let cost;
  t.mock.method(snowflake, "createConnection", () => ({
    connect: (done) => done(null), destroy: (done) => done(null),
    execute({ sqlText, binds, complete }) {
      if (sqlText.includes("'open'")) {
        complete(null, null, [{ receipt: { applied: true, sourcing_run_id: "run-1" } }]);
      } else if (sqlText.includes("'complete'")) {
        complete(null, null, [{ receipt: { applied: true } }]);
      } else if (sqlText.includes("STG_AGENT_RUN_COSTS")) {
        const columns = sqlText.match(/STG_AGENT_RUN_COSTS\s*\(([^)]+)\)/)[1].split(",").map((s) => s.trim());
        const values = sqlText.match(/VALUES\s*\(([^)]+)\)/)[1].split(",").map((s) => s.trim());
        let bindIndex = 0;
        cost = Object.fromEntries(columns.map((col, i) => [col, values[i] === "?" ? binds[bindIndex++] : values[i]]));
        assert.equal(bindIndex, binds.length);
        complete(null, null, []);
      } else {
        assert.fail(`Unexpected SQL: ${sqlText}`);
      }
    },
  }));
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      usageMetadata: { promptTokenCount: 3375, candidatesTokenCount: 830, thoughtsTokenCount: 1745, totalTokenCount: 5950 },
      candidates: [{ content: { parts: [{ functionCall: {
        name: "propose_product_selection", args: { outcome: "no_match", picks: [], pool_note: "No product fits." },
      } }] } }],
    }),
  }));
  const result = await runSourcing({
    connOpts: {}, apiKey: "unused",
    evt: { trend_id: "trend-1", tier: "shopify", agent_session_id: "session-1", chain_id: "chain-1" },
    ctx: {
      catalog_fresh: true, trend_found: true, trend: {}, prompt: { template: "Select products." },
      pool: [{ catalog_product_id: "product-1", embed_doc: "Product", semantic_score: 0.7 }],
    },
  });
  assert.equal(result.decision, "completed");
  assert.equal(cost.INPUT_TOKENS, 3375);
  assert.equal(cost.OUTPUT_TOKENS, 830);
  assert.equal(cost.THINKING_TOKENS, 1745);
  assert.equal(cost.INPUT_TOKENS + cost.OUTPUT_TOKENS + cost.THINKING_TOKENS, 5950);
  assert.equal(cost.COST_USD, Math.round((3375 * 0.75 + (5950 - 3375) * 3.75) / 100) / 10000);
});
