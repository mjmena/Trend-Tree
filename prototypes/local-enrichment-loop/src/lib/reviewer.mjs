// PROTOTYPE (CRMA-438) — name reviewer, ported from
// enrichment-p_xMC995w/run_name_reviewer/entry.js. Delta vs. prod: takes a
// bare `api_key` instead of the Pipedream `anthropic` app prop; tier1Check
// and its helpers are exported for unit tests.

import { loadPrompts, render, mustGet, parseJsonFromText } from "./prompt_loader.mjs";

export const MODEL = "claude-sonnet-4-6";
const RATES_PER_M = { input: 3.0, output: 15.0 };
const ANTHROPIC_VERSION = "2023-06-01";

export const DECODER_PROMPT_KEY = "enrichment.reviewer.decoder";
export const VERIFIER_PROMPT_KEY = "enrichment.reviewer.verifier";

// Tier-1 first-beat blocklist per ADR-0001. Category-of-change words that
// describe the SHAPE of a cultural shift rather than the substance of it.
export const TIER1_BANNED_FIRST_BEAT = new Set([
  "architecture", "maximalism", "minimalism", "wellness", "modernism",
  "movement", "era", "wave", "mode", "aesthetic", "vibe", "paradigm",
  "philosophy",
]);

const SKIP_LEADING = new Set([
  "the", "a", "an", "of", "for", "in", "on", "at", "to", "and", "or",
]);

export function firstBeatTokens(name) {
  if (!name || typeof name !== "string") return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
}

export function tier1Check(name) {
  const tokens = firstBeatTokens(name);
  // Take the first 3 non-article tokens — that's the "first beat" surface.
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

export async function runNameReviewer({ api_key, agent_output, metrics_rows, prompts_rows, log = () => {} }) {
  const agent = agent_output || {};
  const enrichment = agent.enrichment_output;
  if (agent.gated || !enrichment) {
    log(`reviewer skipped: gated=${!!agent.gated} has_output=${!!enrichment}`);
    return { skipped: true, reason: agent.gated ? "gated" : "no_enrichment_output" };
  }

  const trendName = enrichment.trend_name;
  if (!trendName) {
    log("reviewer skipped: agent emitted no trend_name");
    return { skipped: true, reason: "no_trend_name" };
  }

  const trendTopic = (metrics_rows?.[0]?.TREND_TOPIC) || "(unknown topic)";
  const category = enrichment.category || "?";
  const subcategory = enrichment.subcategory || "?";

  // ── Stage 1: Tier-1 mechanical check ───────────────────────────────
  const tier1 = tier1Check(trendName);
  if (!tier1.pass) {
    log(`reviewer Tier-1 FAIL: first-beat banned word '${tier1.banned_word}' in "${trendName}"`);
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

  const loaded = loadPrompts(prompts_rows);
  const decoderPrompt = mustGet(loaded, DECODER_PROMPT_KEY);
  const verifierPrompt = mustGet(loaded, VERIFIER_PROMPT_KEY);
  if (!api_key) throw new Error("api_key is required (ANTHROPIC_API_KEY) — or pass --skip-reviewer");

  // ── Stage 2: Decoder call (blind, no topic) ────────────────────────
  const decoderSystem = render(decoderPrompt.template, { trend_name: trendName });
  const decoderResp = await callAnthropic({
    apiKey: api_key,
    system: decoderSystem,
    userMessage: "Decode the trend name. Reply with JSON only.",
    maxTokens: decoderPrompt.params.max_tokens || 200,
    temperature: decoderPrompt.params.temperature ?? 0.8,
  });

  if (decoderResp.error) {
    log(`decoder error: ${decoderResp.error}`);
    return { tier1_pass: true, decoder_error: decoderResp.error, decode_pass: null, skipped: true, reason: "decoder_http_error" };
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
    apiKey: api_key,
    system: verifierSystem,
    userMessage: "Verify the name decodes correctly. Reply with JSON only.",
    maxTokens: verifierPrompt.params.max_tokens || 500,
    temperature: verifierPrompt.params.temperature ?? 0.4,
  });

  if (verifierResp.error) {
    log(`verifier error: ${verifierResp.error}`);
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

  log(`reviewer done: name="${trendName}" decode_pass=${decode_pass} score=${score} alt=${alternate ? `"${alternate}"` : "—"} cost=$${total_cost_usd} ${total_duration_ms}ms`);

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
}
