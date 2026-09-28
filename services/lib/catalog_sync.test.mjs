// Tests for the live catalog sweep's orchestration (CRMA-777).
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCatalogSync } from "./catalog_sync.mjs";
import { buildEmbedDoc, EMBED_DOC_VERSION, hashEmbedDoc, normalizeStorefrontProducts } from "./catalog_transform.mjs";
import { StorefrontFeedError } from "./storefront_feed.mjs";

const SWEEP_AT = "2026-09-28 09:00:00.123";

const feedProduct = (handle, title = handle) => ({
  handle,
  title,
  vendor: "Acme",
  product_type: "Mugs",
  tags: ["kitchen"],
  body_html: "<p>x</p>",
});

const seededRow = (product, status = "active") => {
  const [n] = normalizeStorefrontProducts([product]);
  return {
    TIER: "shopify",
    CATALOG_PRODUCT_ID: n.catalogProductId,
    EMBED_DOC_HASH: hashEmbedDoc(buildEmbedDoc(n)),
    EMBED_DOC_VERSION: EMBED_DOC_VERSION,
    CATALOG_STATUS: status,
  };
};

// A fake Snowflake: answers the sweep-time read and the existing-rows read,
// records every statement in order.
function fakeQuery(existingRows) {
  const statements = [];
  const query = async (sql, binds) => {
    statements.push({ sql, binds });
    if (/AS SWEEP_AT/.test(sql)) return [{ SWEEP_AT }];
    if (/^SELECT TIER, CATALOG_PRODUCT_ID/.test(sql)) return existingRows;
    return [{ "number of rows updated": 1 }];
  };
  return { query, statements };
}

test("a feed failure writes nothing — not even a read of the dimension", async () => {
  const { query, statements } = fakeQuery([]);
  const fetchProducts = async () => {
    throw new StorefrontFeedError("HTTP 401 on page 1");
  };
  await assert.rejects(runCatalogSync({ fetchProducts, query }), /HTTP 401/);
  assert.equal(statements.length, 0);
});

test("a feed whose products all lack a handle is a hard failure, not a sweep that delists everything", async () => {
  const { query, statements } = fakeQuery([seededRow(feedProduct("a"))]);
  const fetchProducts = async () => ({ products: [{ title: "no handle" }], pages: 2 });
  await assert.rejects(runCatalogSync({ fetchProducts, query }), /no product with a handle/);
  assert.equal(statements.length, 0);
});

test("stamps LAST_SEEN_AT with Snowflake's own clock, read once per sweep", async () => {
  const { query, statements } = fakeQuery([]);
  const fetchProducts = async () => ({ products: [feedProduct("a"), feedProduct("b")], pages: 2 });
  const summary = await runCatalogSync({ fetchProducts, query });
  assert.equal(summary.sweepAt, SWEEP_AT);
  assert.equal(statements.filter((s) => /AS SWEEP_AT/.test(s.sql)).length, 1);
  const merges = statements.filter((s) => /^MERGE/.test(s.sql));
  assert.ok(merges.every((m) => m.sql.includes(`TO_TIMESTAMP_NTZ('${SWEEP_AT}')`)));
});

test("unchanged products only touch LAST_SEEN_AT; an edited one re-embeds; a missing one is delisted", async () => {
  const unchanged = feedProduct("same");
  const existing = [
    seededRow(unchanged),
    seededRow(feedProduct("edited", "Old title")),
    seededRow(feedProduct("gone")),
    seededRow(feedProduct("already-gone"), "delisted"),
  ];
  const { query, statements } = fakeQuery(existing);
  const fetchProducts = async () => ({
    products: [unchanged, feedProduct("edited", "New title"), feedProduct("brand-new")],
    pages: 2,
  });

  const summary = await runCatalogSync({ fetchProducts, query });

  assert.deepEqual(summary, {
    tier: "shopify",
    sweepAt: SWEEP_AT,
    feedPages: 2,
    feedProducts: 3,
    upserted: 3,
    unchanged: 1,
    embedded: ["edited", "brand-new"],
    delisted: ["gone"],
  });

  const upsert = statements.find((s) => /^MERGE/.test(s.sql) && /NEEDS_EMBED/.test(s.sql)).sql;
  assert.match(upsert, /'same'.*FALSE,/);
  assert.match(upsert, /'edited'.*TRUE,/);
  const delist = statements.find((s) => /'delisted'/.test(s.sql)).sql;
  assert.match(delist, /'gone'/);
  assert.doesNotMatch(delist, /'already-gone'/);
});

test("reads the dimension for its tier only, and writes upserts before delists in batches", async () => {
  const existing = [seededRow(feedProduct("gone-1")), seededRow(feedProduct("gone-2"))];
  const { query, statements } = fakeQuery(existing);
  const fetchProducts = async () => ({ products: ["a", "b", "c"].map((h) => feedProduct(h)), pages: 2 });

  await runCatalogSync({ fetchProducts, query, batchSize: 2 });

  const read = statements.find((s) => /^SELECT TIER, CATALOG_PRODUCT_ID/.test(s.sql));
  assert.deepEqual(read.binds, ["shopify"]);
  const kinds = statements.filter((s) => /^MERGE/.test(s.sql)).map((s) => (/'delisted'/.test(s.sql) ? "delist" : "upsert"));
  assert.deepEqual(kinds, ["upsert", "upsert", "delist"]);
});

test("no delist statement runs when nothing is missing", async () => {
  const a = feedProduct("a");
  const { query, statements } = fakeQuery([seededRow(a)]);
  await runCatalogSync({ fetchProducts: async () => ({ products: [a], pages: 2 }), query });
  assert.equal(statements.filter((s) => /'delisted'/.test(s.sql)).length, 0);
});
