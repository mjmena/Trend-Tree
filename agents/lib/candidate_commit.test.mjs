import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function loadStep(path, globals = {}) {
  let component;
  const logs = [];
  const summaries = [];
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
    .replace('import snowflake from "snowflake-sdk";', "")
    .replace("export default defineComponent(", "defineComponent(");
  runInNewContext(source, {
    defineComponent(value) { component = value; },
    console: { log(value) { logs.push(value); } },
    ...globals,
  });
  return { component, logs, summaries, $: { export(key, value) { summaries.push([key, value]); } } };
}

for (const committed of [0, 1, 3]) {
  test(`distillation reports ${committed} actual inserts and ${3 - committed} dropped candidates`, async () => {
    const step = loadStep("distillation-p_mkCBBqb/respond/entry.js");
    const result = await step.component.run.call({
      agent_result: { candidates_count: 3, chain_id: "test-chain" },
      commit_result: [{ "number of rows inserted": committed }],
      claim_signals_result: [{ "number of rows updated": 5 }],
    }, { $: step.$ });
    assert.equal(result.candidates_committed, committed);
    assert.equal(result.candidates_dropped, 3 - committed);
    assert.equal(result.candidates_count, 3);
    assert.equal(result.claimed_signal_count, 5);
    assert.ok(step.logs.some((line) => line.includes(`dropped ${3 - committed}`)));
    assert.ok(step.summaries.some(([, value]) => value.includes(`${committed} committed`)));
  });
}

function revisit(inserted, insertError) {
  const queries = [];
  let destroyed = false;
  const conn = {
    connect(callback) { callback(null); },
    execute({ sqlText, binds, complete }) {
      queries.push({ sqlText, binds });
      if (sqlText.includes("INSERT INTO")) {
        complete(insertError, {}, [{ "number of rows inserted": inserted }]);
      } else {
        complete(null, {}, [{ "number of rows updated": 1 }]);
      }
    },
    destroy(callback) { destroyed = true; callback(); },
  };
  const step = loadStep("distillation-revisit-p_o7CWWZl/commit_batch_result/entry.mjs", {
    snowflake: { createConnection() { return conn; } },
  });
  const run = (parsed) => step.component.run.call({ parsed, snowflake: { $auth: {} } }, { $: step.$ });
  return { ...step, run, queries, destroyed: () => destroyed };
}

for (const committed of [0, 1, 3]) {
  test(`revisit persists the actual count when ${committed} of 3 candidates survive`, async () => {
    const step = revisit(committed);
    const result = await step.run({
      candidates_count: 3,
      candidates_json: '[{"candidate_id":"a"},{"candidate_id":"b"},{"candidate_id":"c"}]',
      chain_id: "test-chain", batch_index: 2,
    });
    assert.equal(result.candidates_committed, committed);
    assert.equal(result.candidates_dropped, 3 - committed);
    assert.equal(step.queries[1].binds[1], committed);
    assert.ok(step.logs.some((line) => line.includes(`dropped ${3 - committed}`)));
    assert.ok(step.summaries.some(([, value]) => value.includes(`${committed} committed`)));
    assert.equal(step.destroyed(), true);
  });
}

test("revisit skips absent batches and records empty/error batches without inserting", async () => {
  const skipped = revisit(0);
  assert.equal((await skipped.run({ skipped: true })).skipped, true);
  assert.equal(skipped.queries.length, 0);
  for (const error of [null, "cluster_agent_timeout"]) {
    const step = revisit(0);
    const result = await step.run({ candidates_count: 0, candidates_json: "[]", error });
    assert.equal(result.candidates_committed, 0);
    assert.equal(result.candidates_dropped, 0);
    assert.equal(step.queries.length, 1);
    assert.equal(step.queries[0].binds[0], error ? "FAILED" : "DONE");
  }
});

test("revisit propagates insert failures and never marks that batch done", async () => {
  const step = revisit(0, new Error("insert failed"));
  await assert.rejects(step.run({ candidates_count: 1, candidates_json: "[{}]" }), /insert failed/);
  assert.equal(step.queries.length, 1);
  assert.equal(step.destroyed(), true);
});

test("revisit rejects an unrecognized affected-row count", async () => {
  const step = revisit(undefined);
  await assert.rejects(step.run({ candidates_count: 1, candidates_json: "[{}]" }), /affected-row count/);
  assert.equal(step.queries.length, 1);
  assert.equal(step.destroyed(), true);
});
