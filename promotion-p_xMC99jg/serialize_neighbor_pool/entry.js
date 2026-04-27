// Promotion Lead — serialize_neighbor_pool
//
// Extracts the distinct neighbor trend_ids from the combined vectors+neighbors
// output, emits as a JSON array string for the q_load_neighbor_signal_samples
// SQL bind. We strip CANDIDATE_VECTOR here — keeping it in the JSON would
// re-create the SQL-proxy payload-size issue (1024 floats × 100s of rows).

export default defineComponent({
  name: "Promotion: serialize neighbor pool",
  description: "Extract neighbor trend_id list as JSON for the signal-samples SQL bind",
  version: "0.0.2",
  props: {
    neighbor_rows: { type: "any", optional: true },
  },
  async run() {
    const rows = Array.isArray(this.neighbor_rows) ? this.neighbor_rows : [];
    const trend_ids = new Set();
    for (const r of rows) {
      const tid = r.NEIGHBOR_TREND_ID;
      if (tid) trend_ids.add(tid);
    }
    const ids = Array.from(trend_ids);
    return {
      neighbor_pool_json: JSON.stringify(ids.map((id) => ({ NEIGHBOR_TREND_ID: id }))),
      neighbor_count: ids.length,
    };
  },
});
