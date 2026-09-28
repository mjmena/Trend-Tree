// catalog_sync.mjs — one live catalog sweep, storefront feed ->
// DIM_CATALOG_PRODUCT (CRMA-777). services/catalog-sync/sync.mjs is the
// Cloud Run job's entrypoint and supplies the two I/O functions; everything
// between them is here so it runs under node:test without a network.
//
//   fetchProducts() -> { products, pages }   (storefront_feed.mjs)
//   query(sql, binds?) -> rows               (one Snowflake statement)
//
// The order is the safety property. The whole feed is fetched and normalized
// BEFORE the first Snowflake statement, so a feed failure writes nothing. And
// upserts land before delists, so a run that dies half-way leaves products
// un-delisted (harmless — the next sweep delists them), never wrongly
// delisted.
//
// LAST_SEEN_AT comes from Snowflake's clock, not Node's. The column is
// TIMESTAMP_NTZ, and the audit agent grades it with
// TIMESTAMPDIFF(MINUTE, LAST_SEEN_AT, CURRENT_TIMESTAMP()) — a session-time
// comparison. A UTC wall-clock stamp from Node lands hours in the future
// under an America/New_York session, and the audit grades a future
// LAST_SEEN_AT as RED (catalog_freshness.mjs).

import { buildDelistBatchSql, buildUpsertBatchSql, chunk, SELECT_EXISTING_SQL } from "./catalog_sql.mjs";
import { normalizeStorefrontProducts, planCatalogUpsert } from "./catalog_transform.mjs";

const SWEEP_AT_SQL = `SELECT TO_VARCHAR(CURRENT_TIMESTAMP()::TIMESTAMP_NTZ, 'YYYY-MM-DD HH24:MI:SS.FF3') AS SWEEP_AT`;

// Fixed, not a parameter: normalizeStorefrontProducts stamps every product
// 'shopify', and the delist plan is "existing rows of THIS tier not seen".
// Reading any other tier's rows would plan all of them for delisting.
const TIER = "shopify";

export async function runCatalogSync({ fetchProducts, query, batchSize = 40 }) {
  const tier = TIER;
  const feed = await fetchProducts();
  const normalized = normalizeStorefrontProducts(feed.products);
  if (normalized.length === 0) {
    throw new Error(`storefront feed returned ${feed.products.length} products but no product with a handle — refusing to sweep`);
  }

  const [{ SWEEP_AT: sweepAt }] = await query(SWEEP_AT_SQL);
  const existing = (await query(SELECT_EXISTING_SQL, [tier])).map((r) => ({
    tier: r.TIER,
    catalogProductId: r.CATALOG_PRODUCT_ID,
    embedDocHash: r.EMBED_DOC_HASH,
    embedDocVersion: r.EMBED_DOC_VERSION,
    catalogStatus: r.CATALOG_STATUS,
  }));

  const plan = planCatalogUpsert(normalized, existing, { asOf: sweepAt });

  for (const batch of chunk(plan.upserts, batchSize)) {
    await query(buildUpsertBatchSql(batch, sweepAt));
  }
  for (const batch of chunk(plan.delists, batchSize)) {
    await query(buildDelistBatchSql(batch));
  }

  return {
    tier,
    sweepAt,
    feedPages: feed.pages,
    feedProducts: normalized.length,
    upserted: plan.upserts.length,
    unchanged: plan.upserts.length - plan.toEmbed.length,
    embedded: plan.toEmbed.map((u) => u.catalogProductId),
    delisted: plan.delists.map((d) => d.catalogProductId),
  };
}
