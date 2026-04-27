// Enrichment — run_name_reviewer (Layer 4)
//
// Single Sonnet 4.6 call that reviews the names the main agent emitted.
// Does NOT auto-replace — both the agent's pick and the reviewer's
// alternate go to Snowflake (DIM_TREND_ENRICHMENT.NAME_REVIEWER) so we
// can A/B compare which the dashboard team prefers.
//
// Skipped (no LLM call) when:
//   - the run was gated (enrichment_type != FULL)
//   - the agent didn't emit an enrichment_output (e.g. stopped early)
//
// Cost target: ~$0.005 per call (≤500 output tokens).

const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 };
const ANTHROPIC_VERSION = "2023-06-01";
const REVIEWER_PROMPT_KEY = "enrichment.reviewer.system";

export default defineComponent({
  props: {
    anthropic: { type: "app", app: "anthropic" },
    agent_output: { type: "any" },
    metrics_rows: { type: "any", optional: true },
    signal_rows: { type: "any", optional: true },
    prompts_rows: { type: "any" },
  },
  async run({ $ }) {
    const agent = this.agent_output || {};
    const enrichment = agent.enrichment_output;
    if (agent.gated || !enrichment) {
      console.log(`reviewer skipped: gated=${!!agent.gated} has_output=${!!enrichment}`);
      $.export("$summary", "reviewer skipped");
      return { skipped: true, reason: agent.gated ? "gated" : "no_enrichment_output" };
    }

    const trendTopic = (this.metrics_rows?.[0]?.TREND_TOPIC) || "(unknown topic)";
    const category = enrichment.category || "?";
    const subcategory = enrichment.subcategory || "?";

    const sampleSignals = (this.signal_rows || []).slice(0, 3)
      .map((r, i) => `${i + 1}. ${r.TITLE || r.SIGNAL_NAME || "(untitled)"}`)
      .join("\n") || "(no signals)";

    const prompt = mustGet(loadPrompts(this.prompts_rows), REVIEWER_PROMPT_KEY);
    const system = render(prompt.template, {
      trend_topic: trendTopic,
      category,
      subcategory,
      sample_signal_titles: sampleSignals,
      trend_name_b2b: enrichment.trend_name_b2b || "(missing)",
      trend_name_b2c: enrichment.trend_name_b2c || "(missing)",
    });

    const max_tokens = prompt.params.max_tokens || 500;
    const temperature = prompt.params.temperature ?? 0.7;

    const started = Date.now();
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.anthropic.$auth.api_key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens,
        system,
        messages: [{ role: "user", content: "Score the proposed names. Reply with JSON only." }],
        temperature,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.log(`reviewer HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      $.export("$summary", `reviewer error ${resp.status}`);
      return { skipped: true, reason: "http_error", status: resp.status, error: errText.slice(0, 300) };
    }

    const data = await resp.json();
    const usage = data.usage || {};
    const tin = usage.input_tokens || 0;
    const tout = usage.output_tokens || 0;
    const cost_usd = Math.round((((tin / 1_000_000) * RATES_PER_M.input + (tout / 1_000_000) * RATES_PER_M.output)) * 10000) / 10000;

    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const review = parseJsonFromText(text);

    const duration_ms = Date.now() - started;
    console.log(`reviewer done: scores=${review?.score_b2b}/${review?.score_b2c} cost=$${cost_usd} ${duration_ms}ms`);
    $.export("$summary", `b2b ${review?.score_b2b ?? "?"} / b2c ${review?.score_b2c ?? "?"} ($${cost_usd})`);

    return {
      review: review || { error: "could not parse JSON", raw: text.slice(0, 500) },
      tokens: { input: tin, output: tout },
      cost_usd,
      duration_ms,
      model: MODEL,
      prompt_version: prompt.version,
    };
  },
});

// ─── inlined helpers ───────────────────────────────────────────────────

function loadPrompts(rows) {
  const out = {};
  for (const r of rows || []) {
    let params = {};
    try { params = typeof r.MODEL_PARAMS === "string" ? JSON.parse(r.MODEL_PARAMS) : (r.MODEL_PARAMS || {}); } catch { params = {}; }
    out[r.PROMPT_KEY] = { template: r.TEMPLATE, version: r.VERSION, model: r.MODEL, params };
  }
  return out;
}

function render(template, vars) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function mustGet(loaded, key) {
  const p = loaded[key];
  if (!p) throw new Error(`prompt ${key} not found in DIM_LLM_PROMPT (IS_ACTIVE=TRUE)`);
  return p;
}

function parseJsonFromText(text) {
  if (!text) return null;
  // Try whole-string parse first, then bracket extraction.
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
