// Tests for the TikTok title filter (CRMA-1337).
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTitleFilter, TIKTOK_FILTER_MODEL } from "./tiktok_filter.mjs";

const geminiResponse = (verdicts, { status = 200, thought = true } = {}) => ({
  status,
  ok: status === 200,
  text: async () =>
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              ...(thought ? [{ text: "thinking about it", thought: true }] : []),
              { text: JSON.stringify(verdicts) },
            ],
          },
        },
      ],
    }),
});

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return { fetchImpl, calls };
}

test("calls gemini-3.7-flash with the registry prompt, temperature 0 and JSON output", async () => {
  const { fetchImpl, calls } = fakeFetch(geminiResponse([{ i: 0, keep: true, phrase: "rice water toner" }]));
  const filter = createTitleFilter({ apiKey: "g-key", systemPrompt: "SCREEN THESE", fetchImpl });
  await filter(["Rice water toner changed my skin"]);

  assert.equal(TIKTOK_FILTER_MODEL, "gemini-3.7-flash");
  const [{ url, init, body }] = calls;
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-goog-api-key"], "g-key");
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "SCREEN THESE" }] });
  assert.deepEqual(body.generationConfig, { responseMimeType: "application/json", temperature: 0 });
  assert.equal(body.contents[0].role, "user");
  assert.match(body.contents[0].parts[0].text, /^0\. Rice water toner changed my skin$/m);
});

test("returns one verdict per title, in title order, ignoring the thought part", async () => {
  const { fetchImpl } = fakeFetch(
    geminiResponse([
      { i: 2, keep: true, phrase: "mouth taping" },
      { i: 0, keep: false, phrase: "" },
      { i: 1, keep: true, phrase: "sleepy girl mocktail" },
    ]),
  );
  const filter = createTitleFilter({ apiKey: "k", systemPrompt: "p", fetchImpl });
  const verdicts = await filter(["My routine", "Sleepy girl mocktail", "Mouth taping for sleep"]);
  assert.deepEqual(verdicts, [
    { keep: false, phrase: "" },
    { keep: true, phrase: "sleepy girl mocktail" },
    { keep: true, phrase: "mouth taping" },
  ]);
});

test("a title the model left out is dropped, not kept", async () => {
  const { fetchImpl } = fakeFetch(geminiResponse([{ i: 0, keep: true, phrase: "x" }]));
  const filter = createTitleFilter({ apiKey: "k", systemPrompt: "p", fetchImpl });
  const verdicts = await filter(["a", "b"]);
  assert.deepEqual(verdicts[1], { keep: false, phrase: "" });
});

test("only a literal true keeps a title", async () => {
  const { fetchImpl } = fakeFetch(geminiResponse([{ i: 0, keep: "true", phrase: "x" }]));
  const filter = createTitleFilter({ apiKey: "k", systemPrompt: "p", fetchImpl });
  assert.deepEqual(await filter(["a"]), [{ keep: false, phrase: "x" }]);
});

test("an HTTP failure throws, with the status", async () => {
  const { fetchImpl } = fakeFetch(geminiResponse([], { status: 503 }));
  const filter = createTitleFilter({ apiKey: "k", systemPrompt: "p", fetchImpl });
  await assert.rejects(filter(["a"]), /HTTP 503/);
});

test("output that is not a JSON array throws", async () => {
  const { fetchImpl } = fakeFetch(geminiResponse({ verdicts: [] }));
  const filter = createTitleFilter({ apiKey: "k", systemPrompt: "p", fetchImpl });
  await assert.rejects(filter(["a"]), /JSON array/);
});

test("refuses to build without a key or a prompt", () => {
  assert.throws(() => createTitleFilter({ apiKey: "", systemPrompt: "p" }), /apiKey/);
  assert.throws(() => createTitleFilter({ apiKey: "k", systemPrompt: "" }), /systemPrompt/);
});
