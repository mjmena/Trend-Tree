#!/usr/bin/env node
// seed_catalog_from_csv.mjs — one-off seed of DIM_CATALOG_PRODUCT from a
// Shopify admin CSV export (CRMA-773).
//
// Reads the CSV (one row per variant/extra-image), collapses it to one row
// per distinct product Handle, hands the result to the shared
// agents/lib/catalog_transform.mjs planner alongside the current
// DIM_CATALOG_PRODUCT state, and executes the resulting upsert / delist
// plan against Snowflake via the `snow` CLI (per this repo's convention:
// `snow sql -c <connection>`, never `snowsql`). Idempotent — re-running
// against an unchanged CSV re-plans identically and the planner's
// EMBED_DOC_HASH diff means no product gets re-embedded twice.
//
// Usage:
//   node scripts/seed_catalog_from_csv.mjs [--csv PATH] [--as-of YYYY-MM-DD]
//     [--connection NAME] [--batch-size N] [--dry-run]
//
// Defaults: --csv ~/dev/trend-tree-data/products_export_2026-08-20.csv
//           --as-of 2026-08-20   --connection claude   --batch-size 40
//
// --dry-run parses the CSV, builds the plan, and prints a summary WITHOUT
// touching Snowflake — useful for sanity-checking the plan (row counts,
// sample embed docs) before spending Cortex embed calls.

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { collapseShopifyCsvRows, planCatalogUpsert, EMBED_MODEL } from "../agents/lib/catalog_transform.mjs";

const DIM_TABLE = "MCC_PRESENTATION.TREND_AGENT.DIM_CATALOG_PRODUCT";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    csv: join(process.env.HOME ?? "", "dev/trend-tree-data/products_export_2026-08-20.csv"),
    asOf: "2026-08-20",
    connection: "claude",
    batchSize: 40,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--csv") opts.csv = argv[++i];
    else if (a === "--as-of") opts.asOf = argv[++i];
    else if (a === "--connection") opts.connection = argv[++i];
    else if (a === "--batch-size") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--batch-size must be a positive integer, got: ${argv[i]}`);
      }
      opts.batchSize = n;
    } else if (a === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unrecognized argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Minimal RFC4180 CSV parser (no dependency — this repo carries none).
// Handles quoted fields with embedded commas, escaped "" quotes, and
// embedded newlines (Shopify's Body (HTML) column can contain either).
//
// Known, accepted limitations (not RFC4180-compliant input, not expected
// from a Shopify admin export, so not worth the added complexity to guard
// against): (1) a `"` appearing outside a properly-quoted field is always
// treated as opening a new quoted region — a field containing a quote that
// ISN'T doubled/escaped per RFC4180 will desync parsing for the rest of the
// row; (2) only `\n` (optionally preceded by `\r`) ends a record — a file
// using bare `\r`-only (classic pre-OS9 Mac) line endings won't split into
// rows at all. Both would need a more defensive/recovering parser to
// handle; flagging here rather than silently pretending they're covered.
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // swallow; \n (or end of input) closes the record
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // trailing field/row if the file doesn't end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvRowsToObjects(rawRows) {
  const [header, ...dataRows] = rawRows;
  const objects = [];
  for (const r of dataRows) {
    if (r.length === 1 && r[0] === "") continue; // blank trailing line
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? "";
    objects.push(obj);
  }
  return objects;
}

// ---------------------------------------------------------------------------
// snow CLI plumbing
// ---------------------------------------------------------------------------

// Runs a SQL statement via `snow sql -f <tempfile> --format json -c
// <connection>`. Deliberately writes the (fully generated, single-purpose)
// statement to a temp file rather than `-q` — the statements this script
// builds embed hundreds of KB of product text and easily exceed comfortable
// argv/shell-quoting limits. This is NOT the same thing CLAUDE.md's "never
// snow sql -f the whole file live" warns against — that rule is about the
// tracked, multi-statement sql/*.sql migration files (which mix CREATE OR
// REPLACE TABLE with unrelated task DDL); this is one generated, single
// statement written fresh per call.
function runSnowSql(sqlText, connection) {
  const tmpFile = join(tmpdir(), `catalog-seed-${randomUUID()}.sql`);
  writeFileSync(tmpFile, sqlText, "utf8");
  try {
    const out = execFileSync(
      "snow",
      ["sql", "--format", "json", "-f", tmpFile, "-c", connection],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return parseSnowJson(out);
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}

function parseSnowJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  // snow CLI emits either a bare array of row objects, or (for multi-statement
  // files) an array of {statement, result} groups. Normalize to a flat array
  // of the last statement's rows, since every call this script makes is a
  // single statement.
  if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
    return parsed[parsed.length - 1];
  }
  return parsed;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  // Snowflake's default single-quoted string-literal grammar treats
  // backslash as an escape introducer (\n, \t, \\, \' ...) — unlike
  // standard ANSI SQL, where '' is the only escape. Backslashes MUST be
  // escaped first: doubling only the quotes would let a value ending in a
  // backslash (e.g. "50% off\") swallow the closing quote via `\'` and
  // desync the rest of the generated statement. Confirmed live in this
  // exact seed CSV — 2 of the 187 products contain a backslash.
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function sqlBool(value) {
  return value ? "TRUE" : "FALSE";
}

// ---------------------------------------------------------------------------
// Batch SQL builders
// ---------------------------------------------------------------------------

// NOTE on batch atomicity: a single row exceeding a VARCHAR cap (TITLE
// 1000 / VENDOR 255 / PRODUCT_TYPE 255 — see sql/dim_catalog_product.sql)
// fails the whole batch's MERGE with no per-row isolation or retry, so nothing
// in that batch lands, not just the offending row. Verified against the
// 2026-08-20 seed CSV that no field is anywhere close to these caps (max
// observed: title 235, vendor 26, type 30) — not a live risk today, but a
// future export with materially longer fields could hit this.
function buildUpsertBatchSql(batch, asOf) {
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

function buildDelistBatchSql(batch) {
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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Reading CSV: ${opts.csv}`);
  let csvText = readFileSync(opts.csv, "utf8");
  // Node's readFileSync('utf8') does not strip a leading UTF-8 BOM; left
  // in place it renames the first header cell to "﻿Handle", which
  // silently drops every row (row.Handle reads undefined for all of them).
  if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);
  const rawRows = parseCsv(csvText);
  const csvObjects = csvRowsToObjects(rawRows);
  console.log(`Parsed ${csvObjects.length} CSV data rows.`);

  const normalized = collapseShopifyCsvRows(csvObjects);
  console.log(`Collapsed to ${normalized.length} distinct products (by Handle).`);

  let existingRows = [];
  if (!opts.dryRun) {
    console.log(`Querying existing DIM_CATALOG_PRODUCT rows for tier=shopify...`);
    existingRows = runSnowSql(
      `SELECT TIER, CATALOG_PRODUCT_ID, EMBED_DOC_HASH, EMBED_DOC_VERSION, CATALOG_STATUS FROM ${DIM_TABLE} WHERE TIER = 'shopify'`,
      opts.connection,
    ).map((r) => ({
      tier: r.TIER,
      catalogProductId: r.CATALOG_PRODUCT_ID,
      embedDocHash: r.EMBED_DOC_HASH,
      embedDocVersion: r.EMBED_DOC_VERSION,
      catalogStatus: r.CATALOG_STATUS,
    }));
    console.log(`Found ${existingRows.length} existing shopify rows.`);
  }

  const plan = planCatalogUpsert(normalized, existingRows, { asOf: opts.asOf });
  console.log(
    `Plan: ${plan.upserts.length} upserts (${plan.toEmbed.length} need embedding, ` +
      `${plan.upserts.length - plan.toEmbed.length} unchanged), ${plan.delists.length} delists.`,
  );

  if (opts.dryRun) {
    // Deliberately does NOT query Snowflake at all (see runSnowSql callers
    // above being skipped) — this mode must stay usable even when
    // Snowflake/snow-CLI auth is unavailable or hanging. That means
    // existingRows is always [], so the counts above assume every product
    // is new (worst case): the real run will skip re-embedding anything
    // whose EMBED_DOC_HASH is unchanged.
    console.log(
      "--dry-run: no Snowflake calls made (not even a read) — the embed count above assumes every " +
        "product is new. A real run will skip unchanged products. Sample plan row:",
    );
    console.log(JSON.stringify(plan.upserts[0], null, 2));
    return;
  }

  const upsertBatches = chunk(plan.upserts, opts.batchSize);
  upsertBatches.forEach((batch, i) => {
    console.log(`Upserting batch ${i + 1}/${upsertBatches.length} (${batch.length} rows)...`);
    const sql = buildUpsertBatchSql(batch, opts.asOf);
    const result = runSnowSql(sql, opts.connection);
    console.log(`  -> ${JSON.stringify(result)}`);
  });

  if (plan.delists.length > 0) {
    const delistBatches = chunk(plan.delists, opts.batchSize);
    delistBatches.forEach((batch, i) => {
      console.log(`Delisting batch ${i + 1}/${delistBatches.length} (${batch.length} rows)...`);
      const sql = buildDelistBatchSql(batch);
      const result = runSnowSql(sql, opts.connection);
      console.log(`  -> ${JSON.stringify(result)}`);
    });
  }

  console.log("Done.");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}

export { parseCsv, csvRowsToObjects, buildUpsertBatchSql, buildDelistBatchSql, sqlLiteral };
