// Ingest Google Trends — fetch_source
//
// Pulls daily trending searches from the Google Trends RSS feed and
// rising/related queries from the Explore API for a fixed seed list
// of category keywords. No API key required — all calls go through
// the public web endpoint with cookie-jar XSSI stripping.
//
// Port of trends-sql/pipedream/ingestion/ingest_google_trends.mjs.

import { XMLParser } from "fast-xml-parser";

const CATEGORIES = {
  health: ["wellness", "skincare", "supplements", "fitness trends", "diet"],
  food: ["food trends", "cooking trends", "healthy recipes", "meal prep", "restaurant trends"],
  tech: ["consumer tech", "smart home", "wearable technology", "productivity apps", "AI tools"],
  travel: ["travel trends", "budget travel", "solo travel", "vacation destinations", "travel hacks"],
};
const ACTIVE_CATEGORIES = ["health", "food", "tech"];
const GEO = "US";

function stripXssi(text) {
  const idx = text.indexOf("\n");
  return idx >= 0 && idx < 10 ? text.slice(idx + 1) : text;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    let dateKey = "";
    try {
      const d = new Date(pubDate);
      if (!isNaN(d)) {
        ts = d.toISOString().replace("T", " ").slice(0, 19);
        dateKey = d.toISOString().slice(0, 10);
      }
    } catch {}

    // SIGNAL_ID is the trends.google.com explore URL for the trending query —
    // slice-4 cross-source dedup key. Same shape as the related-queries path.
    const rssExploreUrl = `https://trends.google.com/trends/explore?q=${title.replace(/\s+/g, "+")}&geo=${GEO}`;
    signals.push({
      SIGNAL_ID: rssExploreUrl,
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

async function fetchRelatedQueries(cookieJar, keyword, categoryName) {
  const req = JSON.stringify({
    comparisonItem: [{ keyword, geo: GEO, time: "now 7-d" }],
    category: 0,
    property: "",
  });
  const exploreUrl = `https://trends.google.com/trends/api/explore?hl=en-US&tz=300&req=${encodeURIComponent(req)}`;

  let resp;
  try {
    resp = await fetchWithCookies(exploreUrl, cookieJar);
  } catch {
    return [];
  }

  if (resp.status === 429) {
    console.log(`    Rate limited on '${keyword}', waiting 30s...`);
    await sleep(30000);
    resp = await fetchWithCookies(exploreUrl, cookieJar);
  }
  if (!resp.ok) return [];

  const body = await resp.text();
  let data;
  try {
    data = JSON.parse(stripXssi(body));
  } catch (e) {
    console.log(`    Warning: failed to parse explore response for '${keyword}': ${e.message}`);
    return [];
  }

  const rqWidget = (data.widgets || []).find((w) => w.id === "RELATED_QUERIES");
  if (!rqWidget) return [];

  await sleep(1000);

  const rqReq = encodeURIComponent(JSON.stringify(rqWidget.request));
  const rqToken = encodeURIComponent(rqWidget.token);
  const rqUrl = `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=300&req=${rqReq}&token=${rqToken}`;

  const rqResp = await fetchWithCookies(rqUrl, cookieJar);
  if (!rqResp.ok) return [];

  const rqBody = await rqResp.text();
  let rqData;
  try {
    rqData = JSON.parse(stripXssi(rqBody));
  } catch (e) {
    console.log(`    Warning: failed to parse related queries for '${keyword}': ${e.message}`);
    return [];
  }

  const nowDate = new Date();
  const now = nowDate.toISOString().replace("T", " ").slice(0, 19);
  const todayKey = nowDate.toISOString().slice(0, 10);
  const signals = [];

  for (const rankedList of rqData?.default?.rankedList || []) {
    for (const kw of rankedList.rankedKeyword || []) {
      const query = kw.query || "";
      const value = kw.formattedValue || "";
      const isRising = value.includes("%") || value === "Breakout";

      // SIGNAL_ID is the trends.google.com explore URL for the query —
      // slice-4 cross-source dedup key. Matches SQL backfill construction.
      const rqExploreUrl = `https://trends.google.com/trends/explore?q=${query.replace(/\s+/g, "+")}&geo=${GEO}`;
      signals.push({
        SIGNAL_ID: rqExploreUrl,
        SOURCE_NAME: "google_trends_explore",
        SIGNAL_TIMESTAMP: now,
        SIGNAL_TITLE: query,
        SIGNAL_TEXT: `Related to '${keyword}': ${query} (${value})`,
        METADATA: JSON.stringify({
          geo: GEO,
          type: isRising ? "rising" : "top",
          seed_keyword: keyword,
          category: categoryName,
          value,
        }),
      });
    }
  }

  return signals;
}

export default defineComponent({
  async run({ $ }) {
    const cookieJar = [];
    await fetchWithCookies("https://trends.google.com/", cookieJar);
    await sleep(1000);

    const allSignals = [];
    const errors = [];

    console.log(`Fetching RSS trends (geo=${GEO})...`);
    try {
      const rssSignals = await fetchRssTrends(cookieJar);
      allSignals.push(...rssSignals);
      console.log(`  -> ${rssSignals.length} trends`);
    } catch (e) {
      errors.push(`RSS: ${e.message}`);
      console.log(`  -> ERROR: ${e.message}`);
    }

    for (const catName of ACTIVE_CATEGORIES) {
      console.log(`\nCategory: ${catName}`);
      for (const kw of CATEGORIES[catName]) {
        console.log(`  Seed: '${kw}'...`);
        try {
          const related = await fetchRelatedQueries(cookieJar, kw, catName);
          allSignals.push(...related);
          const rising = related.filter((s) => JSON.parse(s.METADATA).type === "rising").length;
          console.log(`    -> ${related.length} queries (${rising} rising)`);
        } catch (e) {
          errors.push(`'${kw}': ${e.message}`);
          console.log(`    -> ERROR: ${e.message}`);
        }
        await sleep(3000);
      }
    }

    if (errors.length) {
      console.log(`\nErrors: ${errors.length} failures`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`\nTotal: ${allSignals.length} Google Trends signals`);
    $.export("$summary", `${allSignals.length} Google Trends signals`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
      errors,
    };
  },
});
