// tiktok_ingest.mjs — one TikTok ingest run, SerpApi -> title filter ->
// STG_EXTERNAL_SIGNALS (CRMA-1337, spec docs/prd/serpapi-sources.md
// "TikTok ingester"). services/tiktok-ingest/ingest.mjs is the Cloud Run
// job's entrypoint and supplies the three I/O functions; everything between
// them is here so it runs under node:test without a network.
//
//   search(params) -> SerpApi body            (sources/serpapi.mjs)
//   filter(titles) -> [{ keep, phrase }]      (tiktok_filter.mjs), one verdict per title
//   query(sql, binds?) -> rows                (one Snowflake statement)
//
// The order is the safety property. Every search and every filter batch
// completes BEFORE the first Snowflake statement, so a SerpApi or Gemini
// failure sends nothing to Snowflake. The only statements are the dedup read
// and one MERGE_EXTERNAL_SIGNALS call.
//
// Evidence purity: the seed list is a fixed, outward-looking constant. No row
// exists because the pipeline asked for it, so METADATA never carries
// `search_query` (the agent-search-tool key, CONTEXT.md).

export const MAX_SERPAPI_CALLS = 50;
export const FILTER_BATCH_SIZE = 40;
// An uncached google_short_videos search took 34-66s on 2026-09-28, so 24
// sequential searches would take ~20 minutes. Waves of 4 keep a run to minutes.
export const SEARCH_CONCURRENCY = 4;
export const QUERY_WINDOW_MS = 24 * 60 * 60 * 1000; // tbs=qdr:d
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// Keyed by discovery's 6 verticals (CRMA-1320). One single-word term per
// seed: google_short_videos returns 0 for most multi-word queries, including
// the two-word `kitchen gadget` (CRMA-1325).
export const SEED_QUERIES = Object.freeze({
  wellness: Object.freeze(["supplement", "sleep", "probiotic", "workout"]),
  food_beverage: Object.freeze(["snack", "drink", "recipe", "dessert"]),
  beauty_personal_care: Object.freeze(["skincare", "makeup", "haircare", "fragrance"]),
  fashion_apparel: Object.freeze(["sneakers", "outfit", "jewelry", "handbag"]),
  home_lifestyle: Object.freeze(["kitchen", "decor", "cleaning", "gadget"]),
  commerce_retail: Object.freeze(["dupe", "costco", "aldi", "target"]),
});

const EXISTING_VIDEO_IDS_SQL = `SELECT DISTINCT METADATA:video_id::STRING AS VIDEO_ID
FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
WHERE SOURCE_NAME = 'tiktok'
  AND METADATA:video_id::STRING IN (SELECT value::STRING FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))))`;

const MERGE_SQL = "CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS(?, '', 500, 'STG_EXTERNAL_SIGNALS')";

export function buildSearchParams(seed) {
  return { engine: "google_short_videos", q: `site:tiktok.com ${seed}`, tbs: "qdr:d", gl: "us", hl: "en" };
}

// A TikTok video ID carries its post time, in UTC seconds, in its top 32 bits.
export function decodeVideoTime(videoId) {
  if (!/^\d+$/.test(String(videoId))) return null;
  const seconds = Number(BigInt(videoId) >> 32n);
  return seconds > 0 ? new Date(seconds * 1000) : null;
}

// "YYYY-MM-DD HH:MM:SS" in UTC, the shape every ingester hands the MERGE.
const toSignalTimestamp = (d) => d.toISOString().replace("T", " ").slice(0, 19);

function parseVideoLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!/(^|\.)tiktok\.com$/.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/@[^/]+\/video\/(\d+)\/?$/);
  if (!m) return null;
  url.search = "";
  url.hash = "";
  return { signalId: url.toString(), videoId: m[1] };
}

function postTime(videoId, fetchedAt) {
  const decoded = decodeVideoTime(videoId);
  const inWindow =
    decoded &&
    decoded.getTime() >= fetchedAt.getTime() - QUERY_WINDOW_MS &&
    decoded.getTime() <= fetchedAt.getTime() + FUTURE_SKEW_MS;
  return inWindow ? { at: decoded, source: "video_id" } : { at: fetchedAt, source: "fetch" };
}

export async function runTikTokIngest({
  search,
  filter,
  query,
  filterModel,
  now = () => new Date(),
  seeds = SEED_QUERIES,
  maxCalls = MAX_SERPAPI_CALLS,
  filterBatchSize = FILTER_BATCH_SIZE,
  searchConcurrency = SEARCH_CONCURRENCY,
}) {
  const plan = Object.entries(seeds).flatMap(([vertical, terms]) => terms.map((seed) => ({ vertical, seed })));
  const budgeted = plan.slice(0, maxCalls);
  const fetchedAt = now();

  const candidates = [];
  const seen = new Set();
  let results = 0;
  let emptyTitles = 0;
  let notVideoLinks = 0;
  let duplicatesInRun = 0;

  const bodies = [];
  for (let i = 0; i < budgeted.length; i += searchConcurrency) {
    const wave = budgeted.slice(i, i + searchConcurrency);
    bodies.push(...(await Promise.all(wave.map(({ seed }) => search(buildSearchParams(seed))))));
  }

  for (const [i, { vertical, seed }] of budgeted.entries()) {
    for (const r of bodies[i]?.short_video_results ?? []) {
      results++;
      const title = String(r.title ?? "").trim();
      if (!title) {
        emptyTitles++;
        continue;
      }
      const link = parseVideoLink(r.link);
      if (!link) {
        notVideoLinks++;
        continue;
      }
      if (seen.has(link.videoId)) {
        duplicatesInRun++;
        continue;
      }
      seen.add(link.videoId);
      candidates.push({ ...link, title, channel: r.channel ?? null, duration: r.duration ?? null, vertical, seed });
    }
  }

  const kept = [];
  for (let i = 0; i < candidates.length; i += filterBatchSize) {
    const batch = candidates.slice(i, i + filterBatchSize);
    const verdicts = await filter(batch.map((c) => c.title));
    if (!Array.isArray(verdicts) || verdicts.length !== batch.length) {
      throw new Error(`title filter returned ${verdicts?.length ?? "no"} verdicts for ${batch.length} titles`);
    }
    batch.forEach((c, j) => {
      if (verdicts[j]?.keep === true) kept.push({ ...c, phrase: String(verdicts[j].phrase ?? "") });
    });
  }

  const summary = {
    serpapiCalls: budgeted.length,
    seedsSkippedForBudget: plan.length - budgeted.length,
    results,
    emptyTitles,
    notVideoLinks,
    duplicatesInRun,
    filterKept: kept.length,
    filterDropped: candidates.length - kept.length,
    alreadyIngested: 0,
    written: 0,
    merge: null,
  };
  if (kept.length === 0) return summary;

  const existing = new Set(
    (await query(EXISTING_VIDEO_IDS_SQL, [JSON.stringify(kept.map((k) => k.videoId))])).map((r) => r.VIDEO_ID),
  );
  const fresh = kept.filter((k) => !existing.has(k.videoId));
  summary.alreadyIngested = kept.length - fresh.length;
  if (fresh.length === 0) return summary;

  const rows = fresh.map((k) => {
    const time = postTime(k.videoId, fetchedAt);
    return {
      SIGNAL_ID: k.signalId,
      URL: k.signalId,
      SOURCE_NAME: "tiktok",
      SIGNAL_TIMESTAMP: toSignalTimestamp(time.at),
      SIGNAL_TITLE: k.title,
      SIGNAL_TEXT: null,
      METADATA: JSON.stringify({
        video_id: k.videoId,
        channel: k.channel,
        duration: k.duration,
        seed_query: k.seed,
        vertical: k.vertical,
        filter_model: filterModel,
        filter_verdict: { keep: true, phrase: k.phrase },
        timestamp_source: time.source,
      }),
    };
  });

  // The procedure reports bad input as a returned { error }, not by throwing.
  const mergeRows = await query(MERGE_SQL, [JSON.stringify(rows)]);
  const raw = mergeRows?.[0]?.MERGE_EXTERNAL_SIGNALS ?? null;
  const merge = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (merge?.error) throw new Error(`MERGE_EXTERNAL_SIGNALS rejected ${rows.length} rows: ${merge.error}`);
  summary.merge = merge;
  summary.written = rows.length;
  return summary;
}
