// Pipedream Workflow Step: Load LLM Context from Snowflake
//
// HTTP-triggered entry point for the LLM enrichment workflow.
// Takes a trend_id from the request body and assembles the enrich_context
// bundle the downstream LLM steps expect — reading trend metadata, source
// metrics, and top signals directly from Snowflake. This workflow is
// read-only; all writes are handled downstream of the future orchestrator.

export default {
  name: "Load LLM Context",
  description: "Reads trend metadata, source metrics, and signals from Snowflake into the enrich_context shape expected by the LLM steps",
  version: "0.0.1",
  props: {
    snowflake: {
      type: "app",
      app: "snowflake",
    },
    trend_id: {
      type: "string",
      label: "Trend ID",
      description: "Trend ID to load context for (wired from the HTTP trigger body)",
    },
  },
  async run() {
    const trendId = this.trend_id;
    if (!trendId) {
      throw new Error("trend_id is required (POST body: { trend_id: '<uuid>' })");
    }
    const esc = (v) => String(v).replace(/'/g, "''");

    // ── Trend metadata ───────────────────────────────────────────────
    const metricsRows = await this.snowflake.executeQuery({
      sqlText: `
        SELECT TREND_ID, TREND_TOPIC, TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT,
               VELOCITY_DIRECTION, TREND_HEAT_INDEX, DETECTED_AT, LAST_UPDATE_AT
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
        WHERE TREND_ID = '${esc(trendId)}'
      `,
    });
    const metrics = metricsRows?.[0];
    if (!metrics) {
      throw new Error(`Trend not found: ${trendId}`);
    }
    const trendTopic = metrics.TREND_TOPIC;
    const clusterSize = metrics.TOTAL_CLUSTER_SIZE || 0;
    const heatIndex = metrics.TREND_HEAT_INDEX || 0;
    const velocity = metrics.VELOCITY_DIRECTION;

    // ── Enrichment type from queue (fallback to FULL so this workflow
    //     is independently testable before the orchestrator exists) ──
    let enrichType = "FULL";
    try {
      const queueRows = await this.snowflake.executeQuery({
        sqlText: `
          SELECT ENRICHMENT_TYPE
          FROM MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE
          WHERE TREND_ID = '${esc(trendId)}'
          ORDER BY QUEUED_AT DESC NULLS LAST
          LIMIT 1
        `,
      });
      if (queueRows?.[0]?.ENRICHMENT_TYPE) {
        enrichType = queueRows[0].ENRICHMENT_TYPE;
      }
    } catch (e) {
      console.log(`Queue lookup failed (continuing with FULL): ${e.message}`);
    }

    console.log(`\n=== Loading context: "${trendTopic}" (${trendId}) [${enrichType}] ===`);
    console.log(`  Cluster size: ${clusterSize}, Heat: ${heatIndex}, Velocity: ${velocity}\n`);

    // ── Top signals for LLM context ──────────────────────────────────
    let topSignals = [];
    try {
      const signalRows = await this.snowflake.executeQuery({
        sqlText: `
          SELECT TITLE, SIGNAL_NAME, DOMAIN, DETECTED_AT, PAGERANK_SCORE
          FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
          WHERE TREND_ID = '${esc(trendId)}'
          ORDER BY PAGERANK_SCORE DESC
          LIMIT 10
        `,
      });
      topSignals = (signalRows || []).map((s) => ({
        title: s.TITLE,
        source: s.SIGNAL_NAME,
        domain: s.DOMAIN,
        pagerank: s.PAGERANK_SCORE,
      }));
    } catch (e) {
      console.log(`Signal fetch error: ${e.message}`);
    }

    // ── Source metrics ───────────────────────────────────────────────
    // The sources workflow writes one row per source into
    // FCT_TREND_SOURCE_METRICS with HEADLINE_METRIC, HEADLINE_METRIC_NAME,
    // and a METRICS VARIANT blob that contains the full per-source result
    // object (same shape the old enrich_trend.mjs built in memory).
    let sourceRows = [];
    try {
      sourceRows = await this.snowflake.executeQuery({
        sqlText: `
          SELECT SOURCE_NAME, HEADLINE_METRIC, HEADLINE_METRIC_NAME, METRICS
          FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
          WHERE TREND_ID = '${esc(trendId)}'
        `,
      });
    } catch (e) {
      console.log(`Source metric fetch error: ${e.message}`);
    }

    // Rebuild the per-source map the LLM steps expect (keys: gdelt,
    // wikimedia, bluesky, google_trends, amazon, pinterest, tiktok).
    const sv = {
      gdelt: {}, wikimedia: {}, bluesky: {}, google_trends: {},
      amazon: {}, pinterest: {}, tiktok: {},
    };
    for (const row of sourceRows) {
      const name = row.SOURCE_NAME;
      if (!(name in sv)) continue;
      // METRICS is a VARIANT — snowflake-sdk returns it as an already-parsed
      // object when the column is VARIANT. Fall back to JSON.parse if string.
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
    console.log(`  Coverage: ${sourceCoverage}/7 sources with data\n`);

    // ── Build source_evidence (flattened for LLM prompts) ────────────
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
      hashtags: [],  // Hashtags are used by the sources workflow for searches, not the LLM steps
      source_coverage: sourceCoverage,
      sources: sv,
      source_evidence,
    };

    console.log(`=== Context ready for "${trendTopic}" [${enrichType}] ===\n`);
    return enrichContext;
  },
};
