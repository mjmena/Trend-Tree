// Search Google Trends (agent tool) — fetch_search
//
// Single-keyword call to Google Trends Explore API. Lifts the cookie-jar
// + XSSI stripping + 30s rate-limit backoff from
// ingestion/google-trends-p_3nC3xkk/fetch_source/entry.js.

function stripXssi(text) {
  const idx = text.indexOf("\n");
  return idx >= 0 && idx < 10 ? text.slice(idx + 1) : text;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithCookies(url, cookieJar, opts = {}) {
  const headers = { ...(opts.headers || {}), cookie: cookieJar.join("; ") };
  const resp = await fetch(url, { ...opts, headers, redirect: "follow" });
  const setCookies = resp.headers.getSetCookie?.() || [];
  for (const c of setCookies) cookieJar.push(c.split(";")[0]);
  return resp;
}

async function fetchRelatedQueries(cookieJar, keyword, geo, timeframe) {
  const req = JSON.stringify({
    comparisonItem: [{ keyword, geo, time: timeframe }],
    category: 0,
    property: "",
  });
  const exploreUrl = `https://trends.google.com/trends/api/explore?hl=en-US&tz=300&req=${encodeURIComponent(req)}`;

  let resp = await fetchWithCookies(exploreUrl, cookieJar);
  if (resp.status === 429) {
    console.log(`rate limited on '${keyword}', waiting 30s`);
    await sleep(30000);
    resp = await fetchWithCookies(exploreUrl, cookieJar);
  }
  if (!resp.ok) throw new Error(`Explore HTTP ${resp.status}`);

  const body = await resp.text();
  const data = JSON.parse(stripXssi(body));

  const rqWidget = (data.widgets || []).find((w) => w.id === "RELATED_QUERIES");
  if (!rqWidget) return [];

  await sleep(1000);

  const rqReq = encodeURIComponent(JSON.stringify(rqWidget.request));
  const rqToken = encodeURIComponent(rqWidget.token);
  const rqUrl = `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=300&req=${rqReq}&token=${rqToken}`;

  const rqResp = await fetchWithCookies(rqUrl, cookieJar);
  if (!rqResp.ok) throw new Error(`Related queries HTTP ${rqResp.status}`);

  const rqBody = await rqResp.text();
  const rqData = JSON.parse(stripXssi(rqBody));

  const out = [];
  for (const rankedList of rqData?.default?.rankedList || []) {
    for (const kw of rankedList.rankedKeyword || []) {
      const value = kw.formattedValue || "";
      out.push({
        query: kw.query || "",
        value,
        is_rising: value.includes("%") || value === "Breakout",
      });
    }
  }
  return out;
}

export default defineComponent({
  props: {
    keyword: { type: "string" },
    geo: { type: "string" },
    timeframe: { type: "string" },
  },
  async run({ $ }) {
    const cookieJar = [];
    try {
      await fetchWithCookies("https://trends.google.com/", cookieJar);
      await sleep(1000);
    } catch (e) {
      console.log(`cookie-jar warmup failed: ${e.message}`);
    }

    let related;
    try {
      related = await fetchRelatedQueries(cookieJar, this.keyword, this.geo, this.timeframe);
    } catch (e) {
      console.log(`fetch_search error: ${e.message}`);
      return { signals: [], signals_json: "[]", related_queries: [], count: 0, error: e.message };
    }

    const nowDate = new Date();
    const now = nowDate.toISOString().replace("T", " ").slice(0, 19);
    const todayKey = nowDate.toISOString().slice(0, 10);

    const signals = related.map((q) => ({
      SIGNAL_ID: `gt_rq_${this.geo}_${todayKey}_${q.query.toLowerCase().replace(/ /g, "_").slice(0, 50)}`,
      SOURCE_NAME: "google_trends_explore",
      SIGNAL_TIMESTAMP: now,
      SIGNAL_TITLE: q.query,
      SIGNAL_TEXT: `Related to '${this.keyword}': ${q.query} (${q.value})`,
      METADATA: JSON.stringify({
        geo: this.geo,
        type: q.is_rising ? "rising" : "top",
        seed_keyword: this.keyword,
        timeframe: this.timeframe,
        value: q.value,
      }),
    }));

    console.log(`fetched ${related.length} Google Trends queries for keyword='${this.keyword}' (${related.filter((q) => q.is_rising).length} rising)`);
    $.export("$summary", `${related.length} queries for "${this.keyword}"`);

    return {
      signals,
      signals_json: JSON.stringify(signals),
      related_queries: related,
      count: related.length,
      keyword: this.keyword,
    };
  },
});
