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
      db.batches.push({ BATCH_NAME: binds[0], CHAIN_ID: binds[1], TREND_IDS: JSON.parse(binds[2]), HEAT_BASES: binds[3] === undefined ? undefined : JSON.parse(binds[3]), BUDGET_EXHAUSTED: binds[4], SUBMITTED_AT: db.clock, AGE_S: 0, STATE: "SUBMITTED" });
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
// `retryFor(key)` answers a standard generateContent retry, or throws.
function fakeGemini({ state = "BATCH_STATE_SUCCEEDED", entryFor = () => answer(), retryFor = () => answer().response } = {}) {
  const g = { state, submitted: [], polls: 0, cancelled: [], retries: [] };
  g.submitBatch = async ({ model, displayName, requests }) => {
    const name = `batches/b${g.submitted.length + 1}`;
    g.submitted.push({ name, model, displayName, requests });
    return { name };
  };
  g.getBatch = async (name) => {
    g.polls++;
    const b = g.submitted.find((x) => x.name === name);
    if (g.cancelled.includes(name)) {
      return { state: "BATCH_STATE_SUCCEEDED", entries: b.requests.map((r) => ({ metadata: r.metadata, error: { code: 1, message: "The operation was cancelled." } })) };
    }
    if (g.state !== "BATCH_STATE_SUCCEEDED") return { state: g.state, entries: [] };
    return { state: g.state, entries: b.requests.map((r) => ({ metadata: r.metadata, ...entryFor(r.metadata.key) })) };
  };
  g.cancelBatch = async (name) => { g.cancelled.push(name); };
  g.generateContent = async ({ model, request }) => {
    const key = request.contents[0].parts[0].text.match(/^Evaluate trend (\S+)\./)[1];
    g.retries.push({ model, key });
    return retryFor(key);
  };
  return g;
}

const AT = new Date("2026-11-01T12:00:00Z");
const tick = (sf, gemini, extra = {}) => runTick({ query: sf.query, gemini, now: () => AT, ...extra });
// tick.mjs exits 0 when the tick resolves and 1 when it throws.
const exitCode = (p) => p.then(() => 0, () => 1);
const notJson = { response: { candidates: [{ content: { parts: [{ text: "not json" }] } }], usageMetadata: USAGE } };

// A failed trend keeps its NEXT_EVAL_AT: no ledger row, still in the due set.
function assertStillDue(sf, ids) {
  for (const id of ids) {
    assert.equal(sf.db.ledger.some((l) => l.TREND_ID === id), false, `${id} got a ledger row`);
    assert.equal(sf.db.due.includes(id), true, `${id} is no longer due`);
  }
}

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
  assert.deepEqual(sf.db.batches[0], { BATCH_NAME: "batches/b1", CHAIN_ID: b.displayName, TREND_IDS: ["t1", "t2"], HEAT_BASES: { t1: 5, t2: 5 }, BUDGET_EXHAUSTED: false, SUBMITTED_AT: sf.db.batches[0].SUBMITTED_AT, AGE_S: 0, STATE: "SUBMITTED" });
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

test("re-collect after a crash writes zero ledger rows, retries nothing again, and one cost row", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2", "t3"] });
  const gemini = fakeGemini({ entryFor: (key) => (key === "t2" ? notJson : answer()) });
  await tick(sf, gemini);
  sf.db.failOn = /^UPDATE \S+STG_LIFECYCLE_BATCHES/;
  assert.equal(await exitCode(tick(sf, gemini)), 1);
  assert.equal(sf.db.ledger.length, 3);
  assert.equal(sf.db.batches[0].STATE, "SUBMITTED");

  assert.equal(await exitCode(tick(sf, gemini)), 0);
  assert.equal(sf.db.ledger.length, 3, "the second collect must apply nothing");
  assert.equal(sf.db.procCalls.length, 1);
  assert.equal(gemini.retries.length, 1);
  assert.equal(sf.db.batches[0].STATE, "COLLECTED");
  assert.equal(sf.db.costs.length, 1);
  assert.equal(sf.db.costs[0].STATUS, "OK");
});

for (const [label, state] of [["collect", "BATCH_STATE_SUCCEEDED"], ["close", "BATCH_STATE_FAILED"]]) {
  test(`${label}: a crash after the state update loses the cost row, and the next tick writes none and submits`, async () => {
    const sf = fakeSnowflake({ due: ["t1"] });
    const gemini = fakeGemini({ state });
    await tick(sf, gemini);
    sf.db.failOn = /STG_AGENT_RUN_COSTS/;
    assert.equal(await exitCode(tick(sf, gemini)), 1);
    assert.notEqual(sf.db.batches[0].STATE, "SUBMITTED");

    sf.db.due = ["t2"];
    assert.equal(await exitCode(tick(sf, gemini)), 0);
    assert.equal(sf.db.costs.length, 0);
    assert.deepEqual(gemini.submitted[1].requests.map((r) => r.metadata.key), ["t2"]);
  });
}

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

test("a batch pending 6 h after submit is cancelled, costed TIMEOUT, and its trends go into the same tick's new batch", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini({ state: "BATCH_STATE_PENDING" });
  await tick(sf, gemini);
  sf.db.batches[0].AGE_S = 6 * 3600;

  assert.equal(await exitCode(tick(sf, gemini)), 0);
  assert.deepEqual(gemini.cancelled, ["batches/b1"]);
  assert.equal(sf.db.batches[0].STATE, "CANCELLED");
  assert.equal(sf.db.costs[0].STATUS, "TIMEOUT");
  assertStillDue(sf, ["t1", "t2"]);
  assert.deepEqual(gemini.submitted[1].requests.map((r) => r.metadata.key), ["t1", "t2"]);
});

test("a batch still pending under 6 h after submit is left alone", async () => {
  const sf = fakeSnowflake({ due: ["t1"] });
  const gemini = fakeGemini({ state: "BATCH_STATE_RUNNING" });
  await tick(sf, gemini);
  sf.db.batches[0].AGE_S = 6 * 3600 - 1;
  assert.equal(await exitCode(tick(sf, gemini)), 0);
  assert.deepEqual(gemini.cancelled, []);
  assert.equal(sf.db.costs.length, 0);
});

for (const state of ["BATCH_STATE_FAILED", "BATCH_STATE_EXPIRED", "BATCH_STATE_CANCELLED", "BATCH_STATE_UNSPECIFIED"]) {
  test(`a ${state} batch is marked FAILED, costed ERROR, and the tick submits again`, async () => {
    const sf = fakeSnowflake({ due: ["t1", "t2"] });
    const gemini = fakeGemini({ state });
    await tick(sf, gemini);

    assert.equal(await exitCode(tick(sf, gemini)), 0);
    assert.equal(sf.db.batches[0].STATE, "FAILED");
    assert.equal(sf.db.costs[0].STATUS, "ERROR");
    assertStillDue(sf, ["t1", "t2"]);
    assert.equal(gemini.submitted.length, 2);
  });
}

test("a SUCCEEDED batch whose entries all carry error code 1 applies nothing, is not retried, and is costed TIMEOUT as CANCELLED", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini({ entryFor: () => ({ error: { code: 1, message: "The operation was cancelled." } }) });
  await tick(sf, gemini);

  assert.equal(await exitCode(tick(sf, gemini, { cap: 0 })), 0);
  assert.equal(sf.db.procCalls.length, 0);
  assert.deepEqual(gemini.retries, []);
  assertStillDue(sf, ["t1", "t2"]);
  assert.equal(sf.db.costs[0].STATUS, "TIMEOUT");
  assert.equal(sf.db.batches[0].STATE, "CANCELLED");
});

test("a non-JSON entry gets one standard retry; its answer is applied at standard rates", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini({ entryFor: (key) => (key === "t2" ? notJson : answer()) });
  await tick(sf, gemini);

  assert.equal(await exitCode(tick(sf, gemini, { cap: 0 })), 0);
  assert.deepEqual(gemini.retries, [{ model: "gemini-3.8-flash", key: "t2" }]);
  assert.deepEqual(sf.db.procCalls[0].decisions.map((d) => d.trend_id), ["t1", "t2"]);
  assert.equal(sf.db.procCalls[0].decisions[1].llm_cost_estimate, 0.01875, "10k × $0.75/M + 3k × $3.75/M");
  assert.equal(sf.db.costs[0].STATUS, "OK");
  assert.equal(sf.db.costs[0].INPUT_TOKENS, 30_000, "two batch entries plus the retry");
  assert.equal(sf.db.costs[0].ERROR_MESSAGE, null);
});

test("an errored entry whose retry also fails leaves the trend due and is named on the cost row", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2", "t3"] });
  const gemini = fakeGemini({
    entryFor: (key) => ({ t1: answer(), t2: notJson, t3: { error: { code: 13, message: "internal" } } })[key],
    retryFor: (key) => {
      if (key === "t3") throw new Error("Gemini POST -> 500");
      return notJson.response;
    },
  });
  await tick(sf, gemini);

  assert.equal(await exitCode(tick(sf, gemini, { cap: 0 })), 0);
  assert.deepEqual(gemini.retries.map((r) => r.key), ["t2", "t3"]);
  assert.deepEqual(sf.db.procCalls[0].decisions.map((d) => d.trend_id), ["t1"]);
  assertStillDue(sf, ["t2", "t3"]);
  assert.equal(sf.db.costs[0].STATUS, "OK");
  assert.equal(sf.db.costs[0].ERROR_MESSAGE,
    "t2: answer is not JSON, and the retry: answer is not JSON; t3: error 13 internal, and the retry: Gemini POST -> 500");
});

test("the cost row's ERROR_MESSAGE is cut at 2,000 characters", async () => {
  const sf = fakeSnowflake({ due: ["t1"] });
  const gemini = fakeGemini({ entryFor: () => ({ error: { code: 13, message: "x".repeat(3000) } }), retryFor: () => notJson.response });
  await tick(sf, gemini);
  await tick(sf, gemini, { cap: 0 });
  assert.equal(sf.db.costs[0].ERROR_MESSAGE.length, 2000);
});

test("retries count against the cap of the batch the same tick submits", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini({ entryFor: () => notJson, retryFor: () => notJson.response });
  await tick(sf, gemini);
  sf.db.due.push("t3", "t4");

  await tick(sf, gemini, { cap: 3 });
  assert.equal(gemini.retries.length, 2);
  assert.deepEqual(gemini.submitted[1].requests.map((r) => r.metadata.key), ["t1"]);
});

test("the cap cuts the due set: the most overdue go, and that batch's cost row is BUDGET_EXHAUSTED", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2", "t3"] });
  const gemini = fakeGemini();
  await tick(sf, gemini, { cap: 2 });
  assert.deepEqual(gemini.submitted[0].requests.map((r) => r.metadata.key), ["t1", "t2"]);

  assert.equal(await exitCode(tick(sf, gemini, { cap: 0 })), 0);
  assert.equal(sf.db.costs[0].STATUS, "BUDGET_EXHAUSTED");
  assertStillDue(sf, ["t3"]);
});

test("a due set exactly the cap's size is not BUDGET_EXHAUSTED", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini();
  await tick(sf, gemini, { cap: 2 });
  await tick(sf, gemini, { cap: 0 });
  assert.equal(sf.db.costs[0].STATUS, "OK");
});

test("a pending-past-6h cut-down batch is costed TIMEOUT, not BUDGET_EXHAUSTED", async () => {
  const sf = fakeSnowflake({ due: ["t1", "t2"] });
  const gemini = fakeGemini({ state: "BATCH_STATE_PENDING" });
  await tick(sf, gemini, { cap: 1 });
  sf.db.batches[0].AGE_S = 7 * 3600;
  await tick(sf, gemini, { cap: 0 });
  assert.equal(sf.db.costs[0].STATUS, "TIMEOUT");
});

test("a Snowflake, submit or collect failure is a non-zero exit", async () => {
  const sfDown = fakeSnowflake({ due: ["t1"], failOn: /DIM_LLM_PROMPT/ });
  assert.equal(await exitCode(tick(sfDown, fakeGemini())), 1);

  const submitDown = fakeGemini();
  submitDown.submitBatch = async () => { throw new Error("Gemini POST -> 503"); };
  assert.equal(await exitCode(tick(fakeSnowflake({ due: ["t1"] }), submitDown)), 1);

  const sf = fakeSnowflake({ due: ["t1"] });
  const collectDown = fakeGemini();
  await tick(sf, collectDown);
  collectDown.getBatch = async () => { throw new Error("Gemini GET -> 503"); };
  assert.equal(await exitCode(tick(sf, collectDown)), 1);
  assertStillDue(sf, ["t1"]);
});

const refuse = (params, template = "SYSTEM\n{{trend_state_block}}\n{{decision_rubric}}") => {
  const sf = fakeSnowflake({ due: ["t1"] });
  const rows = [{ ...PROMPT_ROWS[0], TEMPLATE: template, MODEL_PARAMS: { ...PROMPT_ROWS[0].MODEL_PARAMS, ...params } }, PROMPT_ROWS[1]];
  const query = (sql, binds) => (/DIM_LLM_PROMPT/.test(sql) ? Promise.resolve(rows) : sf.query(sql, binds));
  const gemini = fakeGemini();
  return { run: runTick({ query, gemini, now: () => AT }), gemini };
};

test("the job refuses to start when per_call_max_tokens is below 8192", async () => {
  const { run, gemini } = refuse({ per_call_max_tokens: 8191 });
  await assert.rejects(run, /per_call_max_tokens/);
  assert.equal(gemini.submitted.length, 0);
});

for (const word of ["propose_lifecycle_decision", "query_trend_", "query_signal_", "query_lifecycle_"]) {
  test(`the job refuses to start when the rendered prompt still names ${word}`, async () => {
    const { run, gemini } = refuse({}, `SYSTEM call ${word}x\n{{decision_rubric}}`);
    await assert.rejects(run, new RegExp(word));
    assert.equal(gemini.submitted.length, 0);
  });
}

test("the job refuses to start when per_call_max_tokens is missing", async () => {
  const { run } = refuse({ per_call_max_tokens: undefined });
  await assert.rejects(run, /per_call_max_tokens/);
});

test("the job refuses to start when a tool word reaches the prompt through a rendered block", async () => {
  const sf = fakeSnowflake({ due: ["t1"] });
  const rows = [PROMPT_ROWS[0], { ...PROMPT_ROWS[1], TEMPLATE: "call query_signal_x" }];
  const query = (sql, binds) => (/DIM_LLM_PROMPT/.test(sql) ? Promise.resolve(rows) : sf.query(sql, binds));
  const gemini = fakeGemini();
  await assert.rejects(runTick({ query, gemini, now: () => AT }), /query_signal_/);
  assert.equal(gemini.submitted.length, 0);
});

test("a payload of 20 MB or more is refused before submit", async () => {
  const sf = fakeSnowflake({ due: ["t1"] });
  const big = (sql, binds) => (/DIM_LLM_PROMPT/.test(sql)
    ? Promise.resolve([{ ...PROMPT_ROWS[0], TEMPLATE: "x".repeat(20 * 1024 * 1024) }, PROMPT_ROWS[1]])
    : sf.query(sql, binds));
  const gemini = fakeGemini();
  await assert.rejects(runTick({ query: big, gemini, now: () => AT }), /20 MB/);
  assert.equal(gemini.submitted.length, 0);
});
