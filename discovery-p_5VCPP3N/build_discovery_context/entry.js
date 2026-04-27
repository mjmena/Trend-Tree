// Discovery — build_discovery_context
//
// Pre-flattens active trend topics + valuable trend examples into the
// strings that the discovery prompts' {{active_trends}} and
// {{valuable_examples}} placeholders consume. Done once per workflow run
// so the same blob feeds Gemini, Grok, ChatGPT, and Claude rerank.
//
// Also publishes the canonical vertical list — each discover_* step fans
// out one parallel call per vertical (categorical sharding). v3 prompts
// in DIM_LLM_PROMPT consume {{vertical}} accordingly.

const VERTICALS = [
  "wellness",
  "food_beverage",
  "beauty_personal_care",
  "fashion_apparel",
  "home_lifestyle",
  "commerce_retail",
];

export default defineComponent({
  props: {
    active_trends_rows: { type: "any", optional: true },
    examples_rows: { type: "any", optional: true },
  },
  async run({ $ }) {
    const activeRows = Array.isArray(this.active_trends_rows) ? this.active_trends_rows : [];
    const exampleRows = Array.isArray(this.examples_rows) ? this.examples_rows : [];

    const active_trends_formatted = activeRows
      .map((r, i) => `${i + 1}. ${r.TREND_TOPIC || "(untitled)"}`)
      .join("\n") || "(no active trends in last 30d)";

    const valuable_examples_formatted = exampleRows
      .map((r, i) => {
        const b2b = r.TREND_NAME_B2B || "";
        const b2c = r.TREND_NAME_B2C || "";
        const cat = `${r.CATEGORY || "?"}/${r.SUBCATEGORY || "?"}`;
        const summary = (r.SUMMARY_SHORT || "").replace(/\s+/g, " ").trim().slice(0, 240);
        return `${i + 1}. "${b2b}" / "${b2c}" — ${cat}: ${summary}`;
      })
      .join("\n") || "(no examples available)";

    const out = {
      active_trends_formatted,
      valuable_examples_formatted,
      active_count: activeRows.length,
      example_count: exampleRows.length,
      verticals: VERTICALS,
      current_date: new Date().toISOString().slice(0, 10),  // YYYY-MM-DD
    };

    console.log(`Context built: ${out.active_count} active trends, ${out.example_count} examples, ${VERTICALS.length} verticals, today=${out.current_date}`);
    $.export("$summary", `${out.active_count} active / ${out.example_count} examples / ${VERTICALS.length} verticals`);
    return out;
  },
});
