// storefront_feed.mjs — one full sweep of a Shopify store's public
// products.json feed (CRMA-777).
//
// The feed needs no credential (CRMA-747, resolved 2026-09-21), pages with
// `limit` + `page`, and ends with an empty page — verified on
// shoptrendhunter on 2026-09-21: no repeat-last-page artifact.
//
// EVERY ANOMALY IS A HARD FAILURE. The sweep is also the delist signal — a
// product missing from it is soft-delisted — so a sweep that silently came
// back short would delist real products. Hence: a non-200 on any page, a body
// that is not a JSON products array, an empty page 1, and a feed that never
// ends all throw StorefrontFeedError, and the caller must write nothing.
// The feed can go dark again: it returned 401 while the merchant had
// storefront password protection on (August 2026).

export const DEFAULT_PAGE_SIZE = 250; // Shopify's per-page maximum
export const DEFAULT_MAX_PAGES = 40; // 10,000 products; the store has ~200

export class StorefrontFeedError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorefrontFeedError";
  }
}

// Returns { products, pages } — `products` are the feed's raw product objects
// in feed order, `pages` the number of requests made (including the final
// empty page).
export async function fetchStorefrontProducts({
  storeUrl,
  fetchImpl = fetch,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
}) {
  const base = String(storeUrl).replace(/\/+$/, "");
  const all = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${base}/products.json?limit=${pageSize}&page=${page}`;
    const batch = await fetchPage(url, page, fetchImpl);
    if (batch.length === 0) {
      if (page === 1) {
        throw new StorefrontFeedError(
          `${url}: page 1 returned no products — refusing to treat the catalog as empty`,
        );
      }
      return { products: all, pages: page };
    }
    all.push(...batch);
  }

  throw new StorefrontFeedError(
    `${base}/products.json never returned an empty page within ${maxPages} pages — refusing a sweep that may not have ended`,
  );
}

async function fetchPage(url, page, fetchImpl) {
  let res;
  let text;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    text = await res.text();
  } catch (err) {
    throw new StorefrontFeedError(`${url}: request failed on page ${page}: ${err.message}`);
  }

  if (res.status !== 200) {
    const hint = res.status === 401 ? " (storefront password protection is probably back on — see CRMA-747)" : "";
    throw new StorefrontFeedError(`${url}: HTTP ${res.status} on page ${page}${hint}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StorefrontFeedError(`${url}: response on page ${page} is not JSON: ${text.slice(0, 120)}`);
  }
  if (!Array.isArray(body?.products)) {
    throw new StorefrontFeedError(`${url}: response on page ${page} has no products array`);
  }
  return body.products;
}
