// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTRIBUTION_SCHEMA, buildBatchRequest, buildBlocks, entryCost, filterAttributions, parseAttributions, toPool,
} from "./attribution_context.mjs";

const POOL = toPool([
  { SIGNAL_ID: "s1", SOURCE_NAME: "gdelt", SIGNAL_TIMESTAMP: "2026-11-01T19:25:22", SIGNAL_TITLE: "T1", SIGNAL_TEXT: "x", SIMILARITY: "0.456" },
  { SIGNAL_ID: "s2", SOURCE_NAME: "bluesky", SIGNAL_TIMESTAMP: "2026-11-02T08:00:00", SIGNAL_TITLE: null, SIGNAL_TEXT: null, SIMILARITY: 0.4 },
]);

test("filterAttributions keeps in-pool pairs with an allowed link_type, once each", () => {
  const { kept, dropped } = filterAttributions([
    { signal_id: "s1", link_type: "news" },
    { signal_id: "s1", link_type: "social" },
    { signal_id: "s9", link_type: "news" },
    { signal_id: "s2", link_type: "video" },
    { signal_id: "s2", link_type: "other" },
  ], POOL);
  assert.deepEqual(kept, [{ signal_id: "s1", link_type: "news" }, { signal_id: "s2", link_type: "other" }]);
  assert.equal(dropped, 3);
});

test("parseAttributions reads the JSON answer and skips thought parts", () => {
  const ok = { candidates: [{ content: { parts: [{ thought: true, text: "hmm" }, { text: '{"attributions":[{"signal_id":"s1","link_type":"news"}]}' }] } }] };
  assert.deepEqual(parseAttributions(ok), [{ signal_id: "s1", link_type: "news" }]);
  assert.equal(parseAttributions({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), null);
  assert.equal(parseAttributions({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), null);
  assert.equal(parseAttributions(undefined), null);
});

test("entryCost bills thinking as output, halves a batch, and refuses an unpriced model", () => {
  const usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 900_000 };
  assert.equal(entryCost(usage, { batch: false }), 14);
  assert.equal(entryCost(usage, { batch: true }), 7);
  assert.throws(() => entryCost(usage, { model: "gemini-9" }), /no rates/);
});

test("buildBlocks renders the subagent's trend and candidate blocks", () => {
  const { trend_block, candidate_signals_block } = buildBlocks(
    { TREND_ID: "t1", TREND_TOPIC: "Quiet hours", CATEGORY: "social", SUBCATEGORY: null, PROMOTED_AT: "2026-06-28T10:14:47.125000", SUMMARY_SHORT: null },
    [{ LINK_TYPE: "news" }, { LINK_TYPE: "other" }],
    POOL,
  );
  assert.equal(trend_block, `TREND_ID: t1
TREND_TOPIC: Quiet hours
TREND_NAME_B2B / B2C: (unenriched) / (unenriched)
CATEGORY: social / ?
PROMOTED_AT: 2026-06-28T10:14:47.125000
SUMMARY: (no summary yet)
EXISTING SIGNAL SOURCE TYPES: news, other`);
  assert.equal(candidate_signals_block,
    `1. [s1] sim=0.46 [gdelt] 2026-11-01T19:25:22\n   Title: "T1"\n   Text: x\n\n` +
    `2. [s2] sim=0.40 [bluesky] 2026-11-02T08:00:00\n   Title: ""\n   Text: `);
});

test("buildBatchRequest has no tools and the commit_attributions schema", () => {
  const r = buildBatchRequest({ trendId: "t1", topic: "Quiet hours", poolSize: 2, systemPrompt: "SYS", params: { per_call_max_tokens: 8192, thinking_level: "low" } });
  assert.equal(r.metadata.key, "t1");
  assert.equal(r.request.tools, undefined);
  assert.equal(r.request.generationConfig.responseSchema, ATTRIBUTION_SCHEMA);
  assert.equal(r.request.generationConfig.maxOutputTokens, 8192);
  assert.match(r.request.contents[0].parts[0].text, /^Evaluate 2 candidate signals for trend t1 \("Quiet hours"\)/);
});
