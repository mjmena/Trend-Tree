// Tests for the product-catalog upsert/delist planner (CRMA-773).
// Run: node --test agents/lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripHtml,
  parseTags,
  buildEmbedDoc,
  hashEmbedDoc,
  collapseShopifyCsvRows,
  planCatalogUpsert,
  EMBED_DOC_VERSION,
  EMBED_MODEL,
  BODY_CHAR_CAP,
} from "./catalog_transform.mjs";

test("EMBED_MODEL is the canonical arctic-embed-l-v2.0 model, shared by every producer", () => {
  assert.equal(EMBED_MODEL, "snowflake-arctic-embed-l-v2.0");
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

test("stripHtml removes tags and decodes common entities", () => {
  const html = '<meta charset="utf-8"><span data-mce-fragment="1">Fish &amp; chips &mdash; a &quot;classic&quot;.</span>';
  const out = stripHtml(html);
  assert.equal(out, 'Fish & chips &mdash; a "classic".');
});

test("stripHtml collapses whitespace/newlines to single spaces", () => {
  const html = "<p>Line one.</p>\n\n<p>Line   two.</p>";
  assert.equal(stripHtml(html), "Line one. Line two.");
});

test("stripHtml handles null/undefined/empty", () => {
  assert.equal(stripHtml(null), "");
  assert.equal(stripHtml(undefined), "");
  assert.equal(stripHtml(""), "");
});

test("stripHtml decodes numeric entities (decimal and hex) — common from pasted rich text", () => {
  // &#8217; / &#x2019; = right single quotation mark; &#8212; = em dash.
  assert.equal(stripHtml("Nature&#8217;s best"), "Nature’s best");
  assert.equal(stripHtml("Nature&#x2019;s best"), "Nature’s best");
  assert.equal(stripHtml("a&#8212;b"), "a—b");
});

test("stripHtml ignores an out-of-range numeric entity rather than throwing", () => {
  assert.equal(stripHtml("bad&#99999999;ref"), "badref");
});

// ---------------------------------------------------------------------------
// parseTags — CSV Tags is a comma-separated STRING, not an array
// ---------------------------------------------------------------------------

test("parseTags splits and trims a comma-separated string", () => {
  assert.deepEqual(parseTags("tag1, tag2,tag3 ,  tag4"), ["tag1", "tag2", "tag3", "tag4"]);
});

test("parseTags drops empty entries (trailing/double commas)", () => {
  assert.deepEqual(parseTags("tag1,,tag2,"), ["tag1", "tag2"]);
});

test("parseTags handles null/undefined/empty", () => {
  assert.deepEqual(parseTags(null), []);
  assert.deepEqual(parseTags(undefined), []);
  assert.deepEqual(parseTags(""), []);
});

// ---------------------------------------------------------------------------
// buildEmbedDoc — doc construction, 600-char cap, Type='0' skip
// ---------------------------------------------------------------------------

const product = (over = {}) => ({
  title: "Tallow Balm",
  type: "Skincare",
  vendor: "Acme Goods",
  tags: "tallow, skincare, natural",
  bodyHtml: "<p>A rich, nourishing balm made with grass-fed tallow.</p>",
  ...over,
});

test("buildEmbedDoc assembles the v1 recipe verbatim", () => {
  const doc = buildEmbedDoc(product());
  assert.equal(
    doc,
    "Tallow Balm. Type: Skincare. Vendor: Acme Goods. Tags: tallow, skincare, natural. A rich, nourishing balm made with grass-fed tallow.",
  );
});

test("buildEmbedDoc caps the stripped body at 600 chars", () => {
  const longBody = "<p>" + "x".repeat(1000) + "</p>";
  const doc = buildEmbedDoc(product({ bodyHtml: longBody }));
  const bodyPart = doc.split("Tags: tallow, skincare, natural. ")[1];
  assert.equal(bodyPart.length, BODY_CHAR_CAP);
  assert.equal(bodyPart, "x".repeat(BODY_CHAR_CAP));
});

test("buildEmbedDoc caps from the STRIPPED text, not raw HTML length", () => {
  // Raw HTML is well under 600 chars once tags are stripped, but well over
  // 600 chars including markup — the cap must apply post-strip.
  const parts = [];
  for (let i = 0; i < 50; i++) parts.push(`<span class="x">word${i}</span>`);
  const html = parts.join(" "); // long with markup, short once stripped of tags
  const doc = buildEmbedDoc(product({ bodyHtml: html }));
  const stripped = stripHtml(html);
  assert.ok(stripped.length < html.length, "sanity: stripping should shrink the text");
  const bodyPart = doc.split("Tags: tallow, skincare, natural. ")[1];
  assert.equal(bodyPart, stripped.slice(0, BODY_CHAR_CAP));
});

test("buildEmbedDoc skips the Type segment entirely when Type is literal '0'", () => {
  const doc = buildEmbedDoc(product({ type: "0" }));
  assert.ok(!doc.includes("Type:"), `expected no "Type:" segment, got: ${doc}`);
  assert.equal(
    doc,
    "Tallow Balm. Vendor: Acme Goods. Tags: tallow, skincare, natural. A rich, nourishing balm made with grass-fed tallow.",
  );
});

test("buildEmbedDoc skips the Type segment when Type is empty/whitespace/missing", () => {
  for (const emptyType of ["", "   ", null, undefined]) {
    const doc = buildEmbedDoc(product({ type: emptyType }));
    assert.ok(!doc.includes("Type:"), `expected no "Type:" segment for type=${JSON.stringify(emptyType)}, got: ${doc}`);
  }
});

test("buildEmbedDoc keeps a real Type value verbatim (not confused with '0')", () => {
  const doc = buildEmbedDoc(product({ type: "Media > Magazines & Newspapers > Magazines" }));
  assert.ok(doc.includes("Type: Media > Magazines & Newspapers > Magazines."));
});

test("buildEmbedDoc uses parsed (trimmed, re-joined) tags, not the raw string", () => {
  const doc = buildEmbedDoc(product({ tags: "  tallow ,skincare,  natural  " }));
  assert.ok(doc.includes("Tags: tallow, skincare, natural."));
});

// ---------------------------------------------------------------------------
// hashEmbedDoc — hash diff
// ---------------------------------------------------------------------------

test("hashEmbedDoc is deterministic for identical input", () => {
  const doc = buildEmbedDoc(product());
  assert.equal(hashEmbedDoc(doc), hashEmbedDoc(doc));
});

test("hashEmbedDoc differs when the doc changes", () => {
  const a = buildEmbedDoc(product());
  const b = buildEmbedDoc(product({ title: "Different Title" }));
  assert.notEqual(hashEmbedDoc(a), hashEmbedDoc(b));
});

// ---------------------------------------------------------------------------
// collapseShopifyCsvRows — variant/image rows collapse to one per Handle
// ---------------------------------------------------------------------------

test("collapseShopifyCsvRows collapses multiple variant/image rows to one per Handle", () => {
  const rows = [
    {
      Handle: "tallow-balm",
      Title: "Tallow Balm",
      "Body (HTML)": "<p>Balm body</p>",
      Vendor: "Acme Goods",
      Type: "Skincare",
      Tags: "tallow, skincare",
    },
    // continuation row: extra image, handle-level fields blank
    { Handle: "tallow-balm", Title: "", "Body (HTML)": "", Vendor: "", Type: "", Tags: "" },
    // continuation row: another variant, handle-level fields blank
    { Handle: "tallow-balm", Title: "", "Body (HTML)": "", Vendor: "", Type: "", Tags: "" },
    {
      Handle: "other-product",
      Title: "Other Product",
      "Body (HTML)": "<p>Other body</p>",
      Vendor: "Beta Co",
      Type: "0",
      Tags: "misc",
    },
  ];
  const out = collapseShopifyCsvRows(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].catalogProductId, "tallow-balm");
  assert.equal(out[0].tier, "shopify");
  assert.equal(out[0].title, "Tallow Balm");
  assert.equal(out[0].vendor, "Acme Goods");
  assert.equal(out[0].bodyHtml, "<p>Balm body</p>");
  assert.equal(out[1].catalogProductId, "other-product");
  assert.equal(out[1].type, "0");
});

test("collapseShopifyCsvRows ignores rows with a blank Handle", () => {
  const rows = [{ Handle: "", Title: "Ghost row" }];
  assert.deepEqual(collapseShopifyCsvRows(rows), []);
});

test("collapseShopifyCsvRows drops draft/archived products, keeps active and status-less rows", () => {
  const row = (over) => ({
    Handle: over.Handle,
    Title: over.Handle + " title",
    "Body (HTML)": "<p>Body</p>",
    Vendor: "V",
    Type: "T",
    Tags: "a,b",
    Status: over.Status,
  });
  const rows = [
    row({ Handle: "is-active", Status: "active" }),
    row({ Handle: "is-draft", Status: "draft" }),
    row({ Handle: "is-archived", Status: "archived" }),
    row({ Handle: "case-insensitive", Status: "ACTIVE" }),
    row({ Handle: "no-status-field", Status: undefined }),
  ];
  const out = collapseShopifyCsvRows(rows);
  const ids = out.map((p) => p.catalogProductId).sort();
  assert.deepEqual(ids, ["case-insensitive", "is-active", "no-status-field"]);
});

test("collapseShopifyCsvRows picks the Title-bearing row even if it isn't first", () => {
  const rows = [
    { Handle: "h1", Title: "", "Body (HTML)": "", Vendor: "", Type: "", Tags: "" },
    { Handle: "h1", Title: "Real Title", "Body (HTML)": "<p>Body</p>", Vendor: "V", Type: "T", Tags: "a,b" },
  ];
  const out = collapseShopifyCsvRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Real Title");
  assert.equal(out[0].vendor, "V");
});

// ---------------------------------------------------------------------------
// planCatalogUpsert — upsert plan, hash-diff no-reembed, soft-delist plan
// ---------------------------------------------------------------------------

const normalized = (over = {}) => ({
  tier: "shopify",
  catalogProductId: "tallow-balm",
  title: "Tallow Balm",
  vendor: "Acme Goods",
  type: "Skincare",
  tags: "tallow, skincare",
  bodyHtml: "<p>A rich balm.</p>",
  ...over,
});

test("planCatalogUpsert: brand-new product needs embedding", () => {
  const plan = planCatalogUpsert([normalized()], [], { asOf: "2026-08-20" });
  assert.equal(plan.upserts.length, 1);
  assert.equal(plan.toEmbed.length, 1);
  assert.equal(plan.upserts[0].needsEmbed, true);
  assert.equal(plan.upserts[0].catalogStatus, "active");
  assert.equal(plan.upserts[0].lastSeenAt, "2026-08-20");
  assert.equal(plan.delists.length, 0);
});

test("planCatalogUpsert: unchanged row (matching hash) produces NO re-embed — idempotency", () => {
  const first = planCatalogUpsert([normalized()], [], { asOf: "2026-08-20" });
  const existingRows = first.upserts.map((u) => ({
    tier: u.tier,
    catalogProductId: u.catalogProductId,
    embedDocHash: u.embedDocHash,
    catalogStatus: u.catalogStatus,
  }));

  // Re-run with the identical product — simulates re-running the seed.
  const second = planCatalogUpsert([normalized()], existingRows, { asOf: "2026-08-20" });
  assert.equal(second.upserts.length, 1);
  assert.equal(second.toEmbed.length, 0, "unchanged doc must not be queued for re-embedding");
  assert.equal(second.upserts[0].needsEmbed, false);
  assert.equal(second.upserts[0].embedDocHash, first.upserts[0].embedDocHash);
});

test("planCatalogUpsert: changed content (e.g. new body copy) DOES trigger a re-embed", () => {
  const first = planCatalogUpsert([normalized()], [], { asOf: "2026-08-20" });
  const existingRows = first.upserts.map((u) => ({
    tier: u.tier,
    catalogProductId: u.catalogProductId,
    embedDocHash: u.embedDocHash,
    catalogStatus: u.catalogStatus,
  }));

  const changed = normalized({ bodyHtml: "<p>Totally rewritten copy.</p>" });
  const second = planCatalogUpsert([changed], existingRows, { asOf: "2026-08-21" });
  assert.equal(second.toEmbed.length, 1);
  assert.equal(second.upserts[0].needsEmbed, true);
  assert.notEqual(second.upserts[0].embedDocHash, first.upserts[0].embedDocHash);
});

test("planCatalogUpsert: soft-delist plan for a product that disappeared from the sweep", () => {
  const existingRows = [
    { tier: "shopify", catalogProductId: "still-here", embedDocHash: "h1", catalogStatus: "active" },
    { tier: "shopify", catalogProductId: "vanished", embedDocHash: "h2", catalogStatus: "active" },
  ];
  const currentSweep = [normalized({ catalogProductId: "still-here" })];
  // Force the "still-here" row's hash to match so it doesn't trigger a
  // re-embed in this delist-focused test.
  const stillHereDoc = buildEmbedDocForTest(currentSweep[0]);
  existingRows[0].embedDocHash = stillHereDoc;

  const plan = planCatalogUpsert(currentSweep, existingRows, { asOf: "2026-08-20" });
  assert.equal(plan.delists.length, 1);
  assert.deepEqual(plan.delists[0], { tier: "shopify", catalogProductId: "vanished" });
  // The row that IS still present must never appear in the delist plan.
  assert.ok(!plan.delists.some((d) => d.catalogProductId === "still-here"));
});

test("planCatalogUpsert: already-delisted rows are not re-emitted into the delist plan", () => {
  const existingRows = [
    { tier: "shopify", catalogProductId: "long-gone", embedDocHash: "h9", catalogStatus: "delisted" },
  ];
  const plan = planCatalogUpsert([], existingRows, { asOf: "2026-08-20" });
  assert.equal(plan.delists.length, 0);
});

test("planCatalogUpsert: a delisted product that reappears with unchanged content flips back to active without a re-embed", () => {
  const p = normalized({ catalogProductId: "reappeared" });
  const doc = buildEmbedDocForTest(p);
  const existingRows = [
    { tier: "shopify", catalogProductId: "reappeared", embedDocHash: doc, catalogStatus: "delisted" },
  ];
  const plan = planCatalogUpsert([p], existingRows, { asOf: "2026-08-20" });
  assert.equal(plan.upserts.length, 1);
  assert.equal(plan.upserts[0].catalogStatus, "active");
  assert.equal(plan.upserts[0].needsEmbed, false, "unchanged content on reactivation should not re-embed");
  assert.equal(plan.toEmbed.length, 0);
  assert.equal(plan.delists.length, 0);
});

test("planCatalogUpsert: a stale EMBED_DOC_VERSION forces a re-embed even when the hash still matches", () => {
  const p = normalized();
  const doc = buildEmbedDocForTest(p); // same hash the current recipe would produce
  const existingRows = [
    {
      tier: "shopify",
      catalogProductId: p.catalogProductId,
      embedDocHash: doc,
      embedDocVersion: "v0-legacy",
      catalogStatus: "active",
    },
  ];
  const plan = planCatalogUpsert([p], existingRows, { asOf: "2026-08-20" });
  assert.equal(plan.upserts[0].needsEmbed, true, "version mismatch must force a re-embed regardless of hash");
  assert.equal(plan.toEmbed.length, 1);
});

test("planCatalogUpsert: a matching EMBED_DOC_VERSION does not force a re-embed on its own", () => {
  const p = normalized();
  const doc = buildEmbedDocForTest(p);
  const existingRows = [
    {
      tier: "shopify",
      catalogProductId: p.catalogProductId,
      embedDocHash: doc,
      embedDocVersion: EMBED_DOC_VERSION,
      catalogStatus: "active",
    },
  ];
  const plan = planCatalogUpsert([p], existingRows, { asOf: "2026-08-20" });
  assert.equal(plan.upserts[0].needsEmbed, false);
});

test("planCatalogUpsert: omitting embedDocVersion from existingRows (caller didn't fetch it) never forces a re-embed on its own", () => {
  const p = normalized();
  const doc = buildEmbedDocForTest(p);
  const existingRows = [
    { tier: "shopify", catalogProductId: p.catalogProductId, embedDocHash: doc, catalogStatus: "active" },
  ];
  const plan = planCatalogUpsert([p], existingRows, { asOf: "2026-08-20" });
  assert.equal(plan.upserts[0].needsEmbed, false);
});

test("planCatalogUpsert: EMBED_DOC_VERSION stamped on every plan row", () => {
  const plan = planCatalogUpsert([normalized()], [], { asOf: "2026-08-20" });
  assert.equal(plan.upserts[0].embedDocVersion, EMBED_DOC_VERSION);
  assert.equal(EMBED_DOC_VERSION, "v1");
});

test("planCatalogUpsert: tiers are isolated — a shopify delist plan never touches another tier's key", () => {
  const existingRows = [
    { tier: "shopify", catalogProductId: "same-id", embedDocHash: "hA", catalogStatus: "active" },
    { tier: "amazon", catalogProductId: "same-id", embedDocHash: "hB", catalogStatus: "active" },
  ];
  const plan = planCatalogUpsert([], existingRows, { asOf: "2026-08-20" });
  assert.equal(plan.delists.length, 2);
  assert.ok(plan.delists.some((d) => d.tier === "shopify" && d.catalogProductId === "same-id"));
  assert.ok(plan.delists.some((d) => d.tier === "amazon" && d.catalogProductId === "same-id"));
});

test("planCatalogUpsert: composite key doesn't collide when tier/id values contain the internal delimiter", () => {
  // Regression: the key used to be a plain `${tier}::${id}` template, so
  // tier="shopify::x", id="foo" and tier="shopify", id="x::foo" would have
  // collided on the string "shopify::x::foo".
  const existingRows = [
    { tier: "shopify::x", catalogProductId: "foo", embedDocHash: "hA", catalogStatus: "active" },
    { tier: "shopify", catalogProductId: "x::foo", embedDocHash: "hB", catalogStatus: "active" },
  ];
  const plan = planCatalogUpsert([], existingRows, { asOf: "2026-08-20" });
  assert.equal(plan.delists.length, 2, "both distinct (tier, id) pairs must be delisted independently");
});

// local helper mirroring buildEmbedDoc+hashEmbedDoc for delist-focused
// fixtures that need a matching hash without asserting on doc content.
function buildEmbedDocForTest(p) {
  return hashEmbedDoc(buildEmbedDoc(p));
}
