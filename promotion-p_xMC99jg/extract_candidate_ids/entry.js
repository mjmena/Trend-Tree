// Promotion Lead — extract_candidate_ids
//
// Take the q_load_pending_candidates rows, slice to top max_candidates,
// UUID-validate each id, and emit:
//   - selected[]                 — the candidate row objects
//   - selected_ids_json          — JSON string of just the ids (for :1-bound queries)
//   - selected_id_sql_in         — quoted CSV for inline IN-list interpolation
//
// SQL ordering already applied PRIORITY DESC + CONFIDENCE DESC + CREATED_AT ASC,
// so we just take the top N. No LLM judgment.

const UUID_LIKE = /^[A-Za-z0-9_\-]{1,64}$/;

export default defineComponent({
  name: "Promotion: extract candidate ids",
  description: "Slice top-N candidates and emit id payloads for downstream SQL steps",
  version: "0.0.1",
  props: {
    pending_rows: { type: "any", optional: true },
    max_candidates: { type: "string", default: "15" },
  },
  async run({ $ }) {
    const rows = Array.isArray(this.pending_rows) ? this.pending_rows : [];
    const cap = Math.max(1, Number(this.max_candidates) || 15);

    const valid = [];
    let skipped = 0;
    for (const r of rows) {
      if (valid.length >= cap) break;
      const cid = r.CANDIDATE_ID || r.candidate_id;
      if (!cid || !UUID_LIKE.test(String(cid))) {
        skipped += 1;
        continue;
      }
      valid.push(r);
    }

    const ids = valid.map((r) => r.CANDIDATE_ID || r.candidate_id);
    const selected_ids_json = JSON.stringify(ids);
    const selected_id_sql_in = ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",") || "''";

    console.log(`extract_candidate_ids: ${valid.length} selected from ${rows.length} pending (skipped ${skipped} invalid uuids)`);

    $.export("$summary", `${valid.length} candidates queued for promotion`);

    return {
      selected: valid,
      selected_count: valid.length,
      pending_count: rows.length,
      selected_ids_json,
      selected_id_sql_in,
    };
  },
});
