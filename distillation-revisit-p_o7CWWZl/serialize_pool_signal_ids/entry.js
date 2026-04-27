// Distillation Revisit Lead — serialize_pool_signal_ids
//
// Pulls SIGNAL_IDs out of q_load_pool's result and emits as a JSON array
// string. Used by q_cluster_signals (passed to PROC_CLUSTER_SIGNAL_SUBSET)
// and by claim_revisit_signals (UPDATE WHERE SIGNAL_ID IN ...).

export default defineComponent({
  props: {
    rows: { type: "any", optional: true },
  },
  async run() {
    const list = Array.isArray(this.rows) ? this.rows : [];
    const ids = list.map((r) => r?.SIGNAL_ID).filter(Boolean);
    return {
      signal_ids_json: JSON.stringify(ids),
      count: ids.length,
    };
  },
});
