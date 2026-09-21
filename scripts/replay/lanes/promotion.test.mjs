// Unit tests for the promotion lane's ET-rescue prompt block (CRMA-1229).
//
// This text is mirrored by hand from handle_request/entry.js because
// loadStep can only pull top-level bindings, not code inlined in a step's
// run() body. A silent drift here would make an ET-rescue replay case look
// routed correctly (et_rescue: true) while never actually instructing the
// model to call verify_exploding_topics — the exact "quiet wrongness" this
// harness exists to avoid.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtEtRescueBlock } from "./promotion.mjs";

test("fmtEtRescueBlock is empty when the candidate was not routed to ET-rescue", () => {
  assert.equal(fmtEtRescueBlock({ et_rescue: false, candidate_topic: "x" }), "");
  assert.equal(fmtEtRescueBlock({}), "");
});

test("fmtEtRescueBlock instructs the model to call verify_exploding_topics when routed", () => {
  const block = fmtEtRescueBlock({
    et_rescue: true,
    candidate_query: "matcha overnight oats",
    candidate_topic: "matcha oats trend",
  });
  assert.match(block, /ET-RESCUE CANDIDATE/);
  assert.match(block, /verify_exploding_topics/);
  assert.match(block, /"matcha overnight oats"/);
});

test("fmtEtRescueBlock falls back to candidate_topic when candidate_query is missing", () => {
  const block = fmtEtRescueBlock({
    et_rescue: true,
    candidate_query: null,
    candidate_topic: "matcha oats trend",
  });
  assert.match(block, /"matcha oats trend"/);
});
