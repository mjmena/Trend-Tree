// Distillation lead — serialize_window_signal_ids
//
// Pulls the SIGNAL_IDs out of the q_signals_window result and emits as a
// JSON array string. Used by:
//   - claim_window_signals: stamp every signal the agent considered with
//     the run's session_id (sticky claim).
//   - q_cluster_signals: pass to PROC_CLUSTER_SIGNAL_SUBSET along with K
//     to get k-means cluster assignments.
//
// K formula: ceil(N/20), clamped to [4, 15]. Smaller clusters help the
// agent see topical coherence; floor 4 keeps the summary worth showing
// for thin windows; ceiling 15 keeps the summary block tractable.
// If N < 4, emit k=0 — the proc handles empty/below-threshold gracefully.

export default defineComponent({
  props: {
    rows: { type: "any", optional: true },
  },
  async run() {
    const list = Array.isArray(this.rows) ? this.rows : [];
    const ids = list.map((r) => r?.SIGNAL_ID).filter(Boolean);
    const k = ids.length < 4 ? 0 : Math.min(15, Math.max(4, Math.ceil(ids.length / 20)));
    return {
      signal_ids_json: JSON.stringify(ids),
      count: ids.length,
      k,
    };
  },
});
