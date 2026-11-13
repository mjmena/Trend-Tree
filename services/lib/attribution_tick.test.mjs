// The attribution tick over a fake Snowflake and a fake Gemini batch client.
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTick } from "./attribution_tick.mjs";
import { SET_QUERIES } from "./attribution_context.mjs";

const PROMPT_ROWS = [
  { PROMPT_KEY: "signal.attribution.job.system", VERSION: 1, TEMPLATE: "SYS\n{{trend_block}}\n{{candidate_signals_block}}\n{{attribution_rubric}}", MODEL_PARAMS: { per_call_max_tokens: 8192, thinking_level: "low" } },
  { PROMPT_KEY: "signal.attribution.rubric", VERSION: 3, TEMPLATE: "RUBRIC", MODEL_PARAMS: {} },
];

// pools: {trend_id: [signal_id, ...]}; a trend missing from it has an empty pool.
function fakeSnowflake({ eligible = [], pools = {}, prompts = PROMPT_ROWS } = {}) {
  const db = { eligible, pools, batches: [], links: [], costs: [], clock: 0 };
  const query = async (sql, binds = []) => {
    db.clock++;
    if (/DIM_LLM_PROMPT/.test(sql)) return prompts;
    if (sql === SET_QUERIES.trend_context) {
      return JSON.parse(binds[0]).map((id) => ({ TREND_ID: id, TREND_TOPIC: `topic ${id}`, PROMOTED_AT: "2026-06-28T10:14:47.125000" }));
    }
    if (sql === SET_QUERIES.existing_source_types) return [];
    if (sql === SET_QUERIES.candidate_signals) {
      return JSON.parse(binds[0]).flatMap((id) => (db.pools[id] || []).map((s) => ({ TREND_ID: id, SIGNAL_ID: s, SIMILARITY: 0.5 })));
    }
    if (/LAST_SWEPT_AT/.test(sql)) {
      const last = (id) => Math.max(-1, ...db.batches.filter((b) => b.STATE === "COLLECTED" && b.TREND_IDS.includes(id)).map((b) => b.SUBMITTED_AT));
      const order = [...db.eligible].sort((a, b) => last(a) - last(b));
      return order.slice(0, Number(sql.match(/LIMIT (\d+)/)[1])).map((id) => ({ TREND_ID: id, OVERDUE: last(id) < 0 }));
    }
    if (/^INSERT INTO \S+STG_ATTRIBUTION_BATCHES/.test(sql)) {
      db.batches.push({ BATCH_NAME: binds[0], CHAIN_ID: binds[1], TREND_IDS: JSON.parse(binds[2]), POOLS: binds[3], BUDGET_EXHAUSTED: binds[4], STATE: binds[5], SUBMITTED_AT: db.clock, AGE_S: 0 });
      return [];
    }
    if (/^UPDATE \S+STG_ATTRIBUTION_BATCHES/.test(sql)) {
      db.batches.find((b) => b.BATCH_NAME === binds[1]).STATE = binds[0];
      return [];
    }
    if (/^SELECT .* FROM \S+STG_ATTRIBUTION_BATCHES/s.test(sql)) return db.batches.filter((b) => b.STATE === "SUBMITTED").slice(-1);
    if (/^INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS/.test(sql)) {
      for (const l of JSON.parse(binds[0])) {
        if (!db.links.some((x) => x.trend_id === l.trend_id && x.signal_id === l.signal_id)) db.links.push(l);
      }
      return [];
    }
    if (/STG_AGENT_RUN_COSTS/.test(sql)) {
      const [model, input, output, thinking, turns, cost, status, error, runId] = binds;
      if (!db.costs.some((c) => c.RUN_ID === runId)) db.costs.push({ RUN_ID: runId, MODEL: model, INPUT_TOKENS: input, OUTPUT_TOKENS: output, THINKING_TOKENS: thinking, TURN_COUNT: turns, COST_USD: cost, STATUS: status, ERROR_MESSAGE: error });
      return [];
    }
    throw new Error(`fake Snowflake: unexpected statement ${sql.slice(0, 80)}`);
  };
  return { db, query };
}

const answer = (list, usage = { promptTokenCount: 1000, candidatesTokenCount: 10, thoughtsTokenCount: 100 }) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ attributions: list }) }] } }],
  usageMetadata: usage,
});

function fakeGemini() {
  const g = { submitted: [], state: "BATCH_STATE_RUNNING", entries: [], cancelled: [], retries: [], retryAnswer: answer([]) };
  return {
    g,
    async submitBatch({ model, requests }) {
      g.submitted.push({ model, requests });
      return { name: `batches/${g.submitted.length}` };
    },
    async getBatch() { return { state: g.state, entries: g.entries }; },
    async cancelBatch(name) { g.cancelled.push(name); },
    async generateContent({ request }) { g.retries.push(request); return g.retryAnswer; },
  };
}

test("first tick submits the cap, least recently swept first; empty pools are swept without a request", async () => {
  const { db, query } = fakeSnowflake({ eligible: ["a", "b", "c"], pools: { a: ["s1"], c: ["s3"] } });
  const gemini = fakeGemini();
  const out = await runTick({ query, gemini, cap: 2 });
  assert.deepEqual(db.batches[0].TREND_IDS, ["a", "b"]);
  assert.equal(gemini.g.submitted[0].requests.length, 1);
  assert.equal(gemini.g.submitted[0].requests[0].metadata.key, "a");
  assert.equal(out.submitted.budget_exhausted, true);
  assert.equal(db.batches[0].STATE, "SUBMITTED");
});

test("a running batch under 6 h blocks the submit", async () => {
  const { db, query } = fakeSnowflake({ eligible: ["a"], pools: { a: ["s1"] } });
  const gemini = fakeGemini();
  await runTick({ query, gemini });
  const out = await runTick({ query, gemini });
  assert.equal(out.waiting, "batches/1");
  assert.equal(db.batches.length, 1);
});

test("collect links in-pool answers, drops the rest, writes one cost row, then submits the next trends", async () => {
  const { db, query } = fakeSnowflake({ eligible: ["a", "b", "c"], pools: { a: ["s1", "s2"], b: ["s9"], c: ["s3"] } });
  const gemini = fakeGemini();
  await runTick({ query, gemini, cap: 2 });
  gemini.g.state = "BATCH_STATE_SUCCEEDED";
  gemini.g.entries = [
    { metadata: { key: "a" }, response: answer([{ signal_id: "s1", link_type: "news" }, { signal_id: "zz", link_type: "news" }]) },
    { metadata: { key: "b" }, response: answer([]) },
  ];
  const out = await runTick({ query, gemini, cap: 2 });
  assert.deepEqual(db.links, [{ trend_id: "a", signal_id: "s1", link_type: "news" }]);
  assert.equal(out.collected.dropped, 1);
  assert.equal(db.batches[0].STATE, "COLLECTED");
  assert.equal(db.costs.length, 1);
  assert.equal(db.costs[0].STATUS, "BUDGET_EXHAUSTED");
  assert.equal(db.costs[0].TURN_COUNT, 2);
  assert.match(db.costs[0].ERROR_MESSAGE, /1 attribution\(s\) dropped/);
  assert.doesNotMatch(db.costs[0].ERROR_MESSAGE, /no batch entry/);
  // c was never swept, so it leads the next batch.
  assert.equal(db.batches[1].TREND_IDS[0], "c");
});

test("a non-JSON entry gets one standard retry from the stored pool", async () => {
  const { db, query } = fakeSnowflake({ eligible: ["a"], pools: { a: ["s1"] } });
  const gemini = fakeGemini();
  await runTick({ query, gemini });
  db.pools.a = ["other"]; // the live pool moved on; the retry must use the stored one
  gemini.g.state = "BATCH_STATE_SUCCEEDED";
  gemini.g.entries = [{ metadata: { key: "a" }, response: { candidates: [{ content: { parts: [{ text: "oops" }] } }] } }];
  gemini.g.retryAnswer = answer([{ signal_id: "s1", link_type: "social" }]);
  const out = await runTick({ query, gemini, cap: 0 });
  assert.equal(gemini.g.retries.length, 1);
  assert.match(gemini.g.retries[0].systemInstruction.parts[0].text, /\[s1\]/);
  assert.deepEqual(db.links, [{ trend_id: "a", signal_id: "s1", link_type: "social" }]);
  assert.equal(out.collected.retries, 1);
});

test("a requested trend missing from the results is named in ERROR_MESSAGE", async () => {
  const { db, query } = fakeSnowflake({ eligible: ["a", "b"], pools: { a: ["s1"], b: ["s2"] } });
  const gemini = fakeGemini();
  await runTick({ query, gemini, cap: 2 });
  gemini.g.state = "BATCH_STATE_SUCCEEDED";
  gemini.g.entries = [{ metadata: { key: "a" }, response: answer([]) }];
  await runTick({ query, gemini, cap: 0 });
  assert.match(db.costs[0].ERROR_MESSAGE, /no batch entry for b/);
});

test("a collect run twice links nothing twice", async () => {
  const { db, query } = fakeSnowflake({ eligible: ["a"], pools: { a: ["s1"] } });
  const gemini = fakeGemini();
  await runTick({ query, gemini });
  gemini.g.state = "BATCH_STATE_SUCCEEDED";
  gemini.g.entries = [{ metadata: { key: "a" }, response: answer([{ signal_id: "s1", link_type: "news" }]) }];
  await runTick({ query, gemini, cap: 0 });
  db.batches[0].STATE = "SUBMITTED"; // a crash before the state update
  await runTick({ query, gemini, cap: 0 });
  assert.equal(db.links.length, 1);
  assert.equal(db.costs.length, 1);
});

test("FAILED and EXPIRED close the batch with ERROR; the trends go first next tick", async () => {
  for (const state of ["BATCH_STATE_FAILED", "BATCH_STATE_EXPIRED"]) {
    const { db, query } = fakeSnowflake({ eligible: ["a", "b"], pools: { a: ["s1"], b: ["s2"] } });
    const gemini = fakeGemini();
    await runTick({ query, gemini, cap: 1 });
    gemini.g.state = state;
    await runTick({ query, gemini, cap: 1 });
    assert.equal(db.batches[0].STATE, "FAILED");
    assert.equal(db.costs[0].STATUS, "ERROR");
    assert.deepEqual(db.batches[1].TREND_IDS, ["a"]);
  }
});

test("a batch pending 6 h is cancelled with TIMEOUT; an all-cancelled SUCCEEDED batch closes the same way", async () => {
  const { db, query } = fakeSnowflake({ eligible: ["a"], pools: { a: ["s1"] } });
  const gemini = fakeGemini();
  await runTick({ query, gemini });
  db.batches[0].AGE_S = 6 * 3600;
  gemini.g.state = "BATCH_STATE_PENDING";
  await runTick({ query, gemini });
  assert.deepEqual(gemini.g.cancelled, ["batches/1"]);
  assert.equal(db.batches[0].STATE, "CANCELLED");
  assert.equal(db.costs[0].STATUS, "TIMEOUT");

  gemini.g.state = "BATCH_STATE_SUCCEEDED";
  gemini.g.entries = [{ metadata: { key: "a" }, error: { code: 1 } }];
  await runTick({ query, gemini, cap: 0 });
  assert.equal(db.batches[1].STATE, "CANCELLED");
  assert.equal(gemini.g.cancelled.length, 1);
});

test("an all-empty-pool selection submits nothing and records the sweep", async () => {
  const { db, query } = fakeSnowflake({ eligible: ["a", "b"] });
  const gemini = fakeGemini();
  const out = await runTick({ query, gemini, cap: 5 });
  assert.equal(gemini.g.submitted.length, 0);
  assert.match(out.submitted.batch, /^none-atr-chain-/);
  assert.equal(db.batches[0].STATE, "COLLECTED");
  assert.equal(db.costs.length, 0);
});

test("the tick refuses a prompt under 8192 output tokens or with tool wording", async () => {
  const low = [{ ...PROMPT_ROWS[0], MODEL_PARAMS: { per_call_max_tokens: 2048 } }, PROMPT_ROWS[1]];
  await assert.rejects(runTick({ query: fakeSnowflake({ prompts: low }).query, gemini: fakeGemini() }), /below 8192/);
  const noThinking = [{ ...PROMPT_ROWS[0], MODEL_PARAMS: { per_call_max_tokens: 8192 } }, PROMPT_ROWS[1]];
  await assert.rejects(runTick({ query: fakeSnowflake({ prompts: noThinking }).query, gemini: fakeGemini() }), /no thinking_level/);
  const tool = [{ ...PROMPT_ROWS[0], TEMPLATE: "Call commit_attributions once." }, PROMPT_ROWS[1]];
  await assert.rejects(runTick({ query: fakeSnowflake({ prompts: tool }).query, gemini: fakeGemini() }), /names the tool commit_attributions/);
});
