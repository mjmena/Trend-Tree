// Ingest Google Trends RSS — fetch_source
//
// Pulls real-time trending searches from the Google Trends RSS feed.
// The feed updates every ~10 minutes with a rolling window of ~10 items,
// so this workflow runs every 15 minutes to avoid gaps.
// Related queries (Explore API) are handled by ingest-google-trends-explore.

import { XMLParser } from "fast-xml-parser";

const GEO = "US";

function extractPublisherDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function fetchWithCookies(url, cookieJar, opts = {}) {
  const headers = { ...(opts.headers || {}), cookie: cookieJar.join("; ") };
  const resp = await fetch(url, { ...opts, headers, redirect: "follow" });
  const setCookies = resp.headers.getSetCookie?.() || [];
  for (const c of setCookies) cookieJar.push(c.split(";")[0]);
  return resp;
}

async function fetchRssTrends(cookieJar) {
  const resp = await fetchWithCookies(
    `https://trends.google.com/trending/rss?geo=${GEO}`,
    cookieJar,
  );
  const xml = await resp.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xml);

  const channel = doc?.rss?.channel;
  if (!channel) return { signals: [], emptyQueries: 0, skippedUrls: 0 };

  const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  const signals = [];
  let emptyQueries = 0;
  let skippedUrls = 0;

  for (const item of items) {
    const title = item.title || "";
    const traffic = item["ht:approx_traffic"] || "";
    const pubDate = item.pubDate || "";

    let newsItems = item["ht:news_item"] || [];
    if (!Array.isArray(newsItems)) newsItems = newsItems ? [newsItems] : [];

    const newsArr = newsItems.map((ni) => ({
      article_title: ni["ht:news_item_title"] || "",
      url: ni["ht:news_item_url"] || "",
      source: ni["ht:news_item_source"] || "",
    }));

    if (newsArr.length === 0) {
      emptyQueries += 1;
      continue;
    }

    let ts = pubDate;
    try {
      const d = new Date(pubDate);
      if (!isNaN(d)) ts = d.toISOString().replace("T", " ").slice(0, 19);
    } catch {}

    for (const ni of newsArr) {
      if (!ni.url) {
        skippedUrls += 1;
        continue;
      }
      const publisherDomain = extractPublisherDomain(ni.url);
      if (!publisherDomain) {
        skippedUrls += 1;
        continue;
      }
      signals.push({
        SIGNAL_ID: ni.url,
        URL: ni.url,
        SOURCE_NAME: "google_trends_rss",
        SIGNAL_TIMESTAMP: ts,
        SIGNAL_TITLE: ni.article_title,
        SIGNAL_TEXT: `${ni.article_title} — via ${publisherDomain}`,
        METADATA: JSON.stringify({
          geo: GEO,
          type: "flattened_news_item",
          gt_trending_query: title,
          gt_approx_traffic: traffic,
          publisher: publisherDomain,
          url: ni.url,
        }),
      });
    }
  }

  return { signals, emptyQueries, skippedUrls };
}

export default defineComponent({
  async run({ $ }) {
    const cookieJar = [];
    await fetchWithCookies("https://trends.google.com/", cookieJar);

    let signals = [];
    let emptyQueries = 0;
    let skippedUrls = 0;
    try {
      ({ signals, emptyQueries, skippedUrls } = await fetchRssTrends(cookieJar));
      console.log(
        `RSS: ${signals.length} flattened signals, ${emptyQueries} empty queries, ${skippedUrls} skipped URLs`,
      );
    } catch (e) {
      console.log(`RSS fetch failed: ${e.message}`);
      throw e;
    }

    $.export(
      "$summary",
      `${signals.length} flattened signals (${emptyQueries} queries dropped: empty news_items, ${skippedUrls} skipped: malformed URLs)`,
    );
    return {
      signals,
      signals_json: JSON.stringify(signals),
      count: signals.length,
      empty_news_items_skipped: emptyQueries,
      malformed_urls_skipped: skippedUrls,
    };
  },
});
