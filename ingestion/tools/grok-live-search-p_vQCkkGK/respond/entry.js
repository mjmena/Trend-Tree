// Grok Live Search (agent tool) — respond

export default defineComponent({
  props: {
    fetch_result: { type: "any" },
  },
  async run({ $ }) {
    const fr = this.fetch_result || {};

    const body = {
      tool: "ingest_grok_live_search",
      ...fr,
    };

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
