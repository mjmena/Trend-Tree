// The Gemini Batch API client over a fake fetch.
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiBatchClient } from "./gemini_batch.mjs";

function fakeFetch(status, body) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

test("submitBatch posts the inline requests to the model's batchGenerateContent and returns the batch name", async () => {
  const f = fakeFetch(200, { name: "batches/abc", metadata: { state: "BATCH_STATE_PENDING" } });
  const client = createGeminiBatchClient({ apiKey: "k", fetch: f.fetch });
  const requests = [{ metadata: { key: "t1" }, request: { contents: [] } }];
  const out = await client.submitBatch({ model: "gemini-3.8-flash", displayName: "lcy-chain-1", requests });

  assert.equal(out.name, "batches/abc");
  const [call] = f.calls;
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:batchGenerateContent");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["x-goog-api-key"], "k");
  assert.deepEqual(JSON.parse(call.init.body), { batch: { displayName: "lcy-chain-1", inputConfig: { requests: { requests } } } });
});

test("getBatch returns the state and the inlined responses", async () => {
  const entries = [{ metadata: { key: "t1" }, error: { code: 1, message: "The operation was cancelled." } }];
  const f = fakeFetch(200, { name: "batches/abc", metadata: { state: "BATCH_STATE_SUCCEEDED", output: { inlinedResponses: { inlinedResponses: entries } } } });
  const client = createGeminiBatchClient({ apiKey: "k", fetch: f.fetch });
  assert.deepEqual(await client.getBatch("batches/abc"), { state: "BATCH_STATE_SUCCEEDED", entries });
  assert.equal(f.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/batches/abc");
});

test("a non-2xx answer throws with the status", async () => {
  const f = fakeFetch(429, { error: { message: "quota" } });
  const client = createGeminiBatchClient({ apiKey: "k", fetch: f.fetch });
  await assert.rejects(client.getBatch("batches/abc"), /GET batches\/abc -> 429/);
});

test("cancelBatch posts to the batch's :cancel", async () => {
  const f = fakeFetch(200, {});
  const client = createGeminiBatchClient({ apiKey: "k", fetch: f.fetch });
  await client.cancelBatch("batches/abc");
  assert.equal(f.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/batches/abc:cancel");
  assert.equal(f.calls[0].init.method, "POST");
});

test("generateContent posts one standard request and returns the response", async () => {
  const response = { candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: { promptTokenCount: 1 } };
  const f = fakeFetch(200, response);
  const client = createGeminiBatchClient({ apiKey: "k", fetch: f.fetch });
  const request = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  assert.deepEqual(await client.generateContent({ model: "gemini-3.8-flash", request }), response);
  assert.equal(f.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), request);
});
