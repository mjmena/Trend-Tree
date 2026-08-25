<!-- Title: Product Sourcing -->
<!-- Parent: ATLAS Dashboard -->

# SOURCING_STATUS / SOURCED_PRODUCTS / SOURCED_AT

**At a glance** — The products we can actually sell against this trend, matched from a commerce catalog.

**Scale** — `SOURCING_STATUS` is an enum. `SOURCED_PRODUCTS` is an array of product objects. `SOURCED_AT` is a timestamp.

**What feeds it** — The **ecomm agent**, a service that runs every 15 minutes. It embeds each live trend, finds the nearest products in the catalog by vector similarity, then asks a model to judge which of those products a shopper would actually accept as an answer to this trend.

**Where it appears in ATLAS** — The products section on the card.

---

## Reading the three fields together

`SOURCING_STATUS` tells you what happened on the most recent attempt. It is **never blank** — a trend nobody has tried yet reads `not_sourced`, so "we never looked" and "we looked and found nothing" are always different answers.

| Status | What it means | What's in `SOURCED_PRODUCTS` |
|---|---|---|
| `not_sourced` | No attempt has been recorded for this trend yet. | empty |
| `running` | An attempt is in flight right now. | empty |
| `matched` | The agent picked at least one product. | the picks |
| `no_match` | The agent looked and rejected everything it saw. | empty |
| `failed` | The attempt errored. The next tick retries it. | empty |

`no_match` is the common outcome today, and it is **not** a bug — it is the agent declining to put a bad product on a good trend. As of 2026-08-25: 29 trends read `matched`, 431 read `no_match`, 46 read `not_sourced`.

`SOURCED_AT` is when that attempt finished, so you can see how stale a product list is.

## What one product looks like

Each entry in `SOURCED_PRODUCTS` carries the product's identity, the two judgements behind it, and a snapshot of its commercial details. A real pick, from the trend **Below-the-Jaw Skincare** on 2026-08-25:

| Key | Value |
|---|---|
| `product_title` | Dr. Red Light Therapy Red Light Neck Enhancer Mask for Fine Lines Reduction |
| `vendor` | Beauty Care Bag |
| `product_type` | Skin Care |
| `semantic_score` | `0.5024` |
| `reasoned_fit` | `strong` |
| `reasoned_fit_rationale` | "Specifically designed to target fine lines and skin rejuvenation on the neck and décolletage." |
| `tier` | `shopify` |

## The two judgements are separate on purpose

**`semantic_score`** is geometry, on a 0–1 scale. It measures how close the product's text sits to the trend's text in vector space. It is reproducible — the same trend and the same product always give the same number.

**`reasoned_fit`** is the model's verdict, an enum: `strong` / `partial` / `weak`. It answers a question the number cannot: *would a shopper accept this?* The Protein Coffee trend matched a plant-based protein powder at `partial` — the powder is not protein coffee, but you stir it into coffee, and the rationale says so.

**Do not blend these into one relevance number.** They disagree usefully. Ordering is on `semantic_score` alone.

## Three things that will surprise you

**These are the picks, not everything considered.** The agent shows itself a pool of candidates and selects from it. What you see is the selection. The rejects are kept as tuning evidence in `FCT_TREND_SOURCING_CANDIDATES` — worth knowing they exist, but they never reach a card.

**Price, image and link are empty today.** `price_at_match`, `image_url_at_match`, `available_at_match` and `product_url` are in the contract but read empty, because the catalog we seeded does not carry them yet. They fill in when a live catalog sync lands. A card cannot link or price a sourced product until then.

**A retry can blank out a product list.** These three fields always read the *latest* attempt. If a trend matched yesterday and today's attempt fails, the card reads `failed` with no products until it re-sources successfully. The products were not withdrawn — the newest attempt simply has none.

## What "sourcing" does not mean

The pipeline uses **source** for where a *signal* came from — `bluesky`, `gdelt`, a publisher domain. That is a completely different sense of the word from **product sourcing** on this page. `DISTINCT_SOURCE_COUNT` counts publishers; it has nothing to do with `SOURCING_STATUS`.

Sourced products are also not the same as **commerce evidence**. A `commerce` entry in the trend's evidence pool is a product page the enrichment agent *cited* as proof the trend is real. A sourced product is a catalog item a different agent matched so we can sell against it. Different agents, different tables, different purpose.

---

For column types, null semantics and the full object shape, see the [Data Contract](../data-contract.md#product-sourcing).

← Back to [field reference](../index.md#at-a-glance--field-reference)
