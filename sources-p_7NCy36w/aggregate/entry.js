// Sources Enrichment — aggregate
//
// Takes the outputs of fetch_external + query_google_trends, assembles
// three FCT_TREND_SOURCE_METRICS records (one per source), computes
// source_coverage, and returns the payload shape expected by the
// downstream merge_fct_metrics registry step and respond step.
//
// This step does NOT touch Snowflake — the downstream merge_fct_metrics
// registry action takes `records_json` via mustache params and runs
// the MERGE with FLATTEN(PARSE_JSON(:1)).

export default defineComponent({
  props: {
    trend_id: {
      type: "string",
      label: "Trend ID",
    },
    metrics_rows: {
      type: "any",
      label: "FCT_TRENDS rows",
    },
    search_term_output: {
      type: "any",
      label: "Output from generate_search_terms",
    },
    external_output: {
      type: "any",
      label: "Output from fetch_external (GDELT + Wikimedia)",
    },
    google_trends_rows: {
      type: "any",
      label: "STG_GOOGLE_TRENDS rows from query_google_trends",
      optional: true,
    },
  },
  async run({ $ }) {
    const trendId = this.trend_id;
    const metrics = (this.metrics_rows || [])[0];
    if (!metrics) throw new Error(`FCT_TRENDS row missing for ${trendId}`);
    const trendTopic = metrics.TREND_TOPIC;
    const heatIndex = metrics.TREND_HEAT_INDEX || 0;
    const clusterSize = metrics.TOTAL_CLUSTER_SIZE || 0;
    const velocity = metrics.VELOCITY_DIRECTION;

    // ENRICHMENT_TYPE was a queue-derived field; queue is retired so every
    // sources run is effectively FULL. Field kept in the return shape for
    // downstream compat (write workflow's compute_scores reads it).
    const enrichmentType = "FULL";

    // ── GDELT / Wikimedia (already fetched in parallel) ────────────
    const gdelt = this.external_output?.gdelt ?? {};
    const wikimedia = this.external_output?.wikimedia ?? {};

    // ── Google Trends (from registry SQL action) ───────────────────
    const gtRows = this.google_trends_rows || [];
    const gt = { gt_interest_score: null, gt_related_queries: [] };
    if (gtRows.length > 0) {
      let maxTraffic = 0;
      for (const m of gtRows) {
        const traffic = parseInt(String(m.APPROX_TRAFFIC || "0").replace(/[^0-9]/g, ""), 10) || 0;
        maxTraffic = Math.max(maxTraffic, traffic);
        gt.gt_related_queries.push({
          query: m.TREND_TITLE,
          type: "top",
          value: traffic,
          pub_date: m.PUB_DATE,
        });
      }
      // Log-scale so niche topics (traffic < 5000) still produce a usable score.
      gt.gt_interest_score = Math.min(
        100,
        Math.max(1, Math.round(Math.log10(maxTraffic + 1) * 20)),
      );
      gt.gt_related_queries = gt.gt_related_queries.slice(0, 20);
      console.log(`Google Trends: interest_score=${gt.gt_interest_score}, ${gt.gt_related_queries.length} related queries`);
    } else {
      console.log("Google Trends: no matches in STG_GOOGLE_TRENDS");
    }

    // ── Build FCT_TREND_SOURCE_METRICS records ─────────────────────
    const allRecords = [
      {
        source_name: "gdelt",
        headline: gdelt.gdelt_article_count_7d ?? 0,
        headline_name: "gdelt_article_count_7d",
        metrics: gdelt,
      },
      {
        source_name: "wikimedia",
        headline: wikimedia.wiki_pageviews_7d ?? 0,
        headline_name: "wiki_pageviews_7d",
        metrics: wikimedia,
      },
      {
        source_name: "google_trends",
        headline: gt.gt_interest_score ?? 0,
        headline_name: "gt_interest_score",
        metrics: gt,
      },
    ];

    // Skip records with no data — the legacy aggregator does the same,
    // leaving any stale prior-run rows in place rather than overwriting
    // with zero on a transient fetch failure.
    const writeRecords = allRecords
      .filter((r) => (r.headline ?? 0) > 0)
      .map((r) => ({
        trend_id: trendId,
        source_name: r.source_name,
        headline_metric: r.headline,
        headline_metric_name: r.headline_name,
        metrics: r.metrics,
      }));

    const sourceCoverage = writeRecords.length;
    console.log("--- Source Results ---");
    for (const r of allRecords) {
      console.log(`  ${r.source_name}: ${r.headline_name}=${r.headline ?? 0}`);
    }
    console.log(`  Coverage: ${sourceCoverage}/3 sources with data`);

    $.export("$summary", `${sourceCoverage}/3 sources for "${trendTopic}" [${enrichmentType}]`);

    return {
      trend_id: trendId,
      trend_topic: trendTopic,
      enrichment_type: enrichmentType,
      cluster_size: clusterSize,
      heat_index: heatIndex,
      velocity,
      search_terms: this.search_term_output?.terms ?? [],
      source_coverage: sourceCoverage,
      records: writeRecords,
      // Stringified payload for the downstream merge_fct_metrics registry
      // step — passed as a single SQL param, unpacked via FLATTEN(PARSE_JSON(...)).
      records_json: writeRecords.length > 0 ? JSON.stringify(writeRecords) : "[]",
      all_records: allRecords,
      _token_usage: this.search_term_output?._token_usage ?? null,
    };
  },
});
