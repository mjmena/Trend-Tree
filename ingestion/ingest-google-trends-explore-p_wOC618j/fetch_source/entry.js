// Ingest Google Trends Explore — fetch_source
//
// Fetches rising/related queries from the Trends Explore API for a fixed
// seed list of category keywords. Runs on a 4h interval — Explore data
// uses a 7-day rolling window so sub-hour polling adds no signal and
// dramatically increases 429 risk on the unauthenticated endpoint.

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
    console.log(`    Rate limited on '${keyword}', waiting 60s...`);
    await sleep(60000);
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

  await sleep(1500);

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

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const signals = [];

  for (const rankedList of rqData?.default?.rankedList || []) {
    for (const kw of rankedList.rankedKeyword || []) {
      const query = kw.query || "";
      const value = kw.formattedValue || "";
      const isRising = value.includes("%") || value === "Breakout";

      const rqExploreUrl = `https://trends.google.com/trends/explore?q=${query.replace(/\s+/g, "+")}&geo=${GEO}`;
      signals.push({
        SIGNAL_ID: rqExploreUrl,
        URL: rqExploreUrl,
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

    for (const catName of ACTIVE_CATEGORIES) {
      console.log(`Category: ${catName}`);
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
        await sleep(5000);
      }
    }

    if (errors.length) {
      console.log(`\nErrors: ${errors.length} failures`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`\nTotal: ${allSignals.length} Google Trends Explore signals`);
    $.export("$summary", `${allSignals.length} Google Trends Explore signals`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
      errors,
    };
  },
});
