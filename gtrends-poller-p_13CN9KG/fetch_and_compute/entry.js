// gtrends-poller — fetch_and_compute
//
// Iterates ACTIVE trends, calls Google Trends Explore API per trend, parses
// the TIMESERIES + RELATED_QUERIES widgets, computes peak/avg from the
// interest curve. Returns an array of result rows for downstream INSERT.
//
// Cookie-jar + XSSI-stripping pattern lifted from
// ingestion/tools/search-google-trends-p_YyC88x8/fetch_search/entry.js
// (the existing tool fetches related_queries only — this poller also
// pulls TIMESERIES, which is what the lifecycle agent reads as
// gtrends_history).

const FANOUT_CONCURRENCY = 1;          // GTrends throttles concurrent requests by IP — sequential only
const PER_TREND_TIMEOUT_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const INTER_TREND_SLEEP_MS = 3_000;    // back off between trends to avoid silent rate-limit empty responses

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

async function fetchExploreWidgets(cookieJar, keyword, geo, timeframe) {
  const req = JSON.stringify({
    comparisonItem: [{ keyword, geo, time: timeframe }],
    category: 0,
    property: "",
  });
  const exploreUrl = `https://trends.google.com/trends/api/explore?hl=en-US&tz=300&req=${encodeURIComponent(req)}`;
  let resp = await fetchWithCookies(exploreUrl, cookieJar);
  if (resp.status === 429) {
    console.log(`gtrends-poller: rate-limited on '${keyword}', backing off ${RATE_LIMIT_BACKOFF_MS}ms`);
    await sleep(RATE_LIMIT_BACKOFF_MS);
    resp = await fetchWithCookies(exploreUrl, cookieJar);
  }
  if (!resp.ok) throw new Error(`Explore HTTP ${resp.status}`);
  const data = JSON.parse(stripXssi(await resp.text()));
  return data.widgets || [];
}

async function fetchWidgetData(cookieJar, widget) {
  const req = encodeURIComponent(JSON.stringify(widget.request));
  const token = encodeURIComponent(widget.token);
  // Pick the right endpoint based on widget type
  const endpoint = widget.id === "TIMESERIES"
    ? "multiline"
    : widget.id === "RELATED_QUERIES"
      ? "relatedsearches"
      : null;
  if (!endpoint) return null;
  const url = `https://trends.google.com/trends/api/widgetdata/${endpoint}?hl=en-US&tz=300&req=${req}&token=${token}`;
  const resp = await fetchWithCookies(url, cookieJar);
  if (!resp.ok) throw new Error(`Widget ${widget.id} HTTP ${resp.status}`);
  return JSON.parse(stripXssi(await resp.text()));
}

function extractInterestOverTime(timeseriesData) {
  const points = timeseriesData?.default?.timelineData || [];
  return points.map((p) => ({
    date: p.formattedTime || p.time,
    interest: Number((p.value || [0])[0]),
  }));
}

function extractRelatedQueries(rqData) {
  const out = { top: [], rising: [] };
  for (const rankedList of rqData?.default?.rankedList || []) {
    for (const kw of rankedList.rankedKeyword || []) {
      const value = kw.formattedValue || "";
      const item = { query: kw.query || "", value };
      if (value.includes("%") || value === "Breakout") out.rising.push(item);
      else out.top.push(item);
    }
  }
  return out;
}

function computePeakAndAvg(interestArr) {
  if (!Array.isArray(interestArr) || interestArr.length === 0) {
    return { peak: 0, avg: 0 };
  }
  let peak = 0;
  let sum = 0;
  for (const p of interestArr) {
    const v = Number(p.interest) || 0;
    if (v > peak) peak = v;
    sum += v;
  }
  return { peak, avg: Math.round((sum / interestArr.length) * 10) / 10 };
}

async function pollOneTrend(trend, geo, timeframe) {
  const cookieJar = [];
  try {
    await fetchWithCookies("https://trends.google.com/", cookieJar);
    await sleep(800);
  } catch (e) {
    console.log(`gtrends-poller: cookie warmup failed for ${trend.trend_id}: ${e.message}`);
  }

  // Use the LLM-derived search keyword (2-4 words). Truncate to 100 chars
  // as a defensive cap — GTrends rejects very long queries. Falls back to
  // trend_topic for any unkeyworded legacy rows.
  const keyword = String(trend.search_keyword || trend.trend_topic || "").trim().slice(0, 100);
  if (!keyword) {
    return { trend_id: trend.trend_id, error: "empty keyword" };
  }

  const widgets = await fetchExploreWidgets(cookieJar, keyword, geo, timeframe);
  await sleep(800);

  const timeseriesWidget = widgets.find((w) => w.id === "TIMESERIES");
  const rqWidget = widgets.find((w) => w.id === "RELATED_QUERIES");

  let interest_over_time = [];
  let related_queries = { top: [], rising: [] };

  if (timeseriesWidget) {
    try {
      const ts = await fetchWidgetData(cookieJar, timeseriesWidget);
      interest_over_time = extractInterestOverTime(ts);
      await sleep(800);
    } catch (e) {
      console.log(`gtrends-poller: TIMESERIES failed for ${trend.trend_id}: ${e.message}`);
    }
  }

  if (rqWidget) {
    try {
      const rq = await fetchWidgetData(cookieJar, rqWidget);
      related_queries = extractRelatedQueries(rq);
    } catch (e) {
      console.log(`gtrends-poller: RELATED_QUERIES failed for ${trend.trend_id}: ${e.message}`);
    }
  }

  const { peak, avg } = computePeakAndAvg(interest_over_time);
  return {
    trend_id: trend.trend_id,
    keyword,
    geo,
    timeframe,
    interest_over_time,
    related_queries,
    interest_peak_pct: peak,
    interest_avg_pct: avg,
  };
}

export default defineComponent({
  props: {
    event: { type: "object" },
    trend_rows: { type: "any" },
  },
  async run({ $ }) {
    const ev = this.event || {};
    const allTrends = (this.trend_rows || []).map((r) => ({
      trend_id: r.TREND_ID,
      trend_topic: r.TREND_TOPIC,
      // SEARCH_KEYWORD is the LLM-derived short query (2-4 words) that
      // produces actual GTrends data. Falls back to TREND_TOPIC for any
      // pre-keyword row, but TOPIC strings rarely return useful data.
      search_keyword: r.SEARCH_KEYWORD || r.TREND_TOPIC,
    }));

    // Apply optional filter from the trigger body
    let trends = allTrends;
    if (ev.trend_ids_filter && ev.trend_ids_filter.length > 0) {
      const set = new Set(ev.trend_ids_filter);
      trends = trends.filter((t) => set.has(t.trend_id));
    }
    if (trends.length > ev.max_trends) {
      trends = trends.slice(0, ev.max_trends);
    }

    if (ev.dry_run) {
      console.log(`gtrends-poller: dry_run=true, would poll ${trends.length} trends`);
      return {
        results_json: "[]",
        ok_count: 0,
        error_count: 0,
        attempted: trends.length,
        run_duration_ms: 0,
        skipped: "dry_run",
      };
    }

    if (trends.length === 0) {
      console.log("gtrends-poller: no active trends to poll");
      return {
        results_json: "[]",
        ok_count: 0,
        error_count: 0,
        attempted: 0,
        run_duration_ms: 0,
      };
    }

    console.log(
      `gtrends-poller: polling ${trends.length} trends (geo=${ev.geo} timeframe='${ev.timeframe}' concurrency=${FANOUT_CONCURRENCY})`
    );

    const t0 = Date.now();
    const results = [];
    const errors = [];
    let cursor = 0;

    async function worker() {
      while (cursor < trends.length) {
        const idx = cursor++;
        const t = trends[idx];
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PER_TREND_TIMEOUT_MS);
        try {
          const out = await Promise.race([
            pollOneTrend(t, ev.geo, ev.timeframe),
            new Promise((_, rej) => setTimeout(() => rej(new Error("trend-level timeout")), PER_TREND_TIMEOUT_MS)),
          ]);
          if (out.error) {
            errors.push({ trend_id: t.trend_id, error: out.error });
          } else {
            results.push(out);
          }
        } catch (e) {
          errors.push({ trend_id: t.trend_id, error: e.message });
        } finally {
          clearTimeout(timer);
        }
        // Pace between trends — even with concurrency=1, GTrends throttles
        // back-to-back hits from the same IP and silently returns empty curves.
        if (cursor < trends.length) {
          await sleep(INTER_TREND_SLEEP_MS);
        }
      }
    }

    const workerCount = Math.min(FANOUT_CONCURRENCY, trends.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const run_duration_ms = Date.now() - t0;

    console.log(
      `gtrends-poller: done — ${results.length} ok / ${errors.length} errors in ${run_duration_ms}ms`
    );
    if (errors.length > 0) {
      console.log("gtrends-poller errors:", JSON.stringify(errors.slice(0, 10)));
    }

    $.export("$summary", `${results.length}/${trends.length} trends, ${run_duration_ms}ms`);

    return {
      results_json: JSON.stringify(results),
      ok_count: results.length,
      error_count: errors.length,
      errors: errors.slice(0, 20),
      attempted: trends.length,
      run_duration_ms,
    };
  },
});
