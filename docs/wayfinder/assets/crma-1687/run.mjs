// CRMA-1687 step 2: replay the frozen snapshot with one model in one shape,
// and write each trend's tokens, turns and answer to out/run-<label>.jsonl.
//
// Offline by construction: no Snowflake access, so nothing reaches
// FCT_TREND_SIGNALS.
//
// --mode=loop     today's tool loop. Tool schemas and dispatchers are the
//                 deployed ones (loaded from run_subagent/entry.js); loop knobs
//                 come from the snapshot's MODEL_PARAMS with entry.js's
//                 LOOP_DEFAULTS as fallback; temperature 1.0 as production sends.
// --mode=oneshot  one generateContent request per trend, the shape a Gemini
//                 batch entry takes: the same prompt with the tool wording
//                 rewritten, no tools, commit_attributions' schema as the
//                 responseSchema. Batch cost is 50% of this request's cost.
//
// Empty-pool trends are recorded at $0 without a call, as production does.
// Known delta from production: functionResponse parts carry the functionCall
// id (lib/gemini.mjs, CRMA-727 defect 1).
//
// Resumable per label: trends with a good row are skipped; error rows retried.
//
//   node docs/wayfinder/assets/crma-1687/run.mjs --mode=loop --model=gemini-3.1-pro-preview --label=pro-loop
//   node docs/wayfinder/assets/crma-1687/run.mjs --mode=oneshot --model=gemini-3.8-flash --label=flash-1req

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStep } from "./lib/entry_module.mjs";
import { runLoop, terminalEmission, callGemini, costBothWays } from "./lib/gemini.mjs";
import { geminiKey } from "./lib/secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "..", "..", "..", "lifecycle-attribution-subagent-p_PACe77B", "run_subagent", "entry.js");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const mode = arg("mode");
const model = arg("model");
const label = arg("label");
if (!["loop", "oneshot"].includes(mode) || !model || !label) throw new Error("--mode=loop|oneshot, --model and --label are required");
const concurrency = Number(arg("concurrency", 6));
const oneshotMaxTokens = Number(arg("max-tokens", 8192));
const OUT = join(HERE, "out", `run-${label}.jsonl`);

const snapshot = readFileSync(join(HERE, "out", "snapshot.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const done = new Set(
  existsSync(OUT)
    ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error).map((r) => r.trend_id)
    : [],
);
const todo = snapshot.filter((s) => !done.has(s.trend_id));
console.error(`${label} (${model}, ${mode}): ${snapshot.length} frozen, ${done.size} done, ${todo.length} to run`);

const { ALL_TOOL_NAMES, TOOL_SCHEMAS, toFunctionDeclarations, dispatchTool, LOOP_DEFAULTS } = await loadStep(ENTRY, [
  "ALL_TOOL_NAMES", "TOOL_SCHEMAS", "toFunctionDeclarations", "dispatchTool", "LOOP_DEFAULTS",
]);
const apiKey = geminiKey();

const EDITS = [
  [/═══ AVAILABLE TOOLS ═══[\s\S]*?(?=═══ ATTRIBUTION RUBRIC ═══)/, ""],
  [/Call `commit_attributions` exactly once with the confirmed list\. Pass an empty array if nothing qualifies/,
    "Return one JSON object whose `attributions` array holds the confirmed { signal_id, link_type } pairs. link_type must be one of: news | social | commerce | other. Return an empty array if nothing qualifies"],
  [/ — and commit those links so/, " — so"],
];
function oneShotSystem(system) {
  let s = system;
  for (const [re, to] of EDITS) {
    if (!re.test(s)) throw new Error(`prompt edit did not match: ${re}`);
    s = s.replace(re, to);
  }
  if (/commit_attributions|filter_candidates/.test(s)) throw new Error("tool wording left in prompt");
  return s;
}
const oneShotUser = (u) =>
  u.replace("Call commit_attributions exactly once with the confirmed list (empty array is a valid outcome).",
    "Return the confirmed list as one JSON object (an empty array is a valid outcome).");

const knobs = (p) => ({
  maxIterations: Number(p.max_iterations) || LOOP_DEFAULTS.max_iterations,
  budgetUsd: Number(p.budget_usd) || LOOP_DEFAULTS.budget_usd,
  perCallMaxTokens: Number(p.per_call_max_tokens) || LOOP_DEFAULTS.per_call_max_tokens,
  thinkingLevel: p.thinking_level || LOOP_DEFAULTS.thinking_level,
});

async function evaluate(s) {
  const base = { trend_id: s.trend_id, candidate_count: s.candidate_count, label, model, mode };
  if (s.candidate_count === 0) {
    return { ...base, skipped: "no_candidates", turns: 0, emission: { attributions: [] },
      accounting: { input_tokens: 0, candidates_tokens: 0, thoughts_tokens: 0, cost_as_deployed: 0, cost_with_thinking: 0 } };
  }
  const k = knobs(s.model_params || {});
  if (mode === "loop") {
    const result = await runLoop({
      apiKey, model,
      system: s.system,
      userMessage: s.user_message,
      tools: [{ functionDeclarations: toFunctionDeclarations(ALL_TOOL_NAMES) }],
      dispatchTool,
      context: { candidate_signals: s.context.candidate_signals, proposed_attributions: [] },
      ...k,
      temperature: LOOP_DEFAULTS.temperature,
    });
    return {
      ...base,
      emission: terminalEmission(result, "commit_attributions"),
      stop_reason: result.stop_reason, finish_reasons: result.finish_reasons, turns: result.turns,
      tool_sequence: result.tool_calls.map((t) => t.name),
      accounting: result.accounting,
    };
  }
  const resp = await callGemini({
    apiKey, model,
    system: oneShotSystem(s.system),
    contents: [{ role: "user", parts: [{ text: oneShotUser(s.user_message) }] }],
    responseSchema: TOOL_SCHEMAS.commit_attributions.input_schema,
    thinkingLevel: k.thinkingLevel,
    maxOutputTokens: oneshotMaxTokens,
    temperature: LOOP_DEFAULTS.temperature,
  });
  const text = resp.parts.filter((x) => !x.thought && typeof x.text === "string").map((x) => x.text).join("");
  let emission = null;
  try { emission = JSON.parse(text); } catch {}
  const c = costBothWays(resp.usage, model);
  return {
    ...base, emission, stop_reason: resp.finishReason, finish_reasons: [resp.finishReason], turns: 1, tool_sequence: [],
    accounting: { ...c, reconciles: [c.reconciles] },
    ...(emission ? {} : { raw_text: text.slice(0, 600) }),
  };
}

async function withRetry(s) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await evaluate(s);
    } catch (e) {
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || /fetch failed|abort/i.test(e.message);
      if (!retryable || attempt >= 4) {
        return { trend_id: s.trend_id, label, model, mode, error: e.message.slice(0, 600) };
      }
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

let next = 0;
let failed = 0;
async function worker() {
  while (next < todo.length) {
    const s = todo[next++];
    const row = await withRetry(s);
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    if (row.error) failed++;
    console.error(`${label} ${s.trend_id} ${row.error ? "ERROR " + row.error.slice(0, 120)
      : `${row.emission?.attributions?.length ?? "(no emission)"}/${s.candidate_count} turns=${row.turns} $${row.accounting.cost_with_thinking}`}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.error(`${label}: finished, ${failed} error row(s). Re-run the same command to retry them.`);
