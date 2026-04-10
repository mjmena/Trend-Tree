// Pipedream Workflow Step: Build LLM Context
//
// Reads the return values of the four upstream snowflake-execute-sql-query
// steps (query_metrics, query_queue, query_signals, query_sources) and
// assembles the enrich_context bundle in the shape the downstream LLM
// specialists expect. No Snowflake connection of its own — all DB access
// happens in the registry SQL action steps upstream.

export default defineComponent({
  props: {
    trend_id: {
      type: "string",
      label: "Trend ID",
      description: "Wired from the HTTP trigger body",
    },
    metrics_rows: {
      type: "any",
      label: "FCT_TREND_METRICS rows",
    },
    queue_rows: {
      type: "any",
      label: "STG_ENRICHMENT_QUEUE rows",
      optional: true,
    },
    signal_rows: {
      type: "any",
      label: "STG_TREND_SIGNALS rows",
      optional: true,
    },
    source_rows: {
      type: "any",
      label: "FCT_TREND_SOURCE_METRICS rows",
      optional: true,
    },
  },
  async run({ $ }) {
    const trendId = this.trend_id;
    if (!trendId) {
      throw new Error("trend_id is required (POST body: { trend_id: '<uuid>' })");
    }

    const metrics = (this.metrics_rows || [])[0];
    if (!metrics) {
      throw new Error(`Trend not found in FCT_TREND_METRICS: ${trendId}`);
    }

    const trendTopic = metrics.TREND_TOPIC;
    const clusterSize = metrics.TOTAL_CLUSTER_SIZE || 0;
    const heatIndex = metrics.TREND_HEAT_INDEX || 0;
    const velocity = metrics.VELOCITY_DIRECTION;
    const enrichType = (this.queue_rows || [])[0]?.ENRICHMENT_TYPE || "FULL";

    console.log(`\n=== Building context: "${trendTopic}" (${trendId}) [${enrichType}] ===`);
    console.log(`  Cluster size: ${clusterSize}, Heat: ${heatIndex}, Velocity: ${velocity}`);

    const topSignals = (this.signal_rows || []).map((s) => ({
      title: s.TITLE,
      source: s.SIGNAL_NAME,
      domain: s.DOMAIN,
      pagerank: s.PAGERANK_SCORE,
    }));

    // Rebuild the per-source map the LLM steps expect. The METRICS column
    // is VARIANT — the Snowflake SDK may return it as an already-parsed
    // object or as a JSON string depending on session config.
    const sv = {
      gdelt: {}, wikimedia: {}, bluesky: {}, google_trends: {},
      amazon: {}, pinterest: {}, tiktok: {},
    };
    for (const row of (this.source_rows || [])) {
      const name = row.SOURCE_NAME;
      if (!(name in sv)) continue;
      let metricsObj = row.METRICS;
      if (typeof metricsObj === "string") {
        try { metricsObj = JSON.parse(metricsObj); } catch { metricsObj = {}; }
      }
      if (!metricsObj || typeof metricsObj !== "object") metricsObj = {};
      sv[name] = {
        headline_metric: row.HEADLINE_METRIC,
        headline_metric_name: row.HEADLINE_METRIC_NAME,
        ...metricsObj,
      };
    }

    const sourceCoverage = Object.values(sv).filter((r) => (r.headline_metric ?? 0) > 0).length;
    console.log("--- Source Coverage ---");
    for (const [name, data] of Object.entries(sv)) {
      console.log(`  ${name}: ${data.headline_metric_name ?? "(none)"}=${data.headline_metric ?? 0}`);
    }
    console.log(`  Coverage: ${sourceCoverage}/7 sources with data`);

    const source_evidence = {
      gdelt_articles:      sv.gdelt?.gdelt_article_count_7d ?? 0,
      gdelt_domains:       sv.gdelt?.gdelt_domain_count_7d ?? 0,
      gdelt_tone:          sv.gdelt?.gdelt_tone_avg ?? null,
      gdelt_top_domains:   sv.gdelt?.gdelt_top_domains ?? [],
      wiki_article:        sv.wikimedia?.wiki_article_title ?? null,
      wiki_views_7d:       sv.wikimedia?.wiki_pageviews_7d ?? 0,
      wiki_growth_pct:     sv.wikimedia?.wiki_pageview_growth_pct ?? null,
      social_posts:        sv.bluesky?.social_post_count_7d ?? 0,
      social_engagement:   sv.bluesky?.social_avg_engagement ?? 0,
      social_sentiment:    sv.bluesky?.social_sentiment ?? { positive: 0, negative: 0, neutral: 0 },
      social_hashtags:     sv.bluesky?.social_hashtags ?? [],
      social_top_quotes:   (sv.bluesky?.social_top_posts ?? []).map((p) => p.text).filter(Boolean),
      gt_interest_score:   sv.google_trends?.gt_interest_score ?? null,
      gt_related_queries:  sv.google_trends?.gt_related_queries ?? [],
      amazon_product_count:    sv.amazon?.amazon_product_count ?? 0,
      amazon_avg_price:        sv.amazon?.amazon_avg_price ?? null,
      amazon_top_products:     (sv.amazon?.amazon_related_products ?? []).map((p) => p.title).filter(Boolean),
      amazon_top_departments:  (sv.amazon?.amazon_top_departments ?? []).map((d) => d.department),
      pinterest_trends:        sv.pinterest?.pinterest_trend_count ?? 0,
      pinterest_categories:    (sv.pinterest?.pinterest_categories ?? []).map((c) => c.category),
      tiktok_hashtags:         sv.tiktok?.tiktok_hashtag_count ?? 0,
      tiktok_views:            sv.tiktok?.tiktok_total_views ?? 0,
      tiktok_best_rank:        sv.tiktok?.tiktok_best_rank ?? null,
      tiktok_top_hashtags:     (sv.tiktok?.tiktok_hashtags ?? []).map((h) => h.hashtag).filter(Boolean),
    };

    const enrichContext = {
      trend_id: trendId,
      trend_topic: trendTopic,
      enrichment_type: enrichType,
      cluster_size: clusterSize,
      heat_index: heatIndex,
      velocity,
      top_signals: topSignals,
      hashtags: [],
      source_coverage: sourceCoverage,
      sources: sv,
      source_evidence,
    };

    $.export("$summary", `Context ready: ${trendTopic} [${enrichType}] (${sourceCoverage}/7 sources)`);
    return enrichContext;
  },
});
