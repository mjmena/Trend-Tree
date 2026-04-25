// Search GDELT (agent tool) — respond

export default defineComponent({
  props: {
    fetch_result: { type: "any" },
    upsert_result: { type: "any" },
  },
  async run({ $ }) {
    const fr = this.fetch_result || {};
    const upsertOk = Array.isArray(this.upsert_result) || (this.upsert_result && !this.upsert_result.error);

    const body = {
      tool: "ingest_search_gdelt",
      topic: fr.topic || null,
      count: fr.count || 0,
      articles: fr.articles || [],
      persisted_to_snowflake: !!upsertOk,
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
