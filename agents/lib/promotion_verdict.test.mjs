// Tests for the distillation-verdict contract (CRMA-1029).
// Run: node --test agents/lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDistillationVerdict } from "./promotion_verdict.mjs";

const TREND = "8f2c1d4a-0b7e-4c39-9a15-6d8e2f3b7c01";

// ── The bug CRMA-1029 fixes ────────────────────────────────────────────
// Distillation writes the bare "DUPLICATE_OF" and puts the target in the
// separate DEDUP_OF_TREND_ID column. The subagent used to test startsWith
// on "DUPLICATE_OF_" (trailing underscore), so the bare form failed both
// the allowlist and the prefix test and threw.

test("bare DUPLICATE_OF is accepted and takes the target from the body", () => {
  const r = resolveDistillationVerdict("DUPLICATE_OF", TREND);
  assert.equal(r.isDuplicateOf, true);
  assert.equal(r.dedupTarget, TREND);
});

test("bare DUPLICATE_OF does not throw", () => {
  assert.doesNotThrow(() => resolveDistillationVerdict("DUPLICATE_OF", TREND));
});

// ── Backward compatibility: the concatenated form ──────────────────────

test("legacy DUPLICATE_OF_<id> still resolves, target parsed from the suffix", () => {
  const r = resolveDistillationVerdict(`DUPLICATE_OF_${TREND}`, null);
  assert.equal(r.isDuplicateOf, true);
  assert.equal(r.dedupTarget, TREND);
});

test("body target wins over the suffix when both are present", () => {
  const other = "11111111-2222-3333-4444-555555555555";
  const r = resolveDistillationVerdict(`DUPLICATE_OF_${TREND}`, other);
  assert.equal(r.dedupTarget, other);
});

// ── Plain verdicts ─────────────────────────────────────────────────────

for (const v of ["REAL_TREND", "NOISE", "CATEGORY_TOO_BROAD"]) {
  test(`${v} resolves with no dedup target`, () => {
    const r = resolveDistillationVerdict(v, null);
    assert.equal(r.isDuplicateOf, false);
    assert.equal(r.dedupTarget, null);
    assert.equal(r.verdict, v);
  });
}

test("a stray dedup target on a non-duplicate verdict is dropped", () => {
  const r = resolveDistillationVerdict("REAL_TREND", TREND);
  assert.equal(r.isDuplicateOf, false);
  assert.equal(r.dedupTarget, null);
});

// ── Rejections ─────────────────────────────────────────────────────────

test("an unknown verdict still throws", () => {
  assert.throws(() => resolveDistillationVerdict("SOMETHING_ELSE", null), /unknown distillation_verdict/);
});

test("a missing verdict throws", () => {
  assert.throws(() => resolveDistillationVerdict("", null), /missing 'distillation_verdict'/);
  assert.throws(() => resolveDistillationVerdict(null, null), /missing 'distillation_verdict'/);
});

test("DUPLICATE_OF is matched exactly, not as a substring of another verdict", () => {
  assert.throws(() => resolveDistillationVerdict("NOT_DUPLICATE_OF", null), /unknown distillation_verdict/);
});

test("the verdict is trimmed before it is matched", () => {
  const r = resolveDistillationVerdict("  DUPLICATE_OF  ", TREND);
  assert.equal(r.verdict, "DUPLICATE_OF");
  assert.equal(r.isDuplicateOf, true);
});

// ── Target sanitizing ──────────────────────────────────────────────────

test("an unusable target is dropped rather than passed through", () => {
  const r = resolveDistillationVerdict("DUPLICATE_OF", "not a valid id!");
  assert.equal(r.isDuplicateOf, true);
  assert.equal(r.dedupTarget, null);
});

test("a DUPLICATE_OF with no target anywhere resolves with a null target", () => {
  // It must NOT throw. Throwing is what stuck cand-7jl1o8r7mt8quxk5 in a
  // retry loop: the subagent died before writing PROMOTED_AT or REJECTED_AT,
  // which is the exact condition the lead re-dispatches on.
  const r = resolveDistillationVerdict("DUPLICATE_OF", null);
  assert.equal(r.isDuplicateOf, true);
  assert.equal(r.dedupTarget, null);
});

// ── promptVerdict: what the system prompt is keyed on ──────────────────
// sql/seed_prompts_promotion.sql routes on "starts with 'DUPLICATE_OF_'",
// so the prompt gets the canonical concatenated form whenever a target is
// known. The raw verdict is preserved separately for the audit ledger.

test("promptVerdict renders the canonical prefixed form when a target is known", () => {
  const r = resolveDistillationVerdict("DUPLICATE_OF", TREND);
  assert.equal(r.promptVerdict, `DUPLICATE_OF_${TREND}`);
  assert.equal(r.verdict, "DUPLICATE_OF", "raw verdict is preserved for the audit ledger");
});

test("promptVerdict routes a targetless duplicate with the UNKNOWN sentinel", () => {
  // The rubric has four branches: == 'REAL_TREND', starts with
  // 'DUPLICATE_OF_', in ('NOISE','CATEGORY_TOO_BROAD'), and a DEFER
  // catch-all. A bare "DUPLICATE_OF" matches none of the first three, so it
  // would land on the catch-all and burn its 3 defers before a forced
  // REJECT. The sentinel still starts with the prefix, so the duplicate
  // branch fires and the agent is told to find the target itself.
  const r = resolveDistillationVerdict("DUPLICATE_OF", null);
  assert.equal(r.promptVerdict, "DUPLICATE_OF_UNKNOWN");
  assert.ok(r.promptVerdict.startsWith("DUPLICATE_OF_"), "must match the rubric branch");
  assert.equal(r.dedupTarget, null, "no target is invented");
  assert.equal(r.verdict, "DUPLICATE_OF", "raw verdict is still preserved for the audit ledger");
});

test("an unusable target also routes with the sentinel, never the bad value", () => {
  const r = resolveDistillationVerdict("DUPLICATE_OF", "not a valid id!");
  assert.equal(r.promptVerdict, "DUPLICATE_OF_UNKNOWN");
  assert.equal(r.dedupTarget, null);
});

test("every accepted verdict yields a promptVerdict that matches a rubric branch", () => {
  const matches = (pv) =>
    pv === "REAL_TREND" || pv.startsWith("DUPLICATE_OF_") || ["NOISE", "CATEGORY_TOO_BROAD"].includes(pv);
  const cases = [
    ["REAL_TREND", null], ["NOISE", null], ["CATEGORY_TOO_BROAD", null],
    ["DUPLICATE_OF", TREND], ["DUPLICATE_OF", null], ["DUPLICATE_OF", "bad id!"],
    [`DUPLICATE_OF_${TREND}`, null],
  ];
  for (const [v, t] of cases) {
    const r = resolveDistillationVerdict(v, t);
    assert.ok(matches(r.promptVerdict), `promptVerdict ${r.promptVerdict} (from ${v}) matches no rubric branch`);
  }
});

test("promptVerdict is the plain verdict for non-duplicate verdicts", () => {
  assert.equal(resolveDistillationVerdict("REAL_TREND", null).promptVerdict, "REAL_TREND");
  assert.equal(resolveDistillationVerdict("NOISE", null).promptVerdict, "NOISE");
});
