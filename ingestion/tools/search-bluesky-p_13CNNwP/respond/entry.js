// Search Bluesky (agent tool) — respond
//
// Terminal step. Returns the agent-facing payload via $.respond().
// Requires the trigger's "Return a custom response" toggle (custom_response)
// to be ON — see CLAUDE.md gotcha #6. If you see the default
// `<p><b>Success!</b></p>` HTML coming back from this endpoint, the toggle
// is off; flip it in the trigger card in the Pipedream UI.

export default defineComponent({
  props: {
    fetch_result: { type: "any" },
    upsert_result: { type: "any" },
  },
  async run({ $ }) {
    const fr = this.fetch_result || {};
    const upsertOk = Array.isArray(this.upsert_result) || (this.upsert_result && !this.upsert_result.error);

    const body = {
      tool: "ingest_search_bluesky",
      query: fr.query || null,
      count: fr.count || 0,
      posts: fr.posts || [],
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
