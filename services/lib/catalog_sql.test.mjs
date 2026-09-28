// Tests for the DIM_CATALOG_PRODUCT write-SQL builders shared by the CSV seed
// and the live catalog sync (CRMA-777).
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDelistBatchSql, buildUpsertBatchSql, DIM_TABLE, SELECT_EXISTING_SQL, sqlLiteral } from "./catalog_sql.mjs";
import { EMBED_MODEL } from "./catalog_transform.mjs";

const plan = (over = {}) => ({
  tier: "shopify",
  catalogProductId: "mug",
  title: "Mug",
  vendor: "Acme",
  type: "Mugs",
  tags: "kitchen, gift",
  embedDoc: "Mug. Type: Mugs. Vendor: Acme. Tags: kitchen, gift.",
  embedDocHash: "abc",
  embedDocVersion: "v1",
  needsEmbed: false,
  ...over,
});

test("sqlLiteral doubles quotes and escapes backslashes before them", () => {
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral("50% off\\"), "'50% off\\\\'");
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(undefined), "NULL");
});

test("buildUpsertBatchSql MERGEs every row and stamps LAST_SEEN_AT with the sweep time", () => {
  const sql = buildUpsertBatchSql([plan(), plan({ catalogProductId: "cup", needsEmbed: true })], "2026-09-28 09:00:00.000");
  assert.match(sql, new RegExp(`^MERGE INTO ${DIM_TABLE.replace(/\./g, "\\.")}`));
  assert.match(sql, /'mug'/);
  assert.match(sql, /'cup'/);
  assert.equal(sql.match(/TO_TIMESTAMP_NTZ\('2026-09-28 09:00:00\.000'\)/g).length, 2);
  assert.match(sql, /CATALOG_STATUS = 'active'/);
});

test("buildUpsertBatchSql re-embeds only rows flagged NEEDS_EMBED, keeping the old vector otherwise", () => {
  const sql = buildUpsertBatchSql([plan({ needsEmbed: false }), plan({ catalogProductId: "cup", needsEmbed: true })], "2026-09-28");
  assert.match(sql, /'mug'.*FALSE,/);
  assert.match(sql, /'cup'.*TRUE,/);
  assert.ok(
    sql.includes(
      `PRODUCT_VECTOR = CASE WHEN src.NEEDS_EMBED THEN SNOWFLAKE.CORTEX.EMBED_TEXT_1024('${EMBED_MODEL}', src.EMBED_DOC) ELSE tgt.PRODUCT_VECTOR END`,
    ),
  );
});

test("buildDelistBatchSql flips CATALOG_STATUS and never deletes", () => {
  const sql = buildDelistBatchSql([{ tier: "shopify", catalogProductId: "gone" }]);
  assert.match(sql, /'shopify','gone'/);
  assert.match(sql, /UPDATE SET CATALOG_STATUS = 'delisted'/);
  assert.doesNotMatch(sql, /DELETE/i);
});

test("SELECT_EXISTING_SQL reads the narrow projection the planner diffs against, for one bound tier", () => {
  for (const col of ["TIER", "CATALOG_PRODUCT_ID", "EMBED_DOC_HASH", "EMBED_DOC_VERSION", "CATALOG_STATUS"]) {
    assert.match(SELECT_EXISTING_SQL, new RegExp(`\\b${col}\\b`));
  }
  assert.match(SELECT_EXISTING_SQL, /WHERE TIER = \?/);
});
