// catalog_transform.mjs — the product-catalog upsert/delist planner (CRMA-773).
//
// Pure functions only: no I/O, no Snowflake calls, no fetch. This module is
// the shared brain behind BOTH the one-off CSV seed
// (scripts/seed_catalog_from_csv.mjs) and the future Shopify live-sync Cloud
// Run job — each producer normalizes its own raw rows into the common
// NormalizedProduct shape (see collapseShopifyCsvRows for the CSV producer;
// a REST producer would add a sibling normalizer with the same output
// shape), then hands the normalized array + current DIM_CATALOG_PRODUCT
// state to planCatalogUpsert(). Adding a new source later should mean
// "write one more normalizer," not "touch this planner."
//
// Embed doc v1 recipe (settled CRMA-745 design map):
//   "title. Type: <type>. Vendor: <vendor>. Tags: <tags>. <body_html
//    stripped, first 600 chars>"
// `Type` is skipped entirely (no "Type: " segment at all) when the source's
// Type value carries no information — the verbatim spec calls out the
// literal string '0' (Shopify's empty-category sentinel); this
// implementation treats true-empty the same way, since both mean "no type
// set" and either would otherwise leave a dangling "Type: ." segment.

import { createHash } from "node:crypto";

export const EMBED_DOC_VERSION = "v1";
export const BODY_CHAR_CAP = 600;

// Canonical Cortex embed model for the whole catalog vector space — lives
// here (not in a producer script) because PRODUCT_VECTOR is only comparable
// against FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR if every producer (this
// CSV seed today, the future live-sync job) embeds against the same model.
// One source of truth so a future model bump can't drift between producers.
export const EMBED_MODEL = "snowflake-arctic-embed-l-v2.0";

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

// Strips tags, decodes the common named entities Shopify's Body (HTML)
// actually contains plus numeric entities (&#8217; / &#x2019; etc. — common
// from pasted rich text), and collapses whitespace/newlines to single
// spaces. Not a full HTML parser — this repo has no HTML-parsing dependency
// and doesn't need one for a "make it readable prose for an embedding
// model" pass. Unrecognized named entities are left as-is (best effort).
export function stripHtml(html) {
  const s = html === null || html === undefined ? "" : String(html);
  const noTags = s.replace(/<[^>]*>/g, " ");
  const namedDecoded = noTags.replace(
    /&(amp|lt|gt|quot|apos|nbsp);/g,
    (m) => HTML_ENTITIES[m] ?? m,
  );
  const numericDecoded = namedDecoded
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => decodeCodePoint(parseInt(dec, 10)));
  return numericDecoded.replace(/\s+/g, " ").trim();
}

function decodeCodePoint(codePoint) {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

// CSV Tags is a comma-separated STRING, not an array (Shopify admin export
// convention) — this is the shared parser both the embed doc and any future
// tag-level consumer should use, so "split on comma" logic lives in one
// place.
export function parseTags(tagsRaw) {
  const s = tagsRaw === null || tagsRaw === undefined ? "" : String(tagsRaw);
  return s
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// Shopify's export sometimes leaves Type genuinely empty, and sometimes
// writes the literal string '0' (an artifact of how the Shopify Collective
// storefront's category sync populates the column) — both mean "no type."
function isEmptyType(typeRaw) {
  const s = typeRaw === null || typeRaw === undefined ? "" : String(typeRaw).trim();
  return s === "" || s === "0";
}

// ---------------------------------------------------------------------------
// Embed doc construction (v1)
// ---------------------------------------------------------------------------

// product: { title, type, vendor, tags, bodyHtml }
export function buildEmbedDoc(product) {
  const title = (product.title ?? "").trim();
  const vendor = (product.vendor ?? "").trim();
  const tagList = parseTags(product.tags);
  const bodyText = stripHtml(product.bodyHtml).slice(0, BODY_CHAR_CAP);

  const segments = [`${title}.`];
  if (!isEmptyType(product.type)) {
    segments.push(`Type: ${String(product.type).trim()}.`);
  }
  segments.push(`Vendor: ${vendor}.`);
  segments.push(`Tags: ${tagList.join(", ")}.`);
  if (bodyText) segments.push(bodyText);

  return segments.join(" ").replace(/[ \t]+/g, " ").trim();
}

export function hashEmbedDoc(doc) {
  return createHash("sha256").update(doc, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Shopify CSV normalization
// ---------------------------------------------------------------------------

// Collapses raw parsed Shopify admin-export rows (one row per variant/extra
// image, all sharing a Handle) into one NormalizedProduct per distinct
// Handle. Handle-level fields (Title, Body (HTML), Vendor, Type, Tags,
// Status) are identical across a product's rows but only populated on the
// row(s) that carry a Title — continuation rows (extra variants, extra
// images) leave them blank in Shopify's export. Picks the first
// Title-bearing row seen per Handle; row order (first-seen Handle) is
// preserved in the output. Drops products whose Status is explicitly
// draft/archived (Shopify's own not-purchasable states) — the retrieval
// contract this dimension serves (DIM_CATALOG_PRODUCT WHERE
// CATALOG_STATUS='active') should never surface a non-purchasable product.
export function collapseShopifyCsvRows(rows) {
  const byHandle = new Map();
  for (const row of rows ?? []) {
    const handle = (row.Handle ?? "").trim();
    if (!handle) continue;
    const hasTitle = (row.Title ?? "").trim().length > 0;
    const existing = byHandle.get(handle);
    if (!existing) {
      byHandle.set(handle, row);
    } else {
      const existingHasTitle = (existing.Title ?? "").trim().length > 0;
      if (!existingHasTitle && hasTitle) byHandle.set(handle, row);
    }
  }
  return [...byHandle.values()]
    .filter((row) => isPurchasableShopifyStatus(row.Status))
    .map((row) => ({
      tier: "shopify",
      catalogProductId: (row.Handle ?? "").trim(),
      title: (row.Title ?? "").trim(),
      vendor: (row.Vendor ?? "").trim(),
      type: row.Type ?? "",
      tags: row.Tags ?? "",
      bodyHtml: row["Body (HTML)"] ?? "",
    }));
}

// Missing/blank Status is treated as purchasable — it defaults this way for
// fixtures and any future normalizer that doesn't carry a Status field at
// all, rather than defaulting to exclusion for a column we simply don't
// have. Only an explicit non-'active' value (draft, archived) excludes.
function isPurchasableShopifyStatus(statusRaw) {
  const s = (statusRaw ?? "").trim().toLowerCase();
  return s === "" || s === "active";
}

// ---------------------------------------------------------------------------
// Upsert / delist / re-embed planner
// ---------------------------------------------------------------------------

// normalizedProducts: NormalizedProduct[] — every product currently seen by
//   this sweep (already collapsed to one row per (tier, catalogProductId)).
// existingRows: [{ tier, catalogProductId, embedDocHash, embedDocVersion?,
//   catalogStatus }] — the current DIM_CATALOG_PRODUCT state for the
//   tier(s) being swept. Only the fields the diff needs; callers can SELECT
//   a narrow projection. embedDocVersion is optional — omit it (or leave it
//   undefined) if the caller didn't fetch it; version drift is then simply
//   not detected, same as before this field existed.
// options.asOf: value to stamp as LAST_SEEN_AT on every upserted row (the
//   CSV seed passes the export date; a live-sync job would pass its sweep
//   timestamp).
//
// Returns:
//   upserts   — one plan row per currently-seen product, whether its embed
//               doc changed or not (LAST_SEEN_AT / CATALOG_STATUS='active'
//               must be refreshed either way).
//   toEmbed   — the subset of `upserts` whose EMBED_DOC_HASH differs from
//               the existing row's, or whose EMBED_DOC_VERSION doesn't
//               match this module's current EMBED_DOC_VERSION (or that
//               don't exist yet) — the only rows that actually need a
//               Cortex embed call. A version mismatch always forces a
//               re-embed even if the hash happens to match — that's the
//               conservative choice: skipping it risks a stale vector
//               sitting under a new version label.
//   delists   — { tier, catalogProductId } for existing ACTIVE rows that
//               were not seen this sweep (soft-delist plan; already-delisted
//               rows are never re-listed here).
export function planCatalogUpsert(normalizedProducts, existingRows, options = {}) {
  const { asOf = null } = options;

  const existingByKey = new Map();
  for (const row of existingRows ?? []) {
    existingByKey.set(keyOf(row.tier, row.catalogProductId), row);
  }

  const seenKeys = new Set();
  const upserts = [];
  const toEmbed = [];

  for (const product of normalizedProducts ?? []) {
    const key = keyOf(product.tier, product.catalogProductId);
    seenKeys.add(key);

    const embedDoc = buildEmbedDoc(product);
    const embedDocHash = hashEmbedDoc(embedDoc);
    const existing = existingByKey.get(key);
    const versionChanged =
      !!existing && existing.embedDocVersion !== undefined && existing.embedDocVersion !== EMBED_DOC_VERSION;
    const needsEmbed = !existing || existing.embedDocHash !== embedDocHash || versionChanged;

    const plan = {
      tier: product.tier,
      catalogProductId: product.catalogProductId,
      title: product.title,
      vendor: product.vendor,
      type: product.type,
      tags: product.tags,
      embedDoc,
      embedDocHash,
      embedDocVersion: EMBED_DOC_VERSION,
      catalogStatus: "active",
      lastSeenAt: asOf,
      needsEmbed,
    };
    upserts.push(plan);
    if (needsEmbed) toEmbed.push(plan);
  }

  const delists = [];
  for (const [key, row] of existingByKey.entries()) {
    if (seenKeys.has(key)) continue;
    if (row.catalogStatus === "delisted") continue; // already delisted — no-op
    delists.push({ tier: row.tier, catalogProductId: row.catalogProductId });
  }

  return { upserts, toEmbed, delists };
}

// JSON-array serialization rather than a delimited string ("tier::id") so
// a tier or id value that happens to contain the delimiter can't collide
// with a different (tier, id) pair.
function keyOf(tier, catalogProductId) {
  return JSON.stringify([tier, catalogProductId]);
}
