// Promotion Lead — serialize_neighbor_pool
//
// JSON.stringify the neighbor_pool rows for the q_load_neighbor_signal_samples
// SQL bind. Pipedream's SQL action drops :1 binds on empty arrays — emit a
// guaranteed string ("[]" if no rows).

export default defineComponent({
  name: "Promotion: serialize neighbor pool",
  description: "Stringify neighbor_pool rows for the signal-samples SQL bind",
  version: "0.0.1",
  props: {
    neighbor_rows: { type: "any", optional: true },
  },
  async run() {
    const rows = Array.isArray(this.neighbor_rows) ? this.neighbor_rows : [];
    return {
      neighbor_pool_json: JSON.stringify(rows),
      neighbor_count: rows.length,
    };
  },
});
