// Distillation lead — serialize_window_signal_ids
//
// Pulls the SIGNAL_IDs out of the q_signals_window result and emits as a
// JSON array string. Used by claim_window_signals to stamp every signal
// the agent considered with the run's session_id (sticky claim — survives
// REJECT, gets re-stamped to revisit-* by the daily revisit workflow).

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
