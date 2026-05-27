// gtrends-poller — fetch_and_compute
//
// Two modes:
// 1. Enqueue (cron-fired, no trend_ids_filter): enumerate all active trends,
//    fire one self-POST per trend to HTTP_ENDPOINT, exit. The workflow's
//    Pipedream-level concurrency + throttle settings serialize those
//    invocations so GT sees ~one request per IP per N seconds — no burst.
// 2. Process (HTTP-fired with trend_ids: [single-id]): poll exactly that
//    one trend, return result for the downstream INSERT step.
//
// Cookie-jar + XSSI-stripping pattern lifted from
// ingestion/tools/search-google-trends-p_YyC88x8/fetch_search/entry.js.

const PER_TREND_TIMEOUT_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const HTTP_ENDPOINT = "https://eo3powpxmgtoezi.m.pipedream.net";  // hi_VOHl1aX

// Browser-realistic headers — node-fetch's default UA is "node-fetch/1.0",
// which GT treats as a bot signature.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};
const API_REFERER = "https://trends.google.com/trends/explore";

function stripXssi(text) {
  const idx = text.indexOf("\n");
  return idx >= 0 && idx < 10 ? text.slice(idx + 1) : text;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Jittered sleep: baseline ms + up to jitterPct extra. Real users don't
// poll on a metronome; even small variance helps avoid being identified
// as a script.
function sleepJ(ms, jitterPct = 0.3) {
  return sleep(ms + Math.floor(Math.random() * ms * jitterPct));
}

async function fetchWithCookies(url, cookieJar, opts = {}) {
  const headers = {
    ...BROWSER_HEADERS,
    ...(opts.headers || {}),
    cookie: cookieJar.join("; "),
  };
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
  let resp = await fetchWithCookies(exploreUrl, cookieJar, {
    headers: { Referer: API_REFERER },
  });
  if (resp.status === 429) {
    console.log(`gtrends-poller: rate-limited on '${keyword}', backing off ${RATE_LIMIT_BACKOFF_MS}ms`);
    await sleepJ(RATE_LIMIT_BACKOFF_MS);
    resp = await fetchWithCookies(exploreUrl, cookieJar, {
      headers: { Referer: API_REFERER },
    });
  }
  if (!resp.ok) throw new Error(`Explore HTTP ${resp.status}`);
  const data = JSON.parse(stripXssi(await resp.text()));
  return data.widgets || [];
}

async function fetchWidgetData(cookieJar, widget) {
  const req = encodeURIComponent(JSON.stringify(widget.request));
  const token = encodeURIComponent(widget.token);
  const endpoint = widget.id === "TIMESERIES"
    ? "multiline"
    : widget.id === "RELATED_QUERIES"
      ? "relatedsearches"
      : null;
  if (!endpoint) return null;
  const url = `https://trends.google.com/trends/api/widgetdata/${endpoint}?hl=en-US&tz=300&req=${req}&token=${token}`;
  const resp = await fetchWithCookies(url, cookieJar, {
    headers: { Referer: API_REFERER },
  });
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
  // Two-page cookie warmup — root then explore page. Mirrors what a real
  // browser session does before any XHR to the GT API.
  try {
    await fetchWithCookies("https://trends.google.com/", cookieJar);
    await sleepJ(1500);
    await fetchWithCookies(`https://trends.google.com/trends/explore?geo=${encodeURIComponent(geo)}`, cookieJar);
    await sleepJ(1500);
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
  await sleepJ(800);

  const timeseriesWidget = widgets.find((w) => w.id === "TIMESERIES");
  const rqWidget = widgets.find((w) => w.id === "RELATED_QUERIES");

  let interest_over_time = [];
  let related_queries = { top: [], rising: [] };

  if (timeseriesWidget) {
    try {
      const ts = await fetchWidgetData(cookieJar, timeseriesWidget);
      interest_over_time = extractInterestOverTime(ts);
      await sleepJ(800);
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
      search_keyword: r.SEARCH_KEYWORD || r.TREND_TOPIC,
    }));

    // Optional filter from the trigger body (manual targeted runs / self-POSTs)
    let trends = allTrends;
    if (ev.trend_ids_filter && ev.trend_ids_filter.length > 0) {
      const set = new Set(ev.trend_ids_filter);
      trends = trends.filter((t) => set.has(t.trend_id));
    }
    if (trends.length > ev.max_trends) {
      trends = trends.slice(0, ev.max_trends);
    }

    // ENQUEUE MODE — cron fired with no filter. Fire one self-POST per
    // trend; workflow concurrency + throttle (set Pipedream-side) serialize
    // them so GT sees ~one request per interval, not a burst.
    if (!ev.trend_ids_filter && trends.length > 1) {
      const t0d = Date.now();
      console.log(`gtrends-poller: enqueue → ${trends.length} self-POSTs`);
      const fires = await Promise.all(
        trends.map((t, i) =>
          fetch(HTTP_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chain_id: `${ev.chain_id}-t${i}`,
              geo: ev.geo,
              timeframe: ev.timeframe,
              dry_run: ev.dry_run,
              trend_ids: [t.trend_id],
            }),
          })
            .then((r) => ({ trend_id: t.trend_id, status: r.status }))
            .catch((e) => ({ trend_id: t.trend_id, error: e.message }))
        )
      );
      const fireErrors = fires.filter((f) => f.error);
      if (fireErrors.length > 0) {
        console.log("gtrends-poller: enqueue errors:", JSON.stringify(fireErrors.slice(0, 5)));
      }
      $.export("$summary", `enqueued: ${trends.length} trends (${fireErrors.length} fire errors)`);
      return {
        results_json: "[]",
        ok_count: 0,
        error_count: 0,
        attempted: 0,
        dispatched: trends.length,
        run_duration_ms: Date.now() - t0d,
        mode: "enqueue",
      };
    }

    // PROCESS MODE — poll the (typically single) trend.
    if (ev.dry_run) {
      console.log(`gtrends-poller: dry_run=true, would poll ${trends.length} trends`);
      return {
        results_json: "[]", ok_count: 0, error_count: 0,
        attempted: trends.length, run_duration_ms: 0, skipped: "dry_run",
      };
    }

    if (trends.length === 0) {
      console.log("gtrends-poller: no active trends to poll");
      return {
        results_json: "[]", ok_count: 0, error_count: 0,
        attempted: 0, run_duration_ms: 0,
      };
    }

    console.log(
      `gtrends-poller: polling ${trends.length} trend(s) (geo=${ev.geo} timeframe='${ev.timeframe}')`
    );

    const t0 = Date.now();
    const results = [];
    const errors = [];
    const empties = [];

    for (const t of trends) {
      try {
        const out = await Promise.race([
          pollOneTrend(t, ev.geo, ev.timeframe),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("trend-level timeout")), PER_TREND_TIMEOUT_MS)
          ),
        ]);
        if (out.error) {
          errors.push({ trend_id: t.trend_id, error: out.error });
        } else if (!Array.isArray(out.interest_over_time) || out.interest_over_time.length === 0) {
          // Empty timeseries — dominantly a silent rate-limit on the
          // Pipedream egress IP (see CONTEXT.md "Empty INTEREST_OVER_TIME
          // array ≠ low search volume"), occasionally a real low-volume
          // keyword. Either way, don't write a row: "no row" lets the
          // lifecycle agent's external_factor default kick in instead of
          // falsely recording 0 as earned evidence.
          empties.push({ trend_id: t.trend_id, keyword: out.keyword });
        } else {
          results.push(out);
        }
      } catch (e) {
        errors.push({ trend_id: t.trend_id, error: e.message });
      }
    }

    const run_duration_ms = Date.now() - t0;

    console.log(
      `gtrends-poller: done — ${results.length} ok / ${empties.length} empty / ${errors.length} errors in ${run_duration_ms}ms`
    );
    if (empties.length > 0) {
      console.log("gtrends-poller empties:", JSON.stringify(empties.slice(0, 10)));
    }
    if (errors.length > 0) {
      console.log("gtrends-poller errors:", JSON.stringify(errors.slice(0, 10)));
    }

    $.export("$summary", `${results.length}/${trends.length} ok, ${empties.length} empty, ${run_duration_ms}ms`);

    return {
      results_json: JSON.stringify(results),
      ok_count: results.length,
      empty_count: empties.length,
      empties: empties.slice(0, 20),
      error_count: errors.length,
      errors: errors.slice(0, 20),
      attempted: trends.length,
      run_duration_ms,
    };
  },
});
