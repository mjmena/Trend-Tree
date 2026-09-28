// Tests for the Shopify storefront products.json sweep (CRMA-777).
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchStorefrontProducts, StorefrontFeedError } from "./storefront_feed.mjs";

const STORE = "https://shop.example.com";

// A fake fetch serving `pages` (1-indexed) and recording every URL asked for.
function fakeFetch(pages, { status = {}, body = {} } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const code = status[page] ?? 200;
    const text = body[page] ?? JSON.stringify({ products: pages[page - 1] ?? [] });
    return {
      ok: code >= 200 && code < 300,
      status: code,
      text: async () => text,
    };
  };
  return { impl, calls };
}

const products = (prefix, n) => Array.from({ length: n }, (_, i) => ({ handle: `${prefix}-${i}` }));

test("pages with limit+page until an empty page, and returns every product in order", async () => {
  const { impl, calls } = fakeFetch([products("a", 3), products("b", 2)]);
  const out = await fetchStorefrontProducts({ storeUrl: STORE, fetchImpl: impl, pageSize: 3 });
  assert.deepEqual(
    out.products.map((p) => p.handle),
    ["a-0", "a-1", "a-2", "b-0", "b-1"],
  );
  assert.equal(out.pages, 3);
  assert.deepEqual(calls, [
    `${STORE}/products.json?limit=3&page=1`,
    `${STORE}/products.json?limit=3&page=2`,
    `${STORE}/products.json?limit=3&page=3`,
  ]);
});

test("an empty page 1 is a hard failure, never an empty catalog", async () => {
  const { impl } = fakeFetch([]);
  await assert.rejects(
    fetchStorefrontProducts({ storeUrl: STORE, fetchImpl: impl }),
    (err) => err instanceof StorefrontFeedError && /page 1 returned no products/.test(err.message),
  );
});

test("a non-200 on any page is a hard failure — a 401 names storefront password protection", async () => {
  const { impl } = fakeFetch([products("a", 2)], { status: { 1: 401 } });
  await assert.rejects(
    fetchStorefrontProducts({ storeUrl: STORE, fetchImpl: impl }),
    (err) => err instanceof StorefrontFeedError && /HTTP 401/.test(err.message) && /password/.test(err.message),
  );

  const later = fakeFetch([products("a", 2), products("b", 2)], { status: { 2: 503 } });
  await assert.rejects(
    fetchStorefrontProducts({ storeUrl: STORE, fetchImpl: later.impl, pageSize: 2 }),
    (err) => err instanceof StorefrontFeedError && /page 2/.test(err.message) && /HTTP 503/.test(err.message),
  );
});

test("a body that is not JSON (e.g. the storefront password page) is a hard failure", async () => {
  const { impl } = fakeFetch([], { body: { 1: "<html>Enter store using password</html>" } });
  await assert.rejects(
    fetchStorefrontProducts({ storeUrl: STORE, fetchImpl: impl }),
    (err) => err instanceof StorefrontFeedError && /not JSON/.test(err.message),
  );
});

test("JSON without a products array is a hard failure", async () => {
  const { impl } = fakeFetch([], { body: { 1: JSON.stringify({ errors: "Not Found" }) } });
  await assert.rejects(
    fetchStorefrontProducts({ storeUrl: STORE, fetchImpl: impl }),
    (err) => err instanceof StorefrontFeedError && /no products array/.test(err.message),
  );
});

test("a feed that never returns an empty page stops at maxPages and fails rather than looping", async () => {
  const impl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ products: products("x", 1) }) });
  await assert.rejects(
    fetchStorefrontProducts({ storeUrl: STORE, fetchImpl: impl, maxPages: 4 }),
    (err) => err instanceof StorefrontFeedError && /4 pages/.test(err.message),
  );
});

test("a network error propagates as a hard failure", async () => {
  const impl = async () => {
    throw new Error("getaddrinfo ENOTFOUND shop.example.com");
  };
  await assert.rejects(
    fetchStorefrontProducts({ storeUrl: STORE, fetchImpl: impl }),
    (err) => err instanceof StorefrontFeedError && /ENOTFOUND/.test(err.message),
  );
});
