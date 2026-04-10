// Enrichment Dispatcher — normalize_event
//
// The dispatcher has two triggers:
//   1. Snowflake SQL polling source — emits the polled row directly,
//      with uppercase column names: { TREND_ID, TREND_TOPIC,
//      QUEUE_ENRICHMENT_TYPE, ... }
//   2. HTTP trigger — emits the standard request shape, with the
//      JSON body nested under event.body: { body: { trend_id, ... } }
//
// All downstream steps need a single uniform input shape regardless
// of which trigger fired. This step normalizes both into:
//   { trend_id, enrichment_type, source }
//
// On the HTTP path it accepts both lowercase and uppercase keys, so
// you can curl the dispatcher with either {"trend_id":"..."} or
// {"TREND_ID":"..."} for parity with the Snowflake event shape.

export default defineComponent({
  async run({ steps, $ }) {
    const event = steps.trigger?.event || {};

    // HTTP trigger path: payload lives under event.body
    if (event.body && typeof event.body === "object") {
      const b = event.body;
      const trendId = b.trend_id || b.TREND_ID;
      if (!trendId) {
        throw new Error("HTTP trigger body missing trend_id");
      }
      const enrichmentType =
        b.enrichment_type || b.ENRICHMENT_TYPE || b.QUEUE_ENRICHMENT_TYPE || "FULL";
      console.log(`normalize_event: HTTP trigger, trend_id=${trendId}, type=${enrichmentType}`);
      $.export("$summary", `HTTP ${trendId} [${enrichmentType}]`);
      return {
        trend_id: trendId,
        enrichment_type: String(enrichmentType).toUpperCase(),
        source: "http",
      };
    }

    // Snowflake polling path: row is the event itself
    const trendId = event.TREND_ID || event.trend_id;
    if (!trendId) {
      throw new Error(
        "Unrecognized trigger event shape — no trend_id in body or top-level TREND_ID",
      );
    }
    const enrichmentType =
      event.QUEUE_ENRICHMENT_TYPE ||
      event.ENRICHMENT_TYPE ||
      event.enrichment_type ||
      "FULL";
    console.log(`normalize_event: Snowflake polling, trend_id=${trendId}, type=${enrichmentType}`);
    $.export("$summary", `Snowflake ${trendId} [${enrichmentType}]`);
    return {
      trend_id: trendId,
      enrichment_type: String(enrichmentType).toUpperCase(),
      source: "snowflake_polling",
    };
  },
});
