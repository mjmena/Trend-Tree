// Ingest Google Trends RSS — fetch_source
//
// Pulls real-time trending searches from the Google Trends RSS feed.
// The feed updates every ~10 minutes with a rolling window of ~10 items,
// so this workflow runs every 15 minutes to avoid gaps.
// Related queries (Explore API) are handled by ingest-google-trends-explore.

import { XMLParser } from "fast-xml-parser";

const GEO = "US";

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
  if (!channel) return [];

  const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  const signals = [];

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

    let ts = pubDate;
    try {
      const d = new Date(pubDate);
      if (!isNaN(d)) ts = d.toISOString().replace("T", " ").slice(0, 19);
    } catch {}

    // SIGNAL_ID is the trends.google.com explore URL — cross-source dedup key.
    const exploreUrl = `https://trends.google.com/trends/explore?q=${title.replace(/\s+/g, "+")}&geo=${GEO}`;
    signals.push({
      SIGNAL_ID: exploreUrl,
      URL: exploreUrl,
      SOURCE_NAME: "google_trends_rss",
      SIGNAL_TIMESTAMP: ts,
      SIGNAL_TITLE: title,
      SIGNAL_TEXT: `Trending: ${title} (${traffic} searches)`,
      METADATA: JSON.stringify({
        geo: GEO,
        type: "daily_trending",
        approx_traffic: traffic,
        news_items: newsArr,
      }),
    });
  }

  return signals;
}

export default defineComponent({
  async run({ $ }) {
    const cookieJar = [];
    await fetchWithCookies("https://trends.google.com/", cookieJar);

    let signals = [];
    try {
      signals = await fetchRssTrends(cookieJar);
      console.log(`RSS: ${signals.length} trending items`);
    } catch (e) {
      console.log(`RSS fetch failed: ${e.message}`);
      throw e;
    }

    $.export("$summary", `${signals.length} Google Trends RSS signals`);
    return {
      signals,
      signals_json: JSON.stringify(signals),
      count: signals.length,
    };
  },
});
