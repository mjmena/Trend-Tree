// Each test isolates one factor of 25*recency + 25*velocity + 40*breadth + 10*confidence.
// Expected values are worked by hand, not recomputed with the formula.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHeatBase } from "./lifecycle_context.mjs";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const heat = ({ confidence, domains = {}, signalAgesH = [] } = {}) =>
  computeHeatBase(
    {
      metrics: { confidence },
      signal_domain_counts: domains,
      recent_signals: signalAgesH.map((h) => ({ signal_timestamp: hoursAgo(h) })),
    },
    NOW,
  );

test("recency decays with a 120h half-life from the newest linked signal", () => {
  assert.equal(heat({ signalAgesH: [0] }).components.recency_factor, 1);
  // 240h = 2 half-lives of exp(-h/120): e^-2 = 0.1353
  assert.equal(heat({ signalAgesH: [240] }).components.recency_factor, 0.135);
  assert.equal(heat({ signalAgesH: [] }).components.recency_factor, 0);
});

test("velocity is linear in linked signals over 7 days and saturates at 3", () => {
  assert.equal(heat({ signalAgesH: [] }).components.velocity_factor, 0);
  assert.equal(heat({ signalAgesH: [1] }).components.velocity_factor, 0.333);
  assert.equal(heat({ signalAgesH: [1, 2, 3] }).components.velocity_factor, 1);
  assert.equal(heat({ signalAgesH: [1, 2, 3, 4, 5, 6] }).components.velocity_factor, 1);
  // 8 days old is outside the window
  assert.equal(heat({ signalAgesH: [1, 192] }).components.velocity_factor, 0.333);
});

test("breadth is log-publishers times entropy, 1.0 at 6 even domains", () => {
  assert.equal(heat({ domains: {} }).components.breadth_factor, 0);
  assert.equal(heat({ domains: { "a.com": 9 } }).components.breadth_factor, 0);
  const six = { a: 2, b: 2, c: 2, d: 2, e: 2, f: 2 };
  assert.equal(heat({ domains: six }).components.breadth_factor, 1);
  // 2 even domains: (log2(2) - 0.5) / (log2(6) - 0.5) = 0.5 / 2.085 = 0.240
  assert.equal(heat({ domains: { a: 4, b: 4 } }).components.breadth_factor, 0.24);
  // 3:1 split: entropy 0.811, so 0.2398 * 0.811 = 0.195
  assert.equal(heat({ domains: { a: 3, b: 1 } }).components.breadth_factor, 0.195);
});

test("confidence comes from the trend, defaulting to 0.5 when missing", () => {
  assert.equal(heat({ confidence: 0.8 }).components.confidence, 0.8);
  assert.equal(heat({ confidence: null }).components.confidence, 0.5);
  assert.equal(heat({}).heat_base, 5); // 10 * 0.5, nothing else scores
});

test("heat_base weights the factors 25/25/40/10 and rounds to one decimal", () => {
  const six = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 };
  // 25*1 + 25*(1/3) + 40*1 + 10*0.8 = 81.333
  assert.equal(heat({ confidence: 0.8, domains: six, signalAgesH: [0] }).heat_base, 81.3);
});
