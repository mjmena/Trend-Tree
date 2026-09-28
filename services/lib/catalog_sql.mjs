// catalog_sql.mjs — the DIM_CATALOG_PRODUCT write SQL, shared by the CSV seed
// (scripts/seed_catalog_from_csv.mjs, via the snow CLI) and the live catalog
// sync (services/catalog-sync, via snowflake-sdk). Moved out of the seed
// script by CRMA-777 so the two producers cannot drift apart on how a plan
// row lands — the same reason the planner itself is shared.
//
// Values are inlined as literals rather than bound: a batch MERGE over
// `VALUES` with 40 rows x 11 columns would need 440 positional binds, and the
// seed's snow CLI path has no bind support at all.

import { EMBED_MODEL } from "./catalog_transform.mjs";

export const DIM_TABLE = "MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT";

export const SELECT_EXISTING_SQL = `SELECT TIER, CATALOG_PRODUCT_ID, EMBED_DOC_HASH, EMBED_DOC_VERSION, CATALOG_STATUS FROM ${DIM_TABLE} WHERE TIER = ?`;

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  // Snowflake's default single-quoted string-literal grammar treats
  // backslash as an escape introducer (\n, \t, \\, \' ...) — unlike
  // standard ANSI SQL, where '' is the only escape. Backslashes MUST be
  // escaped first: doubling only the quotes would let a value ending in a
  // backslash (e.g. "50% off\") swallow the closing quote via `\'` and
  // desync the rest of the generated statement. Confirmed live in the
  // 2026-08-20 seed CSV — 2 of the 187 products contain a backslash.
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function sqlBool(value) {
  return value ? "TRUE" : "FALSE";
}

// NOTE on batch atomicity: a single row exceeding a VARCHAR cap (TITLE
// 1000 / VENDOR 255 / PRODUCT_TYPE 255 — see sql/dim_catalog_product.sql)
// fails the whole batch's MERGE with no per-row isolation or retry, so nothing
// in that batch lands, not just the offending row. Verified against the
// 2026-08-20 seed CSV that no field is anywhere close to these caps (max
// observed: title 235, vendor 26, type 30) — not a live risk today, but a
// future catalog with materially longer fields could hit this.
export function buildUpsertBatchSql(batch, asOf) {
  const values = batch
    .map(
      (u) =>
        `(${[
          sqlLiteral(u.tier),
          sqlLiteral(u.catalogProductId),
          sqlLiteral(u.title),
          sqlLiteral(u.vendor),
          sqlLiteral(u.type),
          sqlLiteral(u.tags),
          sqlLiteral(u.embedDoc),
          sqlLiteral(u.embedDocHash),
          sqlLiteral(u.embedDocVersion),
          sqlBool(u.needsEmbed),
          `TO_TIMESTAMP_NTZ(${sqlLiteral(asOf)})`,
        ].join(",")})`,
    )
    .join(",\n    ");

  return `
MERGE INTO ${DIM_TABLE} AS tgt
USING (
  SELECT * FROM VALUES
    ${values}
  AS v(TIER, CATALOG_PRODUCT_ID, TITLE, VENDOR, PRODUCT_TYPE, TAGS, EMBED_DOC, EMBED_DOC_HASH, EMBED_DOC_VERSION, NEEDS_EMBED, LAST_SEEN_AT)
) AS src
ON tgt.TIER = src.TIER AND tgt.CATALOG_PRODUCT_ID = src.CATALOG_PRODUCT_ID
WHEN MATCHED THEN UPDATE SET
  TITLE = src.TITLE,
  VENDOR = src.VENDOR,
  PRODUCT_TYPE = src.PRODUCT_TYPE,
  TAGS = src.TAGS,
  EMBED_DOC = src.EMBED_DOC,
  EMBED_DOC_HASH = src.EMBED_DOC_HASH,
  EMBED_DOC_VERSION = src.EMBED_DOC_VERSION,
  PRODUCT_VECTOR = CASE WHEN src.NEEDS_EMBED THEN SNOWFLAKE.CORTEX.EMBED_TEXT_1024('${EMBED_MODEL}', src.EMBED_DOC) ELSE tgt.PRODUCT_VECTOR END,
  CATALOG_STATUS = 'active',
  LAST_SEEN_AT = src.LAST_SEEN_AT,
  UPDATED_AT = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (
  TIER, CATALOG_PRODUCT_ID, TITLE, VENDOR, PRODUCT_TYPE, TAGS, EMBED_DOC, EMBED_DOC_HASH, EMBED_DOC_VERSION,
  PRODUCT_VECTOR, CATALOG_STATUS, FIRST_SEEN_AT, LAST_SEEN_AT, UPDATED_AT
) VALUES (
  src.TIER, src.CATALOG_PRODUCT_ID, src.TITLE, src.VENDOR, src.PRODUCT_TYPE, src.TAGS, src.EMBED_DOC, src.EMBED_DOC_HASH, src.EMBED_DOC_VERSION,
  SNOWFLAKE.CORTEX.EMBED_TEXT_1024('${EMBED_MODEL}', src.EMBED_DOC), 'active', CURRENT_TIMESTAMP(), src.LAST_SEEN_AT, CURRENT_TIMESTAMP()
);`.trim();
}

export function buildDelistBatchSql(batch) {
  const values = batch
    .map((d) => `(${sqlLiteral(d.tier)},${sqlLiteral(d.catalogProductId)})`)
    .join(",\n    ");
  return `
MERGE INTO ${DIM_TABLE} AS tgt
USING (
  SELECT * FROM VALUES
    ${values}
  AS v(TIER, CATALOG_PRODUCT_ID)
) AS src
ON tgt.TIER = src.TIER AND tgt.CATALOG_PRODUCT_ID = src.CATALOG_PRODUCT_ID
WHEN MATCHED THEN UPDATE SET CATALOG_STATUS = 'delisted', UPDATED_AT = CURRENT_TIMESTAMP();`.trim();
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
