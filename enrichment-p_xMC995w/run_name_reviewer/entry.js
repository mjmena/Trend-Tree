// Enrichment — run_name_reviewer (Layer 4)
//
// Three-stage review of the agent's single emitted trend_name:
//
//   1. Tier-1 mechanical check — regex against the first-beat noun. If the
//      leading noun is a category-of-change word (architecture, maximalism,
//      modernism, movement, era, wave, mode, aesthetic, vibe, paradigm,
//      philosophy, wellness, minimalism), instant fail — both LLM calls
//      skipped. Saves cost on names that won't survive review anyway.
//
//   2. Decoder call (Sonnet 4.6) — sees ONLY the trend_name, no topic, no
//      context. Writes a one-sentence blind guess of what the trend is
//      about. Prompt key: enrichment.reviewer.decoder.
//
//   3. Verifier call (Sonnet 4.6) — sees the decoder's blind guess +
//      actual topic + category. Returns decode_pass + score + alternate.
//      Prompt key: enrichment.reviewer.verifier.
//
// Output: { skipped, tier1_pass, decode_guess, decode_pass, score,
//           alternate, rationale, tokens, cost_usd, decoder_*, verifier_* }
//
// Both alternates persist to FCT_TREND_ENRICHMENT_LEDGER.PAYLOAD:name_reviewer
// downstream — the write workflow chooses whether to swap the canonical
// name based on decode_pass.
//
// Skipped (no LLM call) when:
//   - the run was gated (enrichment_type != FULL)
//   - the agent didn't emit an enrichment_output (e.g. stopped early)
//
// Cost target: ~$0.01 per full review (two short Sonnet calls).

const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 };
const ANTHROPIC_VERSION = "2023-06-01";

const DECODER_PROMPT_KEY = "enrichment.reviewer.decoder";
const VERIFIER_PROMPT_KEY = "enrichment.reviewer.verifier";

// Tier-1 first-beat blocklist per ADR-0001. Category-of-change words that
// describe the SHAPE of a cultural shift rather than the substance of it.
// Banned as the leading noun; allowed in the qualifier beat.
const TIER1_BANNED_FIRST_BEAT = new Set([
  "architecture", "maximalism", "minimalism", "wellness", "modernism",
  "movement", "era", "wave", "mode", "aesthetic", "vibe", "paradigm",
  "philosophy",
]);

// Articles/prepositions to skip when finding the "first beat noun".
const SKIP_LEADING = new Set([
  "the", "a", "an", "of", "for", "in", "on", "at", "to", "and", "or",
]);

function firstBeatTokens(name) {
  if (!name || typeof name !== "string") return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
}

function tier1Check(name) {
  const tokens = firstBeatTokens(name);
  // Take the first 3 non-article tokens — that's the "first beat" surface.
  // Any of those matching a banned word = fail.
  const beat = [];
  for (const t of tokens) {
    if (SKIP_LEADING.has(t)) continue;
    beat.push(t);
    if (beat.length >= 3) break;
  }
  for (const t of beat) {
    if (TIER1_BANNED_FIRST_BEAT.has(t)) {
      return { pass: false, banned_word: t, first_beat: beat.join(" ") };
    }
  }
  return { pass: true, first_beat: beat.join(" ") };
}

async function callAnthropic({ apiKey, system, userMessage, maxTokens, temperature }) {
  const started = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
      temperature,
    }),
  });
  const duration_ms = Date.now() - started;

  if (!resp.ok) {
    const errText = await resp.text();
    return { error: `HTTP ${resp.status}: ${errText.slice(0, 300)}`, duration_ms };
  }

  const data = await resp.json();
  const usage = data.usage || {};
  const tin = usage.input_tokens || 0;
  const tout = usage.output_tokens || 0;
  const cost_usd = Math.round(
    (((tin / 1_000_000) * RATES_PER_M.input + (tout / 1_000_000) * RATES_PER_M.output)) * 10000
  ) / 10000;
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, tokens: { input: tin, output: tout }, cost_usd, duration_ms };
}

export default defineComponent({
  props: {
    anthropic: { type: "app", app: "anthropic" },
    agent_output: { type: "any" },
    metrics_rows: { type: "any", optional: true },
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

    const trendName = enrichment.trend_name;
    if (!trendName) {
      console.log("reviewer skipped: agent emitted no trend_name");
      $.export("$summary", "reviewer skipped (no trend_name)");
      return { skipped: true, reason: "no_trend_name" };
    }

    const trendTopic = (this.metrics_rows?.[0]?.TREND_TOPIC) || "(unknown topic)";
    const category = enrichment.category || "?";
    const subcategory = enrichment.subcategory || "?";

    // ── Stage 1: Tier-1 mechanical check ───────────────────────────────
    const tier1 = tier1Check(trendName);
    if (!tier1.pass) {
      console.log(`reviewer Tier-1 FAIL: first-beat banned word '${tier1.banned_word}' in "${trendName}"`);
      $.export("$summary", `Tier-1 fail: ${tier1.banned_word}`);
      return {
        tier1_pass: false,
        tier1_banned_word: tier1.banned_word,
        tier1_first_beat: tier1.first_beat,
        decode_pass: false,
        score: 0,
        rationale: `First-beat noun '${tier1.banned_word}' is on the banned category-of-change blocklist.`,
        alternate: null,
        decoder_skipped: true,
        verifier_skipped: true,
        tokens: { input: 0, output: 0 },
        cost_usd: 0,
        model: MODEL,
      };
    }

    const loaded = loadPrompts(this.prompts_rows);
    const decoderPrompt = mustGet(loaded, DECODER_PROMPT_KEY);
    const verifierPrompt = mustGet(loaded, VERIFIER_PROMPT_KEY);
    const apiKey = this.anthropic.$auth.api_key;

    // ── Stage 2: Decoder call (blind, no topic) ────────────────────────
    const decoderSystem = render(decoderPrompt.template, { trend_name: trendName });
    const decoderResp = await callAnthropic({
      apiKey,
      system: decoderSystem,
      userMessage: "Decode the trend name. Reply with JSON only.",
      maxTokens: decoderPrompt.params.max_tokens || 200,
      temperature: decoderPrompt.params.temperature ?? 0.8,
    });

    if (decoderResp.error) {
      console.log(`decoder error: ${decoderResp.error}`);
      $.export("$summary", "decoder HTTP error");
      return {
        tier1_pass: true,
        decoder_error: decoderResp.error,
        decode_pass: null,
        skipped: true,
        reason: "decoder_http_error",
      };
    }

    const decoderJson = parseJsonFromText(decoderResp.text);
    const decoderGuess = decoderJson?.guess || "(decoder emitted no parseable guess)";

    // ── Stage 3: Verifier call (sees guess + actual topic) ─────────────
    const verifierSystem = render(verifierPrompt.template, {
      trend_name: trendName,
      decoder_guess: decoderGuess,
      trend_topic: trendTopic,
      category,
      subcategory,
    });
    const verifierResp = await callAnthropic({
      apiKey,
      system: verifierSystem,
      userMessage: "Verify the name decodes correctly. Reply with JSON only.",
      maxTokens: verifierPrompt.params.max_tokens || 500,
      temperature: verifierPrompt.params.temperature ?? 0.4,
    });

    if (verifierResp.error) {
      console.log(`verifier error: ${verifierResp.error}`);
      $.export("$summary", "verifier HTTP error");
      return {
        tier1_pass: true,
        decoder_guess: decoderGuess,
        decoder_tokens: decoderResp.tokens,
        decoder_cost_usd: decoderResp.cost_usd,
        verifier_error: verifierResp.error,
        decode_pass: null,
        skipped: true,
        reason: "verifier_http_error",
      };
    }

    const verifierJson = parseJsonFromText(verifierResp.text);
    const decode_pass = verifierJson?.decode_pass === true;
    const score = typeof verifierJson?.score === "number" ? verifierJson.score : null;
    const rationale = verifierJson?.rationale || null;
    const alternate = verifierJson?.alternate || null;

    const total_tokens = {
      input: (decoderResp.tokens.input || 0) + (verifierResp.tokens.input || 0),
      output: (decoderResp.tokens.output || 0) + (verifierResp.tokens.output || 0),
    };
    const total_cost_usd = Math.round((decoderResp.cost_usd + verifierResp.cost_usd) * 10000) / 10000;
    const total_duration_ms = decoderResp.duration_ms + verifierResp.duration_ms;

    console.log(
      `reviewer done: name="${trendName}" decode_pass=${decode_pass} score=${score} alt=${alternate ? `"${alternate}"` : "—"} cost=$${total_cost_usd} ${total_duration_ms}ms`
    );
    $.export(
      "$summary",
      `decode_pass=${decode_pass} score=${score ?? "?"} ($${total_cost_usd})${alternate ? ` alt="${alternate}"` : ""}`
    );

    return {
      tier1_pass: true,
      tier1_first_beat: tier1.first_beat,
      decoder_guess: decoderGuess,
      decode_pass,
      score,
      rationale,
      alternate,
      decoder_tokens: decoderResp.tokens,
      decoder_cost_usd: decoderResp.cost_usd,
      verifier_tokens: verifierResp.tokens,
      verifier_cost_usd: verifierResp.cost_usd,
      tokens: total_tokens,
      cost_usd: total_cost_usd,
      duration_ms: total_duration_ms,
      model: MODEL,
      decoder_prompt_version: decoderPrompt.version,
      verifier_prompt_version: verifierPrompt.version,
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
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
