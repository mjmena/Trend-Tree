// CRMA-1445: the first JS step of each open HTTP workflow must reject a
// request-body ID that could break out of a quoted SQL literal.
// Run: node scripts/test_trigger_id_validation.mjs
import assert from "node:assert/strict";

globalThis.defineComponent = (c) => c;
const $ = { export() {}, flow: { exit() {} } };
const run = async (path, body) => {
  const { default: step } = await import(new URL(`../${path}`, import.meta.url));
  return step.run.call({ trigger_event: { body } }, { $ });
};
const UUID = "0b6c3f2e-6a1d-4c39-9d7e-2f1a5b8c4e10";
const BAD = "x' OR '1'='1";

const cases = [
  ["enrichment-p_xMC995w/normalize_event/entry.js", ["trend_id", "chain_id", "agent_session_id"], { trend_id: UUID }],
  ["distillation-p_mkCBBqb/normalize_event/entry.js", ["chain_id", "agent_session_id"], {}],
  ["promotion-p_xMC99jg/normalize_event/entry.js", ["chain_id"], {}],
  ["sources-p_7NCy36w/validate_event/entry.js", ["trend_id"], { trend_id: UUID }],
  ["write-p_o7CWa2K/validate_event/entry.js", ["trend_id"], { trend_id: UUID }],
];

for (const [path, fields, good] of cases) {
  await run(path, good);
  await run(path, { ...good, chain_id: `chain-${UUID}` });
  for (const f of fields) {
    await assert.rejects(run(path, { ...good, [f]: BAD }), /invalid/, `${path} accepted ${f}=${BAD}`);
    await assert.rejects(run(path, { ...good, [f]: "a".repeat(65) }), /invalid/, `${path} accepted a 65-char ${f}`);
  }
  if (good.trend_id) await assert.rejects(run(path, {}), /trend_id/, `${path} accepted a missing trend_id`);
  console.log(`ok ${path}`);
}
