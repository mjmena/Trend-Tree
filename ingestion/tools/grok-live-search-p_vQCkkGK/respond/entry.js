// Grok Live Search (agent tool) — respond

export default defineComponent({
  props: {
    fetch_result: { type: "any" },
  },
  async run({ $ }) {
    const fr = this.fetch_result || {};

    const body = {
      tool: "ingest_grok_live_search",
      query: fr.query || null,
      summary: fr.summary || "",
      citations: fr.citations || [],
      tokens: fr.tokens || null,
      model: fr.model || null,
      error: fr.error || null,
    };

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });

    return body;
  },
});
