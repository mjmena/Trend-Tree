// Promotion Lead — serialize_for_neighbor_query
//
// Tiny pass-through that JSON.stringify's row arrays for downstream SQL binds.
// Needed because Pipedream's SQL action silently drops :1 binds when the
// upstream array is empty (we hit "Bind variable :1 not set" in the smoke
// test). Always emit a string — even "[]" — so the bind always succeeds.

export default defineComponent({
  name: "Promotion: serialize for neighbor queries",
  description: "Stringify row arrays for SQL binds (handles empty arrays correctly)",
  version: "0.0.2",
  props: {
    candidate_vectors: { type: "any", optional: true },
  },
  async run() {
    const vecRows = Array.isArray(this.candidate_vectors) ? this.candidate_vectors : [];
    return {
      candidate_vectors_json: JSON.stringify(vecRows),
      candidate_vectors_count: vecRows.length,
    };
  },
});
