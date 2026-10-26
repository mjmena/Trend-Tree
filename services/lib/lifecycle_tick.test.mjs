// The lifecycle tick over a fake Snowflake and a fake Gemini batch client.
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTick } from "./lifecycle_tick.mjs";
import { SET_QUERIES } from "./lifecycle_context.mjs";

const PROMPT_ROWS = [
  { PROMPT_KEY: "lifecycle.job.system", VERSION: 1, TEMPLATE: "SYSTEM\n{{trend_state_block}}\n{{decision_rubric}}", MODEL_PARAMS: { per_call_max_tokens: 8192, thinking_level: "medium" } },
  { PROMPT_KEY: "lifecycle.subagent.decision_rubric", VERSION: 3, TEMPLATE: "RUBRIC", MODEL_PARAMS: {} },
];

// In-memory Snowflake: the tables and proc the tick touches, matched by name.
function fakeSnowflake({ due = [], failOn = null } = {}) {
  const db = { clock: 1000, due: [...due], batches: [], ledger: [], costs: [], procCalls: [], failOn };
  const query = async (sql, binds = []) => {
    db.clock++;
    if (db.failOn && db.failOn.test(sql)) {
      db.failOn = null;
      throw new Error("injected crash");
    }
    if (sql === SET_QUERIES.metrics) {
      return JSON.parse(binds[0]).map((id) => ({ TREND_ID: id, TREND_TOPIC: `topic ${id}`, LIFECYCLE_STATUS: "STABLE", CONFIDENCE: 0.5 }));
    }
    if (Object.values(SET_QUERIES).includes(sql)) return [];
    if (/DIM_LLM_PROMPT/.test(sql)) return PROMPT_ROWS;
    if (/NEXT_LIFECYCLE_EVAL_AT/.test(sql)) return db.due.slice(0, Number(sql.match(/LIMIT (\d+)/)[1])).map((id) => ({ TREND_ID: id }));
    if (/^INSERT INTO \S+STG_LIFECYCLE_BATCHES/.test(sql)) {
      db.batches.push({ BATCH_NAME: binds[0], CHAIN_ID: binds[1], TREND_IDS: JSON.parse(binds[2]), HEAT_BASES: binds[3] === undefined ? undefined : JSON.parse(binds[3]), SUBMITTED_AT: db.clock, STATE: "SUBMITTED" });
      return [];
    }
    if (/^UPDATE \S+STG_LIFECYCLE_BATCHES/.test(sql)) {
      db.batches.find((b) => b.BATCH_NAME === binds[1]).STATE = binds[0];
      return [];
    }
    if (/^SELECT .* FROM \S+STG_LIFECYCLE_BATCHES/s.test(sql)) {
      return db.batches.filter((b) => b.STATE === "SUBMITTED").slice(-1);
    }
    if (/FCT_TREND_LIFECYCLE_LEDGER/.test(sql)) {
      const b = db.batches.find((x) => x.BATCH_NAME === binds[0]);
      const ids = new Set(db.ledger.filter((l) => b.TREND_IDS.includes(l.TREND_ID) && l.EVALUATED_AT > b.SUBMITTED_AT).map((l) => l.TREND_ID));
      return [...ids].map((TREND_ID) => ({ TREND_ID }));
    }
    if (/PROC_LIFECYCLE_APPLY/.test(sql)) {
      const decisions = JSON.parse(binds[0]);
      db.procCalls.push({ decisions, chainId: binds[1] });
      for (const d of decisions) db.ledger.push({ TREND_ID: d.trend_id, EVALUATED_AT: db.clock, CHAIN_ID: binds[1] });
      db.due = db.due.filter((id) => !decisions.some((d) => d.trend_id === id));
      return [{ PROC_LIFECYCLE_APPLY: { applied_count: decisions.length } }];
    }
    if (/STG_AGENT_RUN_COSTS/.test(sql)) {
      const [model, input, output, thinking, turns, cost, status, error, runId] = binds;
      if (!db.costs.some((c) => c.RUN_ID === runId)) {
        const b = db.batches.find((x) => x.BATCH_NAME === runId);
        db.costs.push({ RUN_ID: runId, CHAIN_ID: b.CHAIN_ID, MODEL: model, INPUT_TOKENS: input, OUTPUT_TOKENS: output, THINKING_TOKENS: thinking, TURN_COUNT: turns, COST_USD: cost, STATUS: status, ERROR_MESSAGE: error });
      }
      return [];
    }
    throw new Error(`fake Snowflake: unexpected statement ${sql.slice(0, 80)}`);
  };
  return { query, db };
}

const USAGE = { promptTokenCount: 10_000, candidatesTokenCount: 1_000, thoughtsTokenCount: 2_000 };
const answer = (status = "GROWING", hours = 24) => ({
  response: {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ status, next_eval_in_hours: hours, reasoning: "r" }) }] } }],
    usageMetadata: USAGE,
  },
});

// Fake Gemini batch API: remembers each submitted batch and reports `state`.
// `entryFor(key)` decides each inlined response once the batch has SUCCEEDED.
function fakeGemini({ state = "BATCH_STATE_SUCCEEDED", entryFor = () => answer() } = {}) {
  const g = { state, submitted: [], polls: 0 };
  g.submitBatch = async ({ model, displayName, requests }) => {
    const name = `batches/b${g.submitted.length + 1}`;
    g.submitted.push({ name, model, displayName, requests });
    return { name };
  };
  g.getBatch = async (name) => {
    g.polls++;
    const b = g.submitted.find((x) => x.name === name);
    if (g.state !== "BATCH_STATE_SUCCEEDED") return { state: g.state, entries: [] };
    return { state: g.state, entries: b.requests.map((r) => ({ metadata: r.metadata, ...entryFor(r.metadata.key) })) };
  };
  return g;
}

const AT = new Date("2026-11-01T12:00:00Z");
const tick = (sf, gemini, extra = {}) => runTick({ query: sf.query, gemini, now: () => AT, ...extra });

test("submit: the due trends go out as one keyed batch on gemini-3.8-flash, and the batch row is recorded", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini();
  await tick(sf, gemini);

  assert.equal(gemini.submitted.length, 1);
  const [b] = gemini.submitted;
  assert.equal(b.model, "gemini-3.8-flash");
  assert.deepEqual(b.requests.map((r) => r.metadata.key), ["t1", "t2"]);
  const req = b.requests[0].request;
  assert.match(req.systemInstruction.parts[0].text, /^SYSTEM\nTREND_ID: t1\n[\s\S]*RUBRIC$/);
  assert.equal(req.contents[0].parts[0].text.includes("Current status is STABLE"), true);
  assert.equal(req.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(req.generationConfig.responseSchema.required, ["status", "next_eval_in_hours", "reasoning"]);
  assert.equal(req.generationConfig.maxOutputTokens, 8192);
  assert.equal(req.tools, undefined);

  assert.equal(sf.db.batches.length, 1);
  assert.deepEqual(sf.db.batches[0], { BATCH_NAME: "batches/b1", CHAIN_ID: b.displayName, TREND_IDS: ["t1", "t2"], HEAT_BASES: { t1: 5, t2: 5 }, SUBMITTED_AT: sf.db.batches[0].SUBMITTED_AT, STATE: "SUBMITTED" });
  assert.match(b.displayName, /^lcy-chain-/);
  assert.equal(sf.db.ledger.length, 0, "submit moves no NEXT_EVAL_AT");
});

test("the cap limits the due set", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2", "t3"] });
  const gemini = fakeGemini();
  await tick(sf, gemini, { cap: 2 });
  assert.deepEqual(gemini.submitted[0].requests.map((r) => r.metadata.key), ["t1", "t2"]);
});

test("no due trends: nothing is submitted", async () => {
  const sf = fakeSnowflake({ due: [] });
  const gemini = fakeGemini();
  await tick(sf, gemini);
  assert.equal(gemini.submitted.length, 0);
  assert.equal(sf.db.batches.length, 0);
});

for (const state of ["BATCH_STATE_PENDING", "BATCH_STATE_RUNNING"]) {
  test(`a batch still ${state} ends the tick without a submit`, async () => {
    const sf = fakeSnowflake({ due: ["t1"] });
    const gemini = fakeGemini();
    await tick(sf, gemini);
    gemini.state = state;
    sf.db.due.push("t9");
    const summary = await tick(sf, gemini);
    assert.equal(summary.waiting, "batches/b1");
    assert.equal(gemini.submitted.length, 1);
    assert.equal(sf.db.procCalls.length, 0);
    assert.equal(sf.db.batches[0].STATE, "SUBMITTED");
  });
}

test("submit then collect: one proc call, one COLLECTED row, one OK cost row keyed by the batch name", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini({ entryFor: (key) => answer("GROWING", key === "t1" ? 2 : 500) });
  await tick(sf, gemini);
  await tick(sf, gemini);

  assert.equal(sf.db.procCalls.length, 1);
  const [call] = sf.db.procCalls;
  assert.equal(call.chainId, "batches/b1");
  assert.deepEqual(call.decisions.map((d) => [d.trend_id, d.chain_id, d.lifecycle_decision.next_eval_in_hours]), [
    ["t1", "batches/b1", 6],
    ["t2", "batches/b1", 168],
  ]);
  assert.equal(typeof call.decisions[0].heat_base, "number");
  assert.match(call.decisions[0].agent_session_id, /^lcy-sess-/);

  assert.equal(sf.db.batches[0].STATE, "COLLECTED");
  assert.equal(sf.db.costs.length, 1);
  assert.deepEqual(sf.db.costs[0], {
    RUN_ID: "batches/b1",
    CHAIN_ID: gemini.submitted[0].displayName,
    MODEL: "gemini-3.8-flash",
    INPUT_TOKENS: 20_000,
    OUTPUT_TOKENS: 2_000,
    THINKING_TOKENS: 4_000,
    TURN_COUNT: 2,
    COST_USD: 0.01875, // 2 × (10k × $0.375/M + 3k × $1.875/M)
    STATUS: "OK",
    ERROR_MESSAGE: null,
  });
});

test("collect then submit in one tick: a trend still due after collect goes into the next batch", async () => {
  const sf = fakeSnowflake({ due: ["t1"] });
  const gemini = fakeGemini();
  await tick(sf, gemini);
  sf.db.due.push("t2");
  await tick(sf, gemini);
  assert.equal(gemini.submitted.length, 2);
  assert.deepEqual(gemini.submitted[1].requests.map((r) => r.metadata.key), ["t2"]);
  assert.deepEqual(sf.db.batches.map((b) => b.STATE), ["COLLECTED", "SUBMITTED"]);
});

test("re-collect after a crash writes zero ledger rows and one cost row", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini();
  await tick(sf, gemini);
  sf.db.failOn = /^UPDATE \S+STG_LIFECYCLE_BATCHES/;
  await assert.rejects(tick(sf, gemini), /injected crash/);
  assert.equal(sf.db.ledger.length, 2);
  assert.equal(sf.db.batches[0].STATE, "SUBMITTED");

  await tick(sf, gemini);
  assert.equal(sf.db.ledger.length, 2, "the second collect must apply nothing");
  assert.equal(sf.db.procCalls.length, 1);
  assert.equal(sf.db.batches[0].STATE, "COLLECTED");
  assert.equal(sf.db.costs.length, 1);
});

test("cancelled and unparseable entries leave their trends due and are named on the cost row", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2", "t3"] });
  const gemini = fakeGemini({
    entryFor: (key) => ({
      t1: answer(),
      t2: { error: { code: 1, message: "The operation was cancelled." } },
      t3: { response: { candidates: [{ content: { parts: [{ text: "not json" }] } }], usageMetadata: USAGE } },
    })[key],
  });
  await tick(sf, gemini, { cap: 3 });
  await tick(sf, gemini, { cap: 0 });
  assert.deepEqual(sf.db.procCalls[0].decisions.map((d) => d.trend_id), ["t1"]);
  assert.equal(sf.db.costs[0].STATUS, "OK");
  assert.equal(sf.db.costs[0].ERROR_MESSAGE, "t3: answer is not JSON");
});

test("collect takes heat_base from the batch row, not from echoed request metadata", async () => {
  const sf = fakeSnowflake({ due: ["t1"] });
  const gemini = fakeGemini({ entryFor: (key) => ({ metadata: { key }, ...answer() }) });
  await tick(sf, gemini);
  sf.db.batches[0].HEAT_BASES.t1 = 37.5;
  await tick(sf, gemini, { cap: 0 });
  assert.equal(sf.db.procCalls[0].decisions[0].heat_base, 37.5);
});

test("a trend missing from the batch row's heat bases gets no decision and stays due", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini();
  await tick(sf, gemini);
  delete sf.db.batches[0].HEAT_BASES.t2;
  await tick(sf, gemini, { cap: 0 });
  assert.deepEqual(sf.db.procCalls[0].decisions.map((d) => d.trend_id), ["t1"]);
  assert.deepEqual(sf.db.due, ["t2"]);
  assert.equal(sf.db.costs[0].ERROR_MESSAGE, "t2: no heat_base on the batch row");
});
