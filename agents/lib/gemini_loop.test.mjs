import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const loopPaths = [
  "agents/lib/gemini_loop.mjs",
  "services/lib/gemini_loop.mjs",
  "enrichment-p_xMC995w/run_enrichment_agent/entry.js",
  "promotion-agent-p_yKCmm9r/run_subagent/entry.js",
  "distillation-subagent-p_jmCjj3J/run_subagent/entry.js",
  "distillation-cluster-agent-p_YyC89Ke/run_lead_agent/entry.js",
  "audit-agent-p_xMC9nm3/run_audit_agent/entry.mjs",
];

function loadLoop(path, responses) {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
    .replace(/^import .*;$/gm, "")
    .replace("export default defineComponent(", "defineComponent(")
    .replace(/^export /gm, "");
  let calls = 0;
  const sandbox = {
    defineComponent() {}, AbortController, clearTimeout,
    setTimeout: (...args) => setTimeout(...args).unref(),
    async fetch() {
      assert.ok(calls < responses.length, "unexpected extra Gemini call");
      return { ok: true, json: async () => responses[calls++] };
    },
  };
  // Keep the deployed loop intact; isolate only schema lookup and tool side effects.
  runInNewContext(`${source}\n` +
    `toFunctionDeclarations = () => [];\n` +
    `dispatchTool = async () => ({ accepted: true });\n` +
    `this.runLoop = runAgentLoop;`, sandbox);
  return {
    run: (overrides = {}) => sandbox.runLoop({
      api_key: "unused", google_gemini: { $auth: { api_key: "unused" } },
      tool_names: ["lookup"], all_schemas: {}, system: "test", user_message: "test",
      context: {}, dispatchTool: async () => ({ accepted: true }), ...overrides,
    }),
    calls: () => calls,
  };
}

function response(usageMetadata, tool = false) {
  return {
    usageMetadata,
    candidates: [{ content: { parts: tool
      ? [{ functionCall: { name: "lookup", args: {} } }]
      : [{ text: "Done" }],
    }, finishReason: "STOP" }],
  };
}

for (const path of loopPaths) {
  test(`${path}: billed output reconciles with provider totals across turns`, async () => {
    const usage = [
      { promptTokenCount: 3375, candidatesTokenCount: 830, thoughtsTokenCount: 1745, totalTokenCount: 5950 },
      { promptTokenCount: 3375, candidatesTokenCount: 823, thoughtsTokenCount: 2355, totalTokenCount: 6553 },
    ];
    const loop = loadLoop(path, usage.map((u, i) => response(u, i === 0)));
    const result = await loop.run();
    const total = usage.reduce((sum, u) => sum + u.totalTokenCount, 0);
    const input = usage.reduce((sum, u) => sum + u.promptTokenCount, 0);
    assert.equal(result.tokens.output, total - input);
    assert.equal(result.tokens.total, total);
    assert.equal(result.tokens.thinking, 4100);
    assert.equal(result.cost_usd, Math.round((input * 2 + (total - input) * 12) / 100) / 10000);
    assert.equal(loop.calls(), 2);
  });

  test(`${path}: thinking spend stops the next paid turn at the budget`, async () => {
    const loop = loadLoop(path, [response({
      promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 1000, totalTokenCount: 1110,
    }, true)]);
    const result = await loop.run({ budget_usd: 0.01 });
    assert.equal(result.stop_reason, "budget_exhausted");
    assert.equal(loop.calls(), 1);
  });

  test(`${path}: missing usage fields default to zero`, async () => {
    for (const usage of [undefined, {}, { promptTokenCount: 100, candidatesTokenCount: 20 }]) {
      const result = await loadLoop(path, [response(usage)]).run();
      assert.equal(result.tokens.thinking, 0);
      assert.equal(result.tokens.output, usage?.candidatesTokenCount || 0);
      assert.equal(result.tokens.total, (usage?.promptTokenCount || 0) + (usage?.candidatesTokenCount || 0));
      assert.ok(Number.isFinite(result.cost_usd));
    }
  });
}
