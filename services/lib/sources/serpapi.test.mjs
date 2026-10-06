// Tests for the shared SerpApi client (CRMA-1337; the Reddit oracle, CRMA-1339, reuses it).
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerpApiClient, SerpApiError } from "./serpapi.mjs";

const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return typeof response === "function" ? response(url, init) : response;
  };
  return { fetchImpl, calls };
}

const params = { engine: "google_short_videos", q: "site:tiktok.com skincare", tbs: "qdr:d", gl: "us", hl: "en" };

test("sends every parameter plus the key to serpapi.com/search.json and returns the parsed body", async () => {
  const { fetchImpl, calls } = fakeFetch(jsonResponse(200, { short_video_results: [{ title: "a" }] }));
  const client = createSerpApiClient({ apiKey: "k-123", fetchImpl });
  const body = await client.search(params);

  assert.deepEqual(body, { short_video_results: [{ title: "a" }] });
  const { url } = calls[0];
  assert.equal(url.origin + url.pathname, "https://serpapi.com/search.json");
  assert.deepEqual(Object.fromEntries(url.searchParams), { ...params, api_key: "k-123" });
});

test("an HTTP failure throws SerpApiError kind http, with the status and without the key", async () => {
  const { fetchImpl } = fakeFetch(jsonResponse(401, { error: "Invalid API key." }));
  const client = createSerpApiClient({ apiKey: "k-123", fetchImpl });
  await assert.rejects(client.search(params), (err) => {
    assert.ok(err instanceof SerpApiError);
    assert.equal(err.kind, "http");
    assert.equal(err.status, 401);
    assert.doesNotMatch(err.message, /k-123/);
    return true;
  });
});

test("a SerpApi error field on a 200 throws SerpApiError kind api", async () => {
  const { fetchImpl } = fakeFetch(jsonResponse(200, { error: "Your account has run out of searches." }));
  const client = createSerpApiClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.search(params), (err) => err instanceof SerpApiError && err.kind === "api" && /run out/.test(err.message));
});

test("Google's no-results answer is an empty result, not an error", async () => {
  const { fetchImpl } = fakeFetch(jsonResponse(200, { error: "Google hasn't returned any results for this query." }));
  const client = createSerpApiClient({ apiKey: "k", fetchImpl });
  const body = await client.search(params);
  assert.equal(body.error, undefined);
});

test("a body that is not JSON throws SerpApiError kind api", async () => {
  const { fetchImpl } = fakeFetch(jsonResponse(200, "<html>oops</html>"));
  const client = createSerpApiClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.search(params), (err) => err instanceof SerpApiError && err.kind === "api");
});

test("a request slower than the timeout throws SerpApiError kind timeout", async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const client = createSerpApiClient({ apiKey: "k", fetchImpl, timeoutMs: 10 });
  await assert.rejects(client.search(params), (err) => err instanceof SerpApiError && err.kind === "timeout");
});

test("a network failure throws SerpApiError kind network", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const client = createSerpApiClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.search(params), (err) => err instanceof SerpApiError && err.kind === "network");
});

test("refuses to build without a key", () => {
  assert.throws(() => createSerpApiClient({ apiKey: "", fetchImpl: async () => {} }), /apiKey/);
});
