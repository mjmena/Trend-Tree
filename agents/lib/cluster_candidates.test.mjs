import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const stepSource = readFileSync(new URL(
  "../../distillation-cluster-agent-p_YyC89Ke/run_lead_agent/entry.js", import.meta.url,
), "utf8");

const candidate = (supporting_signal_ids) => ({
  topic: "Mushroom coffee", query: "mushroom coffee", supporting_signal_ids,
  confidence: 0.8, specificity_score: 0.7, verdict: "REAL_TREND", reasoning: "Independent reports",
});

async function runProposals(turns) {
  const requests = [];
  let component;
  // Load the deployed step without changing its functions or adding an export.
  runInNewContext(stepSource.replace("export default defineComponent(", "defineComponent("), {
    defineComponent(value) { component = value; },
    AbortController, setTimeout, clearTimeout, URL,
    console: { log() {} },
    async fetch(url, options) {
      assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
      const proposals = turns[requests.length];
      requests.push(JSON.parse(options.body));
      const parts = proposals
        ? proposals.map((args) => ({ functionCall: { name: "propose_trend_candidate", args } }))
        : [{ text: "Finished" }];
      return { ok: true, json: async () => ({ candidates: [{ content: { parts }, finishReason: "STOP" }] }) };
    },
  });
  const result = await component.run.call({
    event: { chain_id: "chain", agent_session_id: "session", iteration: 2 },
    google_gemini: { $auth: { api_key: "unused" } },
    signal_rows: ["signal-a", "signal-b", "signal-c"].map((SIGNAL_ID) => ({ SIGNAL_ID })),
    prompts_rows: [{
      PROMPT_KEY: "distillation.lead.system", TEMPLATE: "Inspect the signals.",
      MODEL_PARAMS: { max_iterations: turns.length + 1 },
    }],
  }, { steps: {}, $: { export() {} } });
  assert.equal(result.stop_reason, "STOP", result.error);
  const responses = requests.at(-1).contents
    .flatMap((message) => message.parts)
    .filter((part) => part.functionResponse)
    .map((part) => part.functionResponse.response);
  return { candidates: JSON.parse(result.candidates_json), responses, requests };
}

test("the cluster output keeps only distinct IDs from its input pool", async () => {
  const proposal = candidate(["signal-b", "invented", "signal-a", "signal-b"]);
  const { candidates, responses } = await runProposals([[proposal]]);

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].supporting_signal_ids, ["signal-b", "signal-a"]);
  assert.equal(candidates[0].topic, proposal.topic);
  assert.equal(candidates[0].query, proposal.query);
  assert.equal(candidates[0].chain_id, "chain");
  assert.equal(candidates[0].iteration, 2);
  assert.equal(candidates[0].agent_session_id, "session");
  assert.equal(responses[0].accepted, true);
  assert.equal(responses[0].accepted_count, 1);
  assert.equal(responses[0].candidate_id, candidates[0].candidate_id);
});

for (const ids of [[], ["signal-a"], ["signal-a", "signal-a"], ["signal-a", "invented"], ["invented", "other"], null, "signal-a"]) {
  test(`fewer than two distinct pool signals is returned to the model as an error: ${JSON.stringify(ids)}`, async () => {
    const { candidates, responses } = await runProposals([[candidate(ids)]]);

    assert.deepEqual(candidates, []);
    assert.equal(responses[0].accepted, false);
    assert.match(responses[0].error, /at least 2 distinct.*signal.*pool/i);
  });
}

test("a rejected proposal can be corrected without leaving an invalid candidate", async () => {
  const { candidates, responses, requests } = await runProposals([
    [candidate(["signal-a", "invented"])],
    [candidate(["signal-a", "signal-b"])],
  ]);

  assert.equal(responses[0].accepted, false);
  assert.equal(responses[1].accepted, true);
  assert.equal(responses[1].accepted_count, 1);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].supporting_signal_ids, ["signal-a", "signal-b"]);
  const schema = requests[0].tools[0].functionDeclarations.find((tool) => tool.name === "propose_trend_candidate");
  assert.equal(schema.parameters.properties.supporting_signal_ids.minItems, 2);
});
