// Ingest Wikimedia — fetch_source
//
// Fetches yesterday's most-read English Wikipedia articles from the
// Wikimedia REST pageviews API. No auth. Pageview data has a ~24h lag,
// so we always query for "yesterday" relative to UTC.
//
// Port of trends-sql/pipedream/ingestion/ingest_wikimedia.mjs.

const USER_AGENT = "TrendsPipeline/1.0 (Pipedream; trend detection research)";

const SKIP_PREFIXES = [
  "Main_Page", "Special:", "Wikipedia:", "Portal:",
  "Help:", "File:", "Template:", "Category:",
];

const LIMIT = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default defineComponent({
  async run({ $ }) {
    const yesterday = new Date(Date.now() - 86400000);
    const year = yesterday.getUTCFullYear();
    const month = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
    const day = String(yesterday.getUTCDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;
    const dateKey = `${year}${month}${day}`;

    const topUrl = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${year}/${month}/${day}`;
    const topResp = await fetch(topUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!topResp.ok) {
      throw new Error(`Pageviews API failed: HTTP ${topResp.status}`);
    }
    const topData = await topResp.json();
    const articles = topData?.items?.[0]?.articles || [];

    const allSignals = [];
    let skipped = 0;

    for (const article of articles.slice(0, LIMIT)) {
      const title = article.article || "";
      if (SKIP_PREFIXES.some((p) => title.startsWith(p))) {
        skipped++;
        continue;
      }

      const views = article.views || 0;
      const rank = article.rank || 0;
      const displayTitle = title.replaceAll("_", " ");

      let description = "";
      let extract = "";
      try {
        const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
        const summaryResp = await fetch(summaryUrl, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });
        if (summaryResp.ok) {
          const summaryData = await summaryResp.json();
          description = summaryData.description || "";
          extract = summaryData.extract || "";
        }
      } catch {
        // Summary fetch is best-effort
      }

      const signalText = (extract || displayTitle).slice(0, 2000);

      allSignals.push({
        // SIGNAL_ID is the canonical Wikipedia article URL — same shape for
        // all sources post slice-4 swap (cross-source dedup key).
        SIGNAL_ID: `https://en.wikipedia.org/wiki/${title}`,
        SOURCE_NAME: "wikimedia",
        SIGNAL_TIMESTAMP: `${dateStr} 00:00:00`,
        SIGNAL_TITLE: displayTitle,
        SIGNAL_TEXT: signalText,
        METADATA: JSON.stringify({
          views,
          rank,
          description,
          url: `https://en.wikipedia.org/wiki/${title}`,
          date: dateStr,
        }),
      });

      // Be polite to Wikipedia API
      if (allSignals.length % 10 === 0) await sleep(500);
    }

    console.log(`Wikimedia: ${allSignals.length} articles, ${skipped} meta-pages skipped (date=${dateStr})`);
    $.export("$summary", `${allSignals.length} Wikimedia articles`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
    };
  },
});
