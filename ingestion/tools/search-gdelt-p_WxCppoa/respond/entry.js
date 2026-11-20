// Search GDELT (agent tool) — respond

export default defineComponent({
  props: {
    fetch_result: { type: "any" },
    upsert_result: { type: "any" },
  },
  async run({ $ }) {
    const fr = this.fetch_result || {};
    const upsertOk = Array.isArray(this.upsert_result) || (this.upsert_result && !this.upsert_result.error);

    const row = Array.isArray(this.upsert_result) ? this.upsert_result[0] : this.upsert_result;
    const raw = row?.MERGE_EXTERNAL_SIGNALS;
    const merge = typeof raw === "string" ? JSON.parse(raw) : raw;
    const articles = (fr.articles || []).map(article => ({
      ...article, signal_id: merge?.signal_ids?.[article.signal_id] || article.signal_id,
    }));
    const body = {
      tool: "ingest_search_gdelt",
      topic: fr.topic || null,
      count: fr.count || 0,
      articles,
      persisted_to_snowflake: !!upsertOk && !merge?.error,
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
