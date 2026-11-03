// CRMA-1448: a distillation run dispatches only the signals it claimed, and
// releases only its own claims.
// Run: node --test scripts/test_distillation_claims.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.defineComponent = (c) => c;

// In-memory STG_EXTERNAL_SIGNALS. The fake runs the three statements
// acquire_signal_ids issues, keyed on their text. snowflake-sdk is not
// installed locally, so its import resolves to this fake.
let table = [];
registerHooks({
  resolve: (spec, ctx, next) => spec === "snowflake-sdk"
    ? { url: "data:text/javascript,export default globalThis.fakeSnowflake", shortCircuit: true }
    : next(spec, ctx),
});
globalThis.fakeSnowflake = {
  createConnection: () => ({
    connect: (cb) => cb(null),
    destroy: (cb) => cb(),
    execute: ({ sqlText, binds, complete }) => {
      const [id] = binds;
      let rows = [];
      if (/SET AGENT_SESSION_ID = \?\s+WHERE COALESCE\(AGENT_SESSION_ID, ''\) = ''/.test(sqlText)) {
        table.filter((r) => !r.AGENT_SESSION_ID).slice(0, 1600).forEach((r) => { r.AGENT_SESSION_ID = id; });
      } else if (/^SELECT SIGNAL_ID[\s\S]*WHERE AGENT_SESSION_ID = \?/.test(sqlText)) {
        rows = table.filter((r) => r.AGENT_SESSION_ID === id).map(({ SIGNAL_ID }) => ({ SIGNAL_ID }));
      } else if (/SET AGENT_SESSION_ID = NULL WHERE AGENT_SESSION_ID = \?/.test(sqlText)) {
        table.filter((r) => r.AGENT_SESSION_ID === id).forEach((r) => { r.AGENT_SESSION_ID = null; });
      } else {
        return complete(new Error(`unexpected SQL: ${sqlText.slice(0, 80)}`));
      }
      complete(null, null, rows);
    },
  }),
};

const { default: acquire } = await import("../distillation-p_mkCBBqb/acquire_signal_ids/entry.js");
const { default: parse } = await import("../distillation-p_mkCBBqb/parse_cluster_result/entry.mjs");

const IN_FLIGHT = `claim-${Date.now()}-run-a`;
const seed = (unclaimed) => {
  table = [
    ...Array.from({ length: 300 }, (_, i) => ({ SIGNAL_ID: `a${i}`, AGENT_SESSION_ID: IN_FLIGHT })),
    ...Array.from({ length: unclaimed }, (_, i) => ({ SIGNAL_ID: `u${i}`, AGENT_SESSION_ID: null })),
  ];
};
const runAcquire = async () => {
  let exited = null;
  const $ = { export() {}, flow: { exit: (m) => { exited = m; } } };
  const out = await acquire.run.call({ snowflake: { $auth: {} } }, { $ });
  return { out, exited };
};

test("a run alongside an in-flight run dispatches only its own claimed signals", async () => {
  seed(200);
  const { out } = await runAcquire();
  assert.match(out.claim_id, /^claim-\d{13}-/); // the proc reads the ms between the first two dashes
  assert.equal(out.count, 200);
  assert.ok(out.signal_ids.every((id) => id.startsWith("u")), "dispatched another run's signal");
  assert.equal(table.filter((r) => r.AGENT_SESSION_ID === IN_FLIGHT).length, 300);
});

test("a run under the floor releases its own claims and leaves the in-flight run's", async () => {
  seed(100);
  const { out, exited } = await runAcquire();
  assert.equal(out, undefined);
  assert.match(exited, /waiting for 150/);
  assert.equal(table.filter((r) => r.SIGNAL_ID.startsWith("u") && r.AGENT_SESSION_ID).length, 0);
  assert.equal(table.filter((r) => r.AGENT_SESSION_ID === IN_FLIGHT).length, 300);
});

test("settle keeps the claim under the session id on success, releases it on failure", async () => {
  const $ = { export() {} };
  const meta = { agent_session_id: "sess-x", run_started_at: Date.now() };
  const ok = await parse.run.call({ dispatch_meta: meta, resume_payload: { body: { proposed_candidates: [] } } }, { $ });
  assert.equal(ok.keep_claims_as, "sess-x"); // 0 candidates still consumes the signals
  const timedOut = await parse.run.call({ dispatch_meta: meta, resume_payload: undefined }, { $ });
  assert.equal(timedOut.keep_claims_as, "");
  const errored = await parse.run.call({ dispatch_meta: meta, resume_payload: { body: { error: "boom" } } }, { $ });
  assert.equal(errored.keep_claims_as, "");
});
