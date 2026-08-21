// Tests for the ecomm-agent sourcing-run core (CRMA-776, epic CRMA-772).
// Run: node --test agents/lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEMANTIC_THRESHOLD,
  TOP_N,
  MAX_SOURCED_PRODUCTS,
  CATALOG_FRESHNESS_MAX_DAYS,
  CANDIDATE_EMBED_DOC_CAP,
  checkCatalogFreshness,
  applyFloorAndTopN,
  capEmbedDoc,
  formatCandidatesForPrompt,
  buildSourcingRunPlan,
} from "./sourcing_run.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cand = (over = {}) => ({
  catalog_product_id: "prod-1",
  product_handle: "prod-1",
  product_title: "Test Product",
  product_type: "Skincare",
  vendor: "Acme",
  product_url: null,
  price_at_match: null,
  image_url_at_match: null,
  available_at_match: null,
  semantic_score: 0.5,
  embed_doc: "A test product embed doc.",
  catalog_payload: null,
  ...over,
});

// A faked Gemini propose_product_selection emission — no live API call.
const emit = (over = {}) => ({
  outcome: "matched",
  picks: [],
  pool_note: "one strong match",
  ...over,
});

// ---------------------------------------------------------------------------
// Constants sanity (the AC calls out MAX_SOURCED_PRODUCTS=5 must be a named,
// findable constant for the future multi-tier top-up story).
// ---------------------------------------------------------------------------

test("constants match the settled Shopify-tier contract", () => {
  assert.equal(SEMANTIC_THRESHOLD, 0.40);
  assert.equal(TOP_N, 10);
  assert.equal(MAX_SOURCED_PRODUCTS, 5);
  assert.equal(CATALOG_FRESHNESS_MAX_DAYS, 7);
  assert.equal(CANDIDATE_EMBED_DOC_CAP, 700);
});

// ---------------------------------------------------------------------------
// checkCatalogFreshness — the 7-day decline gate
// ---------------------------------------------------------------------------

test("checkCatalogFreshness: fresh catalog (today) passes", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  const r = checkCatalogFreshness("2026-08-21T00:00:00Z", { now });
  assert.equal(r.fresh, true);
  assert.equal(r.reason, null);
});

test("checkCatalogFreshness: exactly 7 days old is still fresh (inclusive floor)", () => {
  const now = new Date("2026-08-21T00:00:00Z");
  const r = checkCatalogFreshness("2026-08-14T00:00:00Z", { now });
  assert.equal(r.ageDays, 7);
  assert.equal(r.fresh, true);
});

test("checkCatalogFreshness: 8 days old declines with a reason", () => {
  const now = new Date("2026-08-21T00:00:00Z");
  const r = checkCatalogFreshness("2026-08-13T00:00:00Z", { now });
  assert.equal(r.fresh, false);
  assert.equal(r.ageDays, 8);
  assert.match(r.reason, /7-day freshness gate/);
});

test("checkCatalogFreshness: null MAX(LAST_SEEN_AT) (no active rows) declines", () => {
  const r = checkCatalogFreshness(null);
  assert.equal(r.fresh, false);
  assert.equal(r.ageDays, null);
  assert.match(r.reason, /no active rows/);
});

test("checkCatalogFreshness: unparseable timestamp declines rather than throwing", () => {
  const r = checkCatalogFreshness("not-a-date");
  assert.equal(r.fresh, false);
  assert.match(r.reason, /unparseable/);
});

// ---------------------------------------------------------------------------
// applyFloorAndTopN — defense-in-depth re-application
// ---------------------------------------------------------------------------

test("applyFloorAndTopN drops sub-floor candidates and sorts score-descending", () => {
  const pool = [cand({ catalog_product_id: "a", semantic_score: 0.39 }), cand({ catalog_product_id: "b", semantic_score: 0.55 }), cand({ catalog_product_id: "c", semantic_score: 0.41 })];
  const out = applyFloorAndTopN(pool);
  assert.deepEqual(out.map((c) => c.catalog_product_id), ["b", "c"]);
});

test("applyFloorAndTopN caps at TOP_N even if the caller handed more", () => {
  const pool = Array.from({ length: 15 }, (_, i) => cand({ catalog_product_id: `p${i}`, semantic_score: 0.9 - i * 0.01 }));
  const out = applyFloorAndTopN(pool);
  assert.equal(out.length, 10);
  assert.equal(out[0].catalog_product_id, "p0");
});

test("applyFloorAndTopN treats non-finite/missing scores as excluded, not crashing", () => {
  const pool = [cand({ catalog_product_id: "a", semantic_score: NaN }), cand({ catalog_product_id: "b", semantic_score: undefined }), cand({ catalog_product_id: "c", semantic_score: 0.5 })];
  const out = applyFloorAndTopN(pool);
  assert.deepEqual(out.map((c) => c.catalog_product_id), ["c"]);
});

test("applyFloorAndTopN handles empty/undefined pool", () => {
  assert.deepEqual(applyFloorAndTopN([]), []);
  assert.deepEqual(applyFloorAndTopN(undefined), []);
});

// ---------------------------------------------------------------------------
// capEmbedDoc / formatCandidatesForPrompt — no raw scores shown to the model
// ---------------------------------------------------------------------------

test("capEmbedDoc truncates at 700 chars by default", () => {
  const long = "x".repeat(900);
  assert.equal(capEmbedDoc(long).length, 700);
});

test("capEmbedDoc leaves a short doc untouched", () => {
  assert.equal(capEmbedDoc("short doc"), "short doc");
});

test("formatCandidatesForPrompt never leaks semantic_score into the rendered text", () => {
  const pool = [cand({ catalog_product_id: "a", semantic_score: 0.8734, embed_doc: "Doc A." })];
  const out = formatCandidatesForPrompt(pool);
  assert.match(out, /catalog_product_id: a/);
  assert.match(out, /Doc A\./);
  assert.doesNotMatch(out, /0\.8734/);
  assert.doesNotMatch(out, /semantic_score/);
});

// ---------------------------------------------------------------------------
// buildSourcingRunPlan — empty pool short-circuit
// ---------------------------------------------------------------------------

test("empty pool short-circuits to no_match without needing a selector emission", () => {
  const plan = buildSourcingRunPlan({ pool: [], selectorEmit: null });
  assert.equal(plan.outcome, "no_match");
  assert.equal(plan.candidates.length, 0);
  assert.match(plan.selector_note, /zero candidates/);
  assert.equal(plan.error_message, null);
});

test("a pool that's entirely below the floor also short-circuits to no_match", () => {
  const pool = [cand({ semantic_score: 0.2 }), cand({ catalog_product_id: "p2", semantic_score: 0.1 })];
  const plan = buildSourcingRunPlan({ pool, selectorEmit: null });
  assert.equal(plan.outcome, "no_match");
  assert.equal(plan.candidates.length, 0);
});

// ---------------------------------------------------------------------------
// buildSourcingRunPlan — normal matched case
// ---------------------------------------------------------------------------

test("normal matched case: picked candidate is SELECTED=true with its fit/rationale, rejects carry SELECTED=false and NULL REASONED_FIT", () => {
  const pool = [
    cand({ catalog_product_id: "picked-one", semantic_score: 0.71, product_title: "Whipped Tallow Balm" }),
    cand({ catalog_product_id: "rejected-one", semantic_score: 0.42, product_title: "Shea Butter Lotion" }),
  ];
  const selectorEmit = emit({
    outcome: "matched",
    picks: [{ catalog_product_id: "picked-one", reasoned_fit: "strong", rationale: "Direct tallow-based skincare match for the trend." }],
    pool_note: "one strong tallow match, one adjacent reject",
  });
  const plan = buildSourcingRunPlan({ pool, selectorEmit });

  assert.equal(plan.outcome, "matched");
  assert.equal(plan.error_message, null);
  assert.equal(plan.selector_note, "one strong tallow match, one adjacent reject");
  assert.equal(plan.candidates.length, 2);

  const picked = plan.candidates.find((c) => c.catalog_product_id === "picked-one");
  assert.equal(picked.selected, true);
  assert.equal(picked.reasoned_fit, "strong");
  assert.equal(picked.rationale, undefined); // field is reasoned_fit_rationale, not rationale
  assert.equal(picked.reasoned_fit_rationale, "Direct tallow-based skincare match for the trend.");
  assert.equal(picked.semantic_score, 0.71);

  const rejected = plan.candidates.find((c) => c.catalog_product_id === "rejected-one");
  assert.equal(rejected.selected, false);
  assert.equal(rejected.reasoned_fit, null);
  assert.equal(rejected.reasoned_fit_rationale, null);
  assert.equal(rejected.semantic_score, 0.42);
});

// ---------------------------------------------------------------------------
// buildSourcingRunPlan — no_match (selector-emitted, non-empty pool)
// ---------------------------------------------------------------------------

test("selector-emitted no_match on a non-empty pool: zero candidates, note preserved", () => {
  const pool = [cand({ catalog_product_id: "a", semantic_score: 0.45 })];
  const selectorEmit = emit({ outcome: "no_match", picks: [], pool_note: "shares only the category, not the behavior" });
  const plan = buildSourcingRunPlan({ pool, selectorEmit });
  assert.equal(plan.outcome, "no_match");
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.selector_note, "shares only the category, not the behavior");
});

test("no_match with a blank pool_note falls back to a default note (SELECTOR_NOTE must never be empty)", () => {
  const pool = [cand({ semantic_score: 0.45 })];
  const selectorEmit = emit({ outcome: "no_match", picks: [], pool_note: "   " });
  const plan = buildSourcingRunPlan({ pool, selectorEmit });
  assert.equal(plan.outcome, "no_match");
  assert.match(plan.selector_note, /no candidate/i);
});

// ---------------------------------------------------------------------------
// buildSourcingRunPlan — hallucinated catalog_product_id
// ---------------------------------------------------------------------------

test("a hallucinated catalog_product_id (not in the shown pool) is dropped and flagged, never silently trusted", () => {
  const pool = [cand({ catalog_product_id: "real-one", semantic_score: 0.6 })];
  const selectorEmit = emit({
    outcome: "matched",
    picks: [
      { catalog_product_id: "real-one", reasoned_fit: "strong", rationale: "fine" },
      { catalog_product_id: "made-up-id", reasoned_fit: "strong", rationale: "should never land" },
    ],
  });
  const plan = buildSourcingRunPlan({ pool, selectorEmit });

  assert.equal(plan.outcome, "matched");
  assert.equal(plan.candidates.length, 1); // only the real pool member is ever a row
  assert.equal(plan.candidates[0].catalog_product_id, "real-one");
  assert.equal(plan.candidates[0].selected, true);
  assert.ok(plan.warnings.some((w) => w.startsWith("hallucinated_pick:made-up-id")));
});

test("outcome=matched where EVERY pick is hallucinated fails loudly instead of masquerading as no_match", () => {
  const pool = [cand({ catalog_product_id: "real-one", semantic_score: 0.6 })];
  const selectorEmit = emit({
    outcome: "matched",
    picks: [{ catalog_product_id: "totally-made-up", reasoned_fit: "strong", rationale: "x" }],
  });
  const plan = buildSourcingRunPlan({ pool, selectorEmit });
  assert.equal(plan.outcome, "failed");
  assert.match(plan.error_message, /every pick was invalid/);
  assert.equal(plan.candidates.length, 0);
});

// ---------------------------------------------------------------------------
// buildSourcingRunPlan — invalid reasoned_fit enum value
// ---------------------------------------------------------------------------

test("an invalid reasoned_fit enum value is dropped and flagged", () => {
  const pool = [cand({ catalog_product_id: "a", semantic_score: 0.6 }), cand({ catalog_product_id: "b", semantic_score: 0.55 })];
  const selectorEmit = emit({
    outcome: "matched",
    picks: [
      { catalog_product_id: "a", reasoned_fit: "amazing", rationale: "not a valid enum value" },
      { catalog_product_id: "b", reasoned_fit: "partial", rationale: "valid" },
    ],
  });
  const plan = buildSourcingRunPlan({ pool, selectorEmit });

  assert.equal(plan.outcome, "matched");
  assert.equal(plan.candidates.length, 2);
  const a = plan.candidates.find((c) => c.catalog_product_id === "a");
  const b = plan.candidates.find((c) => c.catalog_product_id === "b");
  assert.equal(a.selected, false); // invalid enum -> treated as not picked
  assert.equal(a.reasoned_fit, null);
  assert.equal(b.selected, true);
  assert.equal(b.reasoned_fit, "partial");
  assert.ok(plan.warnings.some((w) => w.startsWith('invalid_reasoned_fit:a:"amazing"')));
});

// ---------------------------------------------------------------------------
// buildSourcingRunPlan — picks exceeding the slots cap
// ---------------------------------------------------------------------------

test("a picks list exceeding the slots cap is truncated to `slots`, not rejected outright", () => {
  const pool = Array.from({ length: 6 }, (_, i) => cand({ catalog_product_id: `p${i}`, semantic_score: 0.9 - i * 0.05 }));
  const selectorEmit = emit({
    outcome: "matched",
    picks: pool.map((c) => ({ catalog_product_id: c.catalog_product_id, reasoned_fit: "strong", rationale: "ok" })),
  });
  const plan = buildSourcingRunPlan({ pool, selectorEmit, slots: MAX_SOURCED_PRODUCTS });

  assert.equal(plan.outcome, "matched");
  const selected = plan.candidates.filter((c) => c.selected);
  assert.equal(selected.length, MAX_SOURCED_PRODUCTS);
  // The first `slots` picks in emission order win; the 6th is dropped.
  assert.deepEqual(selected.map((c) => c.catalog_product_id), ["p0", "p1", "p2", "p3", "p4"]);
  const rejectedButShown = plan.candidates.find((c) => c.catalog_product_id === "p5");
  assert.equal(rejectedButShown.selected, false);
  assert.ok(plan.warnings.some((w) => w.startsWith("picks_exceeded_slots:dropped_1")));
});

test("respects a custom (smaller) slots value, e.g. a future top-up call with fewer slots remaining", () => {
  const pool = Array.from({ length: 10 }, (_, i) => cand({ catalog_product_id: `p${i}`, semantic_score: 0.9 - i * 0.01 }));
  const selectorEmit = emit({
    outcome: "matched",
    picks: pool.slice(0, 5).map((c) => ({ catalog_product_id: c.catalog_product_id, reasoned_fit: "strong", rationale: "ok" })),
  });
  const plan = buildSourcingRunPlan({ pool, selectorEmit, slots: 2 });
  assert.equal(plan.candidates.filter((c) => c.selected).length, 2);
});

// ---------------------------------------------------------------------------
// buildSourcingRunPlan — other malformed-emission cases -> failed
// ---------------------------------------------------------------------------

test("missing/null selector emission on a non-empty pool -> failed", () => {
  const pool = [cand({ semantic_score: 0.6 })];
  const plan = buildSourcingRunPlan({ pool, selectorEmit: null });
  assert.equal(plan.outcome, "failed");
  assert.match(plan.error_message, /no usable emission/);
});

test("selector emission with an invalid outcome value -> failed", () => {
  const pool = [cand({ semantic_score: 0.6 })];
  const plan = buildSourcingRunPlan({ pool, selectorEmit: emit({ outcome: "maybe" }) });
  assert.equal(plan.outcome, "failed");
  assert.match(plan.error_message, /invalid outcome/);
});

test("outcome=matched with an empty picks array -> failed (should have been no_match)", () => {
  const pool = [cand({ semantic_score: 0.6 })];
  const plan = buildSourcingRunPlan({ pool, selectorEmit: emit({ outcome: "matched", picks: [] }) });
  assert.equal(plan.outcome, "failed");
  assert.match(plan.error_message, /empty picks list/);
});

test("a duplicated catalog_product_id in picks is deduped, not double-counted", () => {
  const pool = [cand({ catalog_product_id: "a", semantic_score: 0.6 })];
  const selectorEmit = emit({
    outcome: "matched",
    picks: [
      { catalog_product_id: "a", reasoned_fit: "strong", rationale: "first" },
      { catalog_product_id: "a", reasoned_fit: "weak", rationale: "duplicate" },
    ],
  });
  const plan = buildSourcingRunPlan({ pool, selectorEmit });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].reasoned_fit, "strong"); // first occurrence wins
  assert.ok(plan.warnings.some((w) => w.startsWith("duplicate_pick:a")));
});

test("an overlong rationale is trimmed, not rejected", () => {
  const pool = [cand({ catalog_product_id: "a", semantic_score: 0.6 })];
  const longRationale = "word ".repeat(200);
  const plan = buildSourcingRunPlan({
    pool,
    selectorEmit: emit({ outcome: "matched", picks: [{ catalog_product_id: "a", reasoned_fit: "strong", rationale: longRationale }] }),
  });
  assert.equal(plan.outcome, "matched");
  assert.ok(plan.candidates[0].reasoned_fit_rationale.length <= 400);
});

// ---------------------------------------------------------------------------
// End-to-end-ish: defense-in-depth floor/TOP_N applies even when the
// caller's pool wasn't pre-filtered (a retrieval-step bug shouldn't leak a
// sub-floor product into the selector's view or the ledger).
// ---------------------------------------------------------------------------

test("buildSourcingRunPlan re-applies the floor even if the caller handed an unfiltered pool", () => {
  const pool = [
    cand({ catalog_product_id: "above", semantic_score: 0.5 }),
    cand({ catalog_product_id: "below", semantic_score: 0.1 }),
  ];
  const selectorEmit = emit({
    outcome: "matched",
    // The model was never shown "below" in a correct implementation, but
    // even if it echoed it, it wouldn't matter here: "below" never enters
    // poolById because applyFloorAndTopN excludes it up front.
    picks: [{ catalog_product_id: "above", reasoned_fit: "strong", rationale: "ok" }],
  });
  const plan = buildSourcingRunPlan({ pool, selectorEmit });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].catalog_product_id, "above");
});
