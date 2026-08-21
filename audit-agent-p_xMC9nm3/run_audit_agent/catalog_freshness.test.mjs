// Tests for the CRMA-775 catalog-freshness grading helper.
// Run: node --test audit-agent-p_xMC9nm3/run_audit_agent/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GREEN_MAX_DAYS,
  YELLOW_MAX_DAYS,
  escalateStatus,
  gradeDaysSinceLastSeen,
  gradeCatalogFreshness,
  buildCatalogFreshnessBlock,
  applyCatalogFinding,
} from "./catalog_freshness.mjs";

// ---------------------------------------------------------------------------
// gradeDaysSinceLastSeen — the 3d / 7d boundary
// ---------------------------------------------------------------------------

test("thresholds are 3 and 7 days per the story's acceptance criteria", () => {
  assert.equal(GREEN_MAX_DAYS, 3);
  assert.equal(YELLOW_MAX_DAYS, 7);
});

test("gradeDaysSinceLastSeen: GREEN at and under 3 days", () => {
  assert.equal(gradeDaysSinceLastSeen(0), "GREEN");
  assert.equal(gradeDaysSinceLastSeen(1.4), "GREEN");
  assert.equal(gradeDaysSinceLastSeen(3), "GREEN");
});

test("gradeDaysSinceLastSeen: YELLOW strictly past 3 days, at or under 7", () => {
  assert.equal(gradeDaysSinceLastSeen(3.0001), "YELLOW");
  assert.equal(gradeDaysSinceLastSeen(4), "YELLOW");
  assert.equal(gradeDaysSinceLastSeen(7), "YELLOW");
});

test("gradeDaysSinceLastSeen: RED strictly past 7 days", () => {
  assert.equal(gradeDaysSinceLastSeen(7.0001), "RED");
  assert.equal(gradeDaysSinceLastSeen(30), "RED");
});

test("gradeDaysSinceLastSeen: null/undefined/NaN treated as RED, not silently GREEN", () => {
  assert.equal(gradeDaysSinceLastSeen(null), "RED");
  assert.equal(gradeDaysSinceLastSeen(undefined), "RED");
  assert.equal(gradeDaysSinceLastSeen(NaN), "RED");
});

// ---------------------------------------------------------------------------
// escalateStatus — worse-wins, never de-escalates
// ---------------------------------------------------------------------------

test("escalateStatus picks the worse of two statuses", () => {
  assert.equal(escalateStatus("GREEN", "YELLOW"), "YELLOW");
  assert.equal(escalateStatus("YELLOW", "GREEN"), "YELLOW");
  assert.equal(escalateStatus("YELLOW", "RED"), "RED");
  assert.equal(escalateStatus("RED", "GREEN"), "RED");
  assert.equal(escalateStatus("GREEN", "GREEN"), "GREEN");
});

// ---------------------------------------------------------------------------
// gradeCatalogFreshness — full row-shaped input
// ---------------------------------------------------------------------------

test("gradeCatalogFreshness: single fresh tier grades GREEN", () => {
  const g = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "2026-08-20T00:00:00", MINUTES_SINCE_LAST_SEEN: 2070, ACTIVE_PRODUCT_COUNT: 187 },
  ]);
  assert.equal(g.status, "GREEN");
  assert.equal(g.stale_tiers.length, 0);
  assert.equal(g.tiers[0].status, "GREEN");
});

test("gradeCatalogFreshness: a tier backdated 4 days grades YELLOW and is named", () => {
  const g = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "2026-08-17T00:00:00", MINUTES_SINCE_LAST_SEEN: 4 * 1440, ACTIVE_PRODUCT_COUNT: 187 },
  ]);
  assert.equal(g.status, "YELLOW");
  assert.deepEqual(g.stale_tiers, ["shopify"]);
  assert.equal(g.days_since_last_seen, 4);
});

test("gradeCatalogFreshness: a tier stale 8 days grades RED", () => {
  const g = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "x", MINUTES_SINCE_LAST_SEEN: 8 * 1440, ACTIVE_PRODUCT_COUNT: 187 },
  ]);
  assert.equal(g.status, "RED");
});

test("gradeCatalogFreshness: a dead second tier is not hidden by a healthy first tier", () => {
  const g = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "x", MINUTES_SINCE_LAST_SEEN: 60, ACTIVE_PRODUCT_COUNT: 187 },
    { TIER: "amazon", LAST_SEEN_AT_MAX: "y", MINUTES_SINCE_LAST_SEEN: 10 * 1440, ACTIVE_PRODUCT_COUNT: 50 },
  ]);
  assert.equal(g.status, "RED");
  assert.deepEqual(g.stale_tiers, ["amazon"]);
  assert.equal(g.tiers.find((t) => t.tier === "shopify").status, "GREEN");
});

test("gradeCatalogFreshness: no active rows at all grades RED, not silently GREEN", () => {
  const g = gradeCatalogFreshness([]);
  assert.equal(g.status, "RED");
  assert.equal(g.tiers.length, 0);
});

test("gradeCatalogFreshness: tolerates non-array input", () => {
  assert.equal(gradeCatalogFreshness(null).status, "RED");
  assert.equal(gradeCatalogFreshness(undefined).status, "RED");
});

// ---------------------------------------------------------------------------
// buildCatalogFreshnessBlock — narrative text block for the prompt
// ---------------------------------------------------------------------------

test("buildCatalogFreshnessBlock names the tier and status", () => {
  const g = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "x", MINUTES_SINCE_LAST_SEEN: 4 * 1440, ACTIVE_PRODUCT_COUNT: 187 },
  ]);
  const block = buildCatalogFreshnessBlock(g);
  assert.match(block, /shopify/);
  assert.match(block, /YELLOW/);
});

// ---------------------------------------------------------------------------
// applyCatalogFinding — the merge into the agent's report/JSON shape
// ---------------------------------------------------------------------------

test("applyCatalogFinding escalates overall_status and appends an alert when non-GREEN", () => {
  const base = { overall_status: "GREEN", alerts: [{ severity: "INFO", area: "ingestion", summary: "ok" }] };
  const graded = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "x", MINUTES_SINCE_LAST_SEEN: 4 * 1440, ACTIVE_PRODUCT_COUNT: 187 },
  ]);
  const merged = applyCatalogFinding(base, graded);
  assert.equal(merged.overall_status, "YELLOW");
  assert.equal(merged.alerts.length, 2);
  assert.equal(merged.catalog.status, "YELLOW");
  const catalogAlert = merged.alerts.find((a) => a.area === "catalog");
  assert.ok(catalogAlert, "expected a catalog alert to be appended");
  assert.equal(catalogAlert.severity, "WARN");
  assert.match(catalogAlert.summary, /shopify/);
});

test("applyCatalogFinding never de-escalates an already-worse overall_status", () => {
  const base = { overall_status: "RED", alerts: [{ severity: "RED", area: "enrichment", summary: "stalled" }] };
  const greenGraded = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "x", MINUTES_SINCE_LAST_SEEN: 60, ACTIVE_PRODUCT_COUNT: 187 },
  ]);
  const merged = applyCatalogFinding(base, greenGraded);
  assert.equal(merged.overall_status, "RED");
  assert.equal(merged.catalog.status, "GREEN");
});

test("applyCatalogFinding adds no alert when catalog is GREEN", () => {
  const base = { overall_status: "GREEN", alerts: [] };
  const greenGraded = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "x", MINUTES_SINCE_LAST_SEEN: 60, ACTIVE_PRODUCT_COUNT: 187 },
  ]);
  const merged = applyCatalogFinding(base, greenGraded);
  assert.equal(merged.alerts.length, 0);
  assert.equal(merged.overall_status, "GREEN");
});

test("applyCatalogFinding does not mutate the input report", () => {
  const base = { overall_status: "GREEN", alerts: [] };
  const graded = gradeCatalogFreshness([
    { TIER: "shopify", LAST_SEEN_AT_MAX: "x", MINUTES_SINCE_LAST_SEEN: 4 * 1440, ACTIVE_PRODUCT_COUNT: 187 },
  ]);
  applyCatalogFinding(base, graded);
  assert.equal(base.overall_status, "GREEN");
  assert.equal(base.alerts.length, 0);
});
