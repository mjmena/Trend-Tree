// PROTOTYPE (CRMA-438) — unit tests over the prompt builders extracted from
// the step entrypoint. These were inline in Pipedream's run() and untestable
// without a deploy; extracted, they take plain rows and return strings.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompts,
  buildTrendSummaryBlock,
  formatTopSignals,
  formatNeighbors,
  normalizeNeighborPool,
} from "../src/lib/context.mjs";
import { render } from "../src/lib/prompt_loader.mjs";

const metricsRow = {
  TREND_ID: "t-1",
  TREND_TOPIC: "protein sparkling water",
  TOTAL_CLUSTER_SIZE: 12,
  DISTINCT_SOURCE_COUNT: 4,
  TREND_HEAT_INDEX: 71.5,
  VELOCITY_DIRECTION: "GROWING",
  DETECTED_AT: "2026-08-01T00:00:00Z",
  LAST_UPDATE_AT: "2026-08-07T00:00:00Z",
};

const promptRows = [
  { PROMPT_KEY: "enrichment.agent.system", VERSION: 9, MODEL: "gemini", TEMPLATE: "SYSTEM for:\n{{trend_summary_block}}", MODEL_PARAMS: "{}" },
  { PROMPT_KEY: "enrichment.agent.naming_guidance", VERSION: 4, MODEL: "gemini", TEMPLATE: "NAMING RULES", MODEL_PARAMS: "{}" },
  { PROMPT_KEY: "enrichment.agent.user", VERSION: 7, MODEL: "gemini", TEMPLATE: "META {{trend_metadata_json}}\nSIGNALS:\n{{top_signals_formatted}}\nDATE {{current_date}}", MODEL_PARAMS: "{}" },
];

test("trend summary block carries topic, heat, and velocity", () => {
  const block = buildTrendSummaryBlock(metricsRow, "t-1");
  assert.match(block, /TREND_TOPIC: protein sparkling water/);
  assert.match(block, /HEAT_INDEX: 71.5 \| CLUSTER_SIZE: 12 \| VELOCITY: GROWING/);
});

test("signal formatting includes body snippet only when present", () => {
  const rows = [
    { DOMAIN: "example.com", TITLE: "A", URL: "https://example.com/a", ARTICLE_BODY: "word ".repeat(200) },
    { DOMAIN: "b.com", TITLE: "B", URL: "https://b.com/b", ARTICLE_BODY: "" },
  ];
  const out = formatTopSignals(rows);
  assert.match(out, /1\. \[example\.com\] A — https:\/\/example\.com\/a\n\s+body: "/);
  assert.match(out, /2\. \[b\.com\] B — https:\/\/b\.com\/b$/m);
  assert.ok(!/2\..*body:/s.test(out.split("\n").slice(-1)[0]));
});

test("neighbor formatting falls back from trend_name to topic", () => {
  const pool = normalizeNeighborPool([
    { TREND_ID: "n1", TREND_TOPIC: "topic one", TREND_NAME: "Named One", CATEGORY: "wellness", SUBCATEGORY: "sleep", TREND_HEAT_INDEX: 50 },
    { TREND_ID: "n2", TREND_TOPIC: "topic two", TREND_NAME: null, TREND_NAME_B2C: null, CATEGORY: null, SUBCATEGORY: null, TREND_HEAT_INDEX: null },
  ]);
  const out = formatNeighbors(pool);
  assert.match(out, /1\. "Named One" — wellness\/sleep \(heat 50\)/);
  assert.match(out, /2\. "topic two" — \?\/\? \(heat \?\)/);
});

test("buildPrompts renders system+naming concat and fills user vars", () => {
  const { renderedSystem, renderedUser } = buildPrompts({
    prompts_rows: promptRows,
    metricsRow,
    trend_id: "t-1",
    signal_rows: [],
    source_metrics_pool: [],
    trend_neighbor_pool: [],
    now: new Date("2026-08-08T12:00:00Z"),
  });
  assert.match(renderedSystem, /SYSTEM for:\nTREND_TOPIC: protein sparkling water/);
  assert.match(renderedSystem, /NAMING RULES$/);
  assert.match(renderedUser, /"trend_topic":"protein sparkling water"/);
  assert.match(renderedUser, /SIGNALS:\n\(no signals\)/);
  assert.match(renderedUser, /DATE 2026-08-08/);
});

test("buildPrompts throws when an active prompt row is missing", () => {
  assert.throws(
    () => buildPrompts({ prompts_rows: promptRows.slice(0, 2), metricsRow, trend_id: "t-1", signal_rows: [], source_metrics_pool: [], trend_neighbor_pool: [] }),
    /enrichment\.agent\.user not found/,
  );
});

test("render leaves unknown vars empty and tolerates dotted keys", () => {
  assert.equal(render("a {{missing}} b", {}), "a  b");
  assert.equal(render("x {{a.b}} y", { "a.b": "Z" }), "x Z y");
});
