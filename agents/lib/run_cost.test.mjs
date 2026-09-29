// Tests for the run-cost telemetry helper (CRMA-725).
// Run: scripts/test_agents_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RATES_PER_M,
  ratesFor,
  normalizeUsage,
  callCostUsd,
  collectCalls,
  deriveStatus,
  buildRunCostRows,
  RUN_COST_INSERT_SQL,
} from "./run_cost.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// --- model resolution -------------------------------------------------------

test("ratesFor: exact ids and dated/aliased snapshots resolve; unknown is null", () => {
  assert.equal(ratesFor("gemini-3.1-pro-preview"), RATES_PER_M["gemini-3.1-pro-preview"]);
  assert.equal(ratesFor("gpt-5-mini-2025-08-07"), RATES_PER_M["gpt-5-mini"]);
  assert.equal(ratesFor("claude-haiku-4-5-20251001"), RATES_PER_M["claude-haiku-4-5"]);
  assert.equal(ratesFor("grok-4-latest"), RATES_PER_M["grok-4"]);
  assert.equal(ratesFor("some-new-model"), null);
  assert.equal(ratesFor(null), null);
});

test("every model the six instrumented workflows call has a price", () => {
  // Live DIM_LLM_PROMPT models (2026-09-29) + the hardcoded MODEL constants.
  for (const m of [
    "gemini-2.5-flash", "grok-4-latest", "gpt-5-mini-2025-08-07", "claude-sonnet-4-6",
    "gemini-3.1-pro-preview", "claude-haiku-4-5-20251001",
  ]) assert.ok(ratesFor(m), `no price for ${m}`);
});

// --- usage normalization ----------------------------------------------------

test("gemini: thoughtsTokenCount is counted as thinking, on top of candidates (CRMA-781)", () => {
  // CRMA-729 capture: prompt + candidates + thoughts == total.
  const t = normalizeUsage("gemini", {
    promptTokenCount: 13, candidatesTokenCount: 8, thoughtsTokenCount: 140, totalTokenCount: 161,
  });
  assert.deepEqual(t, { input_tokens: 13, cached_input_tokens: 0, output_tokens: 8, thinking_tokens: 140 });
  assert.equal(t.input_tokens + t.output_tokens + t.thinking_tokens, 161);
});

test("gemini: tool-use prompt tokens are input; cached content is the cached subset", () => {
  const t = normalizeUsage("gemini", {
    promptTokenCount: 1000, toolUsePromptTokenCount: 500, cachedContentTokenCount: 400,
    candidatesTokenCount: 100,
  });
  assert.deepEqual(t, { input_tokens: 1500, cached_input_tokens: 400, output_tokens: 100, thinking_tokens: 0 });
});

test("anthropic: cache reads/writes fold into input; thinking not separable", () => {
  const t = normalizeUsage("anthropic", {
    input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 70,
  });
  assert.deepEqual(t, { input_tokens: 160, cached_input_tokens: 50, output_tokens: 70, thinking_tokens: 0 });
});

test("openai responses: reasoning is carved out of output_tokens (total reconciles)", () => {
  const t = normalizeUsage("openai", {
    input_tokens: 1000, input_tokens_details: { cached_tokens: 200 },
    output_tokens: 900, output_tokens_details: { reasoning_tokens: 600 }, total_tokens: 1900,
  });
  assert.deepEqual(t, { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, thinking_tokens: 600 });
});

test("xai responses: reasoning billed on top when total says so", () => {
  const t = normalizeUsage("xai", {
    input_tokens: 1000, output_tokens: 300, output_tokens_details: { reasoning_tokens: 600 }, total_tokens: 1900,
  });
  assert.deepEqual(t, { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 300, thinking_tokens: 600 });
});

test("missing / unknown usage reports zeros, never throws", () => {
  const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
  assert.deepEqual(normalizeUsage("gemini", undefined), zero);
  assert.deepEqual(normalizeUsage("openai", null), zero);
  assert.deepEqual(normalizeUsage("mystery", { foo: 1 }), zero);
});

// --- pricing ----------------------------------------------------------------

test("gemini 3.1 pro: thinking billed at output rate", () => {
  const cost = callCostUsd("gemini-3.1-pro-preview", {
    input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 500_000, thinking_tokens: 500_000,
  });
  close(cost, 0.2 + 12.0);
});

test("gemini 3.1 pro: >200k prompt switches the whole call to the long-context tier", () => {
  const t = { input_tokens: 250_000, cached_input_tokens: 0, output_tokens: 10_000, thinking_tokens: 0 };
  close(callCostUsd("gemini-3.1-pro-preview", t), (250_000 * 4 + 10_000 * 18) / 1e6);
  const u = { ...t, input_tokens: 200_000 };
  close(callCostUsd("gemini-3.1-pro-preview", u), (200_000 * 2 + 10_000 * 12) / 1e6);
});

test("cached input billed at the cached rate", () => {
  const cost = callCostUsd("gpt-5-mini-2025-08-07", {
    input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 0, thinking_tokens: 0,
  });
  close(cost, 0.6 * 0.25 + 0.4 * 0.025);
});

test("unknown model is unpriced (null), not free", () => {
  assert.equal(callCostUsd("mystery-1", { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, thinking_tokens: 0 }), null);
});

// --- collection + status ----------------------------------------------------

test("collectCalls: takes _llm_calls off step returns, skips junk and skipped steps", () => {
  const calls = collectCalls([
    { _llm_calls: [{ provider: "gemini", model: "gemini-2.5-flash", usage: {} }] },
    { proposals: [], skipped: true, _llm_calls: [] },
    undefined,
    { _llm_calls: [null, { provider: "x" }] },
    [{ provider: "anthropic", model: "claude-sonnet-4-6", usage: {} }],
  ]);
  assert.deepEqual(calls.map((c) => c.model), ["gemini-2.5-flash", "claude-sonnet-4-6"]);
});

test("deriveStatus: error wins, then budget, else OK", () => {
  assert.deepEqual(deriveStatus([{ stop_reason: "STOP" }, undefined]), { status: "OK", error_message: null });
  assert.deepEqual(deriveStatus([{ stop_reason: "budget_exhausted" }]), { status: "BUDGET_EXHAUSTED", error_message: null });
  assert.deepEqual(
    deriveStatus([{ stop_reason: "budget_exhausted" }, { error: "Gemini HTTP 500" }]),
    { status: "ERROR", error_message: "Gemini HTTP 500" },
  );
});

// --- rows -------------------------------------------------------------------

const BASE = {
  workflow_name: "discovery",
  run_id: "pd-2abcDEF",
  started_at: "2026-09-29T10:00:00.000Z",
  ended_at: "2026-09-29T10:00:05.500Z",
};

test("single-model run: one row, aggregated across calls, bare run_id", () => {
  const rows = buildRunCostRows({
    ...BASE,
    chain_id: "chain-1", agent_session_id: "sess-1",
    calls: [
      { provider: "gemini", model: "gemini-3.1-pro-preview", tool_calls: 2,
        usage: { promptTokenCount: 10_000, candidatesTokenCount: 100, thoughtsTokenCount: 900 } },
      { provider: "gemini", model: "gemini-3.1-pro-preview", tool_calls: 0,
        usage: { promptTokenCount: 12_000, candidatesTokenCount: 200, thoughtsTokenCount: 300 } },
    ],
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.run_id, "pd-2abcDEF");
  assert.equal(r.model, "gemini-3.1-pro-preview");
  assert.equal(r.input_tokens, 22_000);
  assert.equal(r.output_tokens, 300);
  assert.equal(r.thinking_tokens, 1200);
  assert.equal(r.turn_count, 2);
  assert.equal(r.tool_call_count, 2);
  assert.equal(r.duration_ms, 5500);
  assert.equal(r.status, "OK");
  close(r.cost_usd, (22_000 * 2 + 1500 * 12) / 1e6);
});

test("multi-model run (discovery): one row per model, suffixed run_ids, shared session", () => {
  const rows = buildRunCostRows({
    ...BASE,
    calls: [
      { provider: "xai", model: "grok-4-latest", usage: { input_tokens: 5000, output_tokens: 800, total_tokens: 5800 } },
      { provider: "xai", model: "grok-4-latest", usage: { input_tokens: 5000, output_tokens: 700, total_tokens: 5700 } },
      { provider: "anthropic", model: "claude-sonnet-4-6", usage: { input_tokens: 9000, output_tokens: 3000 } },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.run_id, r.model, r.turn_count]), [
    ["pd-2abcDEF-1", "grok-4-latest", 2],
    ["pd-2abcDEF-2", "claude-sonnet-4-6", 1],
  ]);
  close(rows[0].cost_usd, (10_000 * 3 + 1500 * 15) / 1e6);
  close(rows[1].cost_usd, (9000 * 3 + 3000 * 15) / 1e6);
});

test("no LLM call: one zero row with MODEL null (the ecomm-agent shape)", () => {
  const rows = buildRunCostRows({ ...BASE, calls: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, null);
  assert.equal(rows[0].cost_usd, 0);
  assert.equal(rows[0].turn_count, 0);
});

test("unpriced model yields null COST_USD but still records tokens", () => {
  const rows = buildRunCostRows({
    ...BASE,
    calls: [{ provider: "gemini", model: "gemini-9-ultra", usage: { promptTokenCount: 5, candidatesTokenCount: 5 } }],
  });
  assert.equal(rows[0].cost_usd, null);
  assert.equal(rows[0].input_tokens, 5);
});

test("values are capped to their column widths", () => {
  const long = "x".repeat(100);
  const [r] = buildRunCostRows({
    ...BASE, run_id: long, chain_id: long, agent_session_id: long, workflow_name: long,
    status: "ERROR", error_message: "e".repeat(5000),
  });
  for (const k of ["run_id", "chain_id", "agent_session_id", "workflow_name"]) assert.equal(r[k].length, 64);
  assert.equal(r.error_message.length, 2000);
});

test("insert SQL names every STG_AGENT_RUN_COSTS column once, bound by a single JSON param", () => {
  const cols = [
    "RUN_ID", "AGENT_SESSION_ID", "CHAIN_ID", "ITERATION", "WORKFLOW_NAME", "STARTED_AT", "ENDED_AT",
    "DURATION_MS", "MODEL", "INPUT_TOKENS", "INPUT_TOKENS_CACHED", "OUTPUT_TOKENS", "THINKING_TOKENS",
    "TOOL_CALL_COUNT", "TURN_COUNT", "COST_USD", "STATUS", "ERROR_MESSAGE",
  ];
  const header = RUN_COST_INSERT_SQL.slice(0, RUN_COST_INSERT_SQL.indexOf(")"));
  for (const c of cols) assert.match(header, new RegExp(`\\b${c}\\b`));
  assert.equal((RUN_COST_INSERT_SQL.match(/\?/g) || []).length, 1);
  // every row key buildRunCostRows emits is read by the SELECT
  const [row] = buildRunCostRows({ ...BASE, calls: [] });
  for (const k of Object.keys(row)) assert.match(RUN_COST_INSERT_SQL, new RegExp(`r\\.value:${k}::`), k);
});

// --- keep-in-sync guard ----------------------------------------------------
//
// Pipedream steps cannot import from agents/lib, so each instrumented
// workflow carries copies. They must not drift.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const stepDirs = readdirSync(REPO, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(REPO, d.name, "write_run_cost")))
  .map((d) => join(REPO, d.name, "write_run_cost"));

test("write_run_cost is wired into the instrumented workflows", () => {
  assert.ok(stepDirs.length >= 6, `expected >= 6 write_run_cost steps, found ${stepDirs.length}`);
});

test("every write_run_cost/run_cost.mjs is byte-identical to agents/lib/run_cost.mjs", () => {
  const canonical = readFileSync(join(HERE, "run_cost.mjs"), "utf8");
  for (const d of stepDirs) {
    assert.equal(readFileSync(join(d, "run_cost.mjs"), "utf8"), canonical, `${d}/run_cost.mjs drifted`);
  }
});

test("every write_run_cost/entry.mjs is byte-identical", () => {
  const [first, ...rest] = stepDirs.map((d) => [d, readFileSync(join(d, "entry.mjs"), "utf8")]);
  for (const [d, body] of rest) assert.equal(body, first[1], `${d}/entry.mjs differs from ${first[0]}`);
});
