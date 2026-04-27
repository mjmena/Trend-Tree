// Enrichment Dispatcher — normalize_event
//
// HTTP-only trigger now (Snowflake polling source retired with
// STG_ENRICHMENT_QUEUE on 2026-04-27). Body shape: {trend_id} from
// promotion's fire_enrichment_chain step or manual curl.

export default defineComponent({
  async run({ steps, $ }) {
    const event = steps.trigger?.event || {};
    const body = (event.body && typeof event.body === "object") ? event.body : event;
    const trendId = body.trend_id || body.TREND_ID;
    if (!trendId) {
      throw new Error("dispatcher requires {trend_id: <uuid>} in body");
    }
    // ENRICHMENT_TYPE field still flows through for telemetry but no
    // longer gates anything (the SOURCES_ONLY/REFRESH gate retired).
    const enrichmentType = String(body.enrichment_type || body.ENRICHMENT_TYPE || "FULL").toUpperCase();
    console.log(`normalize_event: trend_id=${trendId}, type=${enrichmentType}`);
    $.export("$summary", `${trendId} [${enrichmentType}]`);
    return {
      trend_id: trendId,
      enrichment_type: enrichmentType,
      source: "http",
    };
  },
});
