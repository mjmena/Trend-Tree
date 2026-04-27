// Grok Live Search (agent tool) — respond

export default defineComponent({
  props: {
    fetch_result: { type: "any" },
    upsert_result: { type: "any", optional: true },
  },
  async run({ $ }) {
    const fr = this.fetch_result || {};

    // Drop the bulky signals[] from the wire payload (the agent already
    // gets the URL/title via citations[] and doesn't need the full
    // Snowflake row shape). signals_json also drops; persistence has
    // already happened by upsert_signals upstream.
    const { signals: _drop1, signals_json: _drop2, ...frPublic } = fr;

    const body = {
      tool: "ingest_grok_live_search",
      ...frPublic,
      persisted_count: Array.isArray(fr.signals) ? fr.signals.length : 0,
    };

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
