// Tests for the TikTok ingest orchestration (CRMA-1337).
// Run: scripts/test_services_lib.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SERPAPI_CALLS, runTikTokIngest, SEED_QUERIES } from "./tiktok_ingest.mjs";
import { SerpApiError } from "./sources/serpapi.mjs";

const NOW = new Date("2026-09-28T12:00:00Z");
const FILTER_MODEL = "gemini-3.7-flash";

// A TikTok video ID whose top 32 bits are the given UTC time.
const idAt = (iso, low = 1) => ((BigInt(Math.floor(Date.parse(iso) / 1000)) << 32n) + BigInt(low)).toString();

const video = (id, title, extra = {}) => ({
  position: 1,
  title,
  link: `https://www.tiktok.com/@maker/video/${id}?q=site%3Atiktok.com&t=1759000000`,
  source: "TikTok",
  channel: "maker",
  duration: "0:31",
  ...extra,
});

// A fake SerpApi search: answers by seed, records every params object.
function fakeSearch(bySeed = {}) {
  const calls = [];
  const search = async (params) => {
    calls.push(params);
    const seed = params.q.replace(/^site:tiktok\.com /, "");
    return { short_video_results: bySeed[seed] ?? [] };
  };
  return { search, calls };
}

// A fake filter: keeps titles containing "KEEP", records each batch.
function fakeFilter(keep = (t) => t.includes("KEEP")) {
  const batches = [];
  const filter = async (titles) => {
    batches.push(titles);
    return titles.map((t) => ({ keep: keep(t), phrase: keep(t) ? t.replace(/ KEEP$/, "") : "" }));
  };
  return { filter, batches };
}

// A fake Snowflake: answers the existing-video-ID read, records every statement.
function fakeQuery(existingIds = []) {
  const statements = [];
  const query = async (sql, binds) => {
    statements.push({ sql, binds });
    if (/^SELECT/.test(sql.trim())) return existingIds.map((id) => ({ VIDEO_ID: id }));
    return [{ MERGE_EXTERNAL_SIGNALS: { batches: 1, signals: 1 } }];
  };
  return { query, statements };
}

const oneSeed = (seed = "skincare", vertical = "beauty_personal_care") => ({ [vertical]: [seed] });

const writtenRows = (statements) => {
  const merge = statements.find((s) => /MERGE_EXTERNAL_SIGNALS/.test(s.sql));
  return merge ? JSON.parse(merge.binds[0]) : [];
};

const run = (overrides) =>
  runTikTokIngest({ now: () => NOW, filterModel: FILTER_MODEL, seeds: oneSeed(), ...overrides });

test("the seed list is fixed: discovery's 6 verticals, 3-5 atomic terms each", () => {
  assert.deepEqual(Object.keys(SEED_QUERIES).sort(), [
    "beauty_personal_care",
    "commerce_retail",
    "fashion_apparel",
    "food_beverage",
    "home_lifestyle",
    "wellness",
  ]);
  for (const [vertical, seeds] of Object.entries(SEED_QUERIES)) {
    assert.ok(seeds.length >= 3 && seeds.length <= 5, vertical);
    for (const s of seeds) assert.match(s, /^[a-z]+$/, `${vertical}: "${s}" is not one atomic term`);
  }
  assert.ok(Object.isFrozen(SEED_QUERIES));
});

test("every search is google_short_videos, site:tiktok.com <seed>, past day, US English", async () => {
  const { search, calls } = fakeSearch();
  const { filter } = fakeFilter();
  const { query } = fakeQuery();
  await run({ search, filter, query });
  assert.deepEqual(calls, [
    { engine: "google_short_videos", q: "site:tiktok.com skincare", tbs: "qdr:d", gl: "us", hl: "en" },
  ]);
});

test("the default run searches every seed in the fixed list, once", async () => {
  const { search, calls } = fakeSearch();
  const { filter } = fakeFilter();
  const { query } = fakeQuery();
  await runTikTokIngest({ search, filter, query, now: () => NOW, filterModel: FILTER_MODEL });
  const expected = Object.values(SEED_QUERIES).flat().map((s) => `site:tiktok.com ${s}`);
  assert.deepEqual(calls.map((c) => c.q), expected);
});

test("one run makes at most 50 SerpApi calls, however long the seed list is", async () => {
  const seeds = { wellness: Array.from({ length: 80 }, (_, i) => `seed${i}`) };
  const { search, calls } = fakeSearch();
  const { filter } = fakeFilter();
  const { query } = fakeQuery();
  const summary = await run({ search, filter, query, seeds });
  assert.equal(MAX_SERPAPI_CALLS, 50);
  assert.equal(calls.length, 50);
  assert.equal(summary.serpapiCalls, 50);
  assert.equal(summary.seedsSkippedForBudget, 30);
});

test("searches run at most 4 at a time, and results keep seed order", async () => {
  const seeds = { wellness: Array.from({ length: 10 }, (_, i) => `seed${i}`) };
  let inFlight = 0;
  let peak = 0;
  const search = async (params) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    const i = Number(params.q.match(/seed(\d+)/)[1]);
    await new Promise((r) => setTimeout(r, (10 - i) * 2));
    inFlight--;
    return { short_video_results: [video(idAt("2026-09-28T02:00:00Z", i + 1), `title ${i}`)] };
  };
  const { filter, batches } = fakeFilter();
  const { query } = fakeQuery();
  await run({ search, filter, query, seeds });
  assert.equal(peak, 4);
  assert.deepEqual(batches[0], Array.from({ length: 10 }, (_, i) => `title ${i}`));
});

test("results with an empty title never reach the filter", async () => {
  const { search } = fakeSearch({
    skincare: [video(idAt("2026-09-28T02:00:00Z", 1), "  "), video(idAt("2026-09-28T02:00:00Z", 2), "Rice water toner KEEP"), video(idAt("2026-09-28T02:00:00Z", 3), undefined)],
  });
  const { filter, batches } = fakeFilter();
  const { query } = fakeQuery();
  const summary = await run({ search, filter, query });
  assert.deepEqual(batches, [["Rice water toner KEEP"]]);
  assert.equal(summary.emptyTitles, 2);
});

test("only titles the filter keeps are written", async () => {
  const { search } = fakeSearch({
    skincare: [
      video(idAt("2026-09-28T02:00:00Z", 1), "Rice water toner KEEP"),
      video(idAt("2026-09-28T02:00:00Z", 2), "My skincare routine"),
    ],
  });
  const { filter } = fakeFilter();
  const { query, statements } = fakeQuery();
  const summary = await run({ search, filter, query });
  assert.deepEqual(writtenRows(statements).map((r) => r.SIGNAL_TITLE), ["Rice water toner KEEP"]);
  assert.equal(summary.filterKept, 1);
  assert.equal(summary.filterDropped, 1);
});

test("titles go to the filter in batches of about 40", async () => {
  const results = Array.from({ length: 95 }, (_, i) => video(idAt("2026-09-28T02:00:00Z", i + 1), `title ${i}`));
  const { search } = fakeSearch({ skincare: results });
  const { filter, batches } = fakeFilter();
  const { query } = fakeQuery();
  await run({ search, filter, query });
  assert.deepEqual(batches.map((b) => b.length), [40, 40, 15]);
});

test("a filter that returns the wrong number of verdicts fails the run before any statement", async () => {
  const { search } = fakeSearch({ skincare: [video(idAt("2026-09-28T02:00:00Z"), "Rice water toner KEEP")] });
  const filter = async () => [];
  const { query, statements } = fakeQuery();
  await assert.rejects(run({ search, filter, query }), /verdict/);
  assert.equal(statements.length, 0);
});

test("a video already ingested as tiktok is skipped", async () => {
  const oldId = idAt("2026-09-28T02:00:00Z", 1);
  const newId = idAt("2026-09-28T02:00:00Z", 2);
  const { search } = fakeSearch({
    skincare: [video(oldId, "Rice water toner KEEP"), video(newId, "Snail mucin toner KEEP")],
  });
  const { filter } = fakeFilter();
  const { query, statements } = fakeQuery([oldId]);
  const summary = await run({ search, filter, query });

  const read = statements[0];
  assert.match(read.sql, /FROM MCC_RAW\.MARKETING_DEV\.STG_EXTERNAL_SIGNALS/);
  assert.match(read.sql, /SOURCE_NAME = 'tiktok'/);
  assert.match(read.sql, /METADATA:video_id/);
  assert.deepEqual(JSON.parse(read.binds[0]).sort(), [newId, oldId].sort());
  assert.deepEqual(writtenRows(statements).map((r) => JSON.parse(r.METADATA).video_id), [newId]);
  assert.equal(summary.alreadyIngested, 1);
});

test("a video returned twice in one run is filtered and written once", async () => {
  const id = idAt("2026-09-28T02:00:00Z");
  const seeds = { beauty_personal_care: ["skincare", "toner"] };
  const { search } = fakeSearch({
    skincare: [video(id, "Rice water toner KEEP")],
    toner: [video(id, "Rice water toner KEEP", { link: `https://www.tiktok.com/@maker/video/${id}` })],
  });
  const { filter, batches } = fakeFilter();
  const { query, statements } = fakeQuery();
  const summary = await run({ search, filter, query, seeds });
  assert.equal(batches.flat().length, 1);
  assert.equal(writtenRows(statements).length, 1);
  assert.equal(summary.duplicatesInRun, 1);
});

test("a result that is not a TikTok video link is dropped", async () => {
  const { search } = fakeSearch({
    skincare: [
      video("x", "Rice water toner KEEP", { link: "https://www.tiktok.com/@maker" }),
      video("x", "Snail mucin KEEP", { link: "https://www.youtube.com/shorts/abc" }),
    ],
  });
  const { filter, batches } = fakeFilter();
  const { query, statements } = fakeQuery();
  const summary = await run({ search, filter, query });
  assert.equal(batches.length, 0);
  assert.equal(statements.length, 0);
  assert.equal(summary.notVideoLinks, 2);
});

test("each row: link without query string, title, NULL text, post time decoded from the video ID", async () => {
  const id = idAt("2026-09-28T03:04:05Z");
  const { search } = fakeSearch({ skincare: [video(id, "Rice water toner KEEP")] });
  const { filter } = fakeFilter();
  const { query, statements } = fakeQuery();
  await run({ search, filter, query });

  const [row] = writtenRows(statements);
  assert.deepEqual(
    { ...row, METADATA: JSON.parse(row.METADATA) },
    {
      SIGNAL_ID: `https://www.tiktok.com/@maker/video/${id}`,
      URL: `https://www.tiktok.com/@maker/video/${id}`,
      SOURCE_NAME: "tiktok",
      SIGNAL_TIMESTAMP: "2026-09-28 03:04:05",
      SIGNAL_TITLE: "Rice water toner KEEP",
      SIGNAL_TEXT: null,
      METADATA: {
        video_id: id,
        channel: "maker",
        duration: "0:31",
        seed_query: "skincare",
        vertical: "beauty_personal_care",
        filter_model: FILTER_MODEL,
        filter_verdict: { keep: true, phrase: "Rice water toner" },
        timestamp_source: "video_id",
      },
    },
  );
  assert.equal("search_query" in JSON.parse(row.METADATA), false);
});

test("SIGNAL_TIMESTAMP falls back to fetch time when the decoded time is outside the past-day window", async () => {
  const stale = idAt("2026-09-20T00:00:00Z", 1);
  const future = idAt("2026-09-29T12:00:00Z", 2);
  const { search } = fakeSearch({
    skincare: [video(stale, "Rice water toner KEEP"), video(future, "Snail mucin toner KEEP")],
  });
  const { filter } = fakeFilter();
  const { query, statements } = fakeQuery();
  await run({ search, filter, query });
  for (const row of writtenRows(statements)) {
    assert.equal(row.SIGNAL_TIMESTAMP, "2026-09-28 12:00:00");
    assert.equal(JSON.parse(row.METADATA).timestamp_source, "fetch");
  }
});

test("SIGNAL_TIMESTAMP falls back to fetch time when the video ID does not decode", async () => {
  const { search } = fakeSearch({ skincare: [video("12345", "Rice water toner KEEP")] });
  const { filter } = fakeFilter();
  const { query, statements } = fakeQuery();
  await run({ search, filter, query });
  const [row] = writtenRows(statements);
  assert.equal(row.SIGNAL_TIMESTAMP, "2026-09-28 12:00:00");
  assert.equal(JSON.parse(row.METADATA).timestamp_source, "fetch");
});

test("rows go through the shared MERGE_EXTERNAL_SIGNALS procedure into STG_EXTERNAL_SIGNALS", async () => {
  const { search } = fakeSearch({ skincare: [video(idAt("2026-09-28T02:00:00Z"), "Rice water toner KEEP")] });
  const { filter } = fakeFilter();
  const { query, statements } = fakeQuery();
  await run({ search, filter, query });
  const writes = statements.filter((s) => !/^SELECT/.test(s.sql.trim()));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /^CALL MCC_RAW\.MARKETING_DEV\.MERGE_EXTERNAL_SIGNALS\(\?, '', 500, 'STG_EXTERNAL_SIGNALS'\)$/);
});

test("a SerpApi failure on any search sends no Snowflake statement and never calls the filter", async () => {
  const seeds = { wellness: ["supplement", "sleep"] };
  const search = async (params) => {
    if (params.q.endsWith("sleep")) throw new SerpApiError("timed out", { kind: "timeout" });
    return { short_video_results: [video(idAt("2026-09-28T02:00:00Z"), "Magnesium glycinate KEEP")] };
  };
  const { filter, batches } = fakeFilter();
  const { query, statements } = fakeQuery();
  await assert.rejects(run({ search, filter, query, seeds }), SerpApiError);
  assert.equal(batches.length, 0);
  assert.equal(statements.length, 0);
});

test("a filter failure sends no Snowflake statement", async () => {
  const { search } = fakeSearch({ skincare: [video(idAt("2026-09-28T02:00:00Z"), "Rice water toner KEEP")] });
  const filter = async () => {
    throw new Error("Gemini HTTP 503");
  };
  const { query, statements } = fakeQuery();
  await assert.rejects(run({ search, filter, query }), /503/);
  assert.equal(statements.length, 0);
});

test("a run where the filter keeps nothing sends no Snowflake statement", async () => {
  const { search } = fakeSearch({ skincare: [video(idAt("2026-09-28T02:00:00Z"), "My skincare routine")] });
  const { filter } = fakeFilter();
  const { query, statements } = fakeQuery();
  const summary = await run({ search, filter, query });
  assert.equal(statements.length, 0);
  assert.equal(summary.written, 0);
});

test("a MERGE that reports an error fails the run, so the job's retry fires", async () => {
  const { search } = fakeSearch({ skincare: [video(idAt("2026-09-28T02:00:00Z"), "Rice water toner KEEP")] });
  const { filter } = fakeFilter();
  const query = async (sql) =>
    /^SELECT/.test(sql.trim()) ? [] : [{ MERGE_EXTERNAL_SIGNALS: JSON.stringify({ error: "invalid JSON: x", signals: 0 }) }];
  await assert.rejects(run({ search, filter, query }), /MERGE_EXTERNAL_SIGNALS.*invalid JSON/);
});

test("no MERGE runs when every kept video is already ingested", async () => {
  const id = idAt("2026-09-28T02:00:00Z");
  const { search } = fakeSearch({ skincare: [video(id, "Rice water toner KEEP")] });
  const { filter } = fakeFilter();
  const { query, statements } = fakeQuery([id]);
  const summary = await run({ search, filter, query });
  assert.equal(statements.filter((s) => /MERGE/.test(s.sql)).length, 0);
  assert.equal(summary.written, 0);
});
