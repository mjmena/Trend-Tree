// CRMA-1647 step 3: run the current lifecycle prompt and tool loop over the
// frozen snapshot with one model, and write each decision to a file.
//
// Offline by construction: no Snowflake access at all, so nothing reaches
// FCT_TREND_LIFECYCLE_LEDGER or PROC_LIFECYCLE_APPLY.
//
// Tool schemas and dispatchers are the deployed ones (loaded from
// run_subagent/entry.js). Loop knobs come from the snapshot's MODEL_PARAMS,
// and temperature is 1.0 because production still sends it. Date.now() is
// pinned to the trend's snapshot_at while a tool runs, so query_signal_velocity
// counts the same windows the prompt was rendered with.
//
// Known delta from production: functionResponse parts carry the functionCall
// id (lib/gemini.mjs, CRMA-727 defect 1). Production omits it.
//
// Resumable per label: trends with a good row in out/run-<label>.jsonl are
// skipped; error rows are retried, and score.mjs reads the last good row.
//
//   node docs/wayfinder/assets/crma-1647/run.mjs --model=gemini-3.1-pro-preview --label=pro-a
//   node docs/wayfinder/assets/crma-1647/run.mjs --model=gemini-3.8-flash --label=flash [--limit=N] [--concurrency=6]

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStep } from "./lib/entry_module.mjs";
import { runLoop, terminalEmission } from "./lib/gemini.mjs";
import { geminiKey } from "./lib/secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "..", "..", "..", "lifecycle-subagent-p_gYC562o", "run_subagent", "entry.js");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const model = arg("model");
const label = arg("label");
if (!model || !label) throw new Error("--model and --label are required");
const limit = Number(arg("limit", Infinity));
const concurrency = Number(arg("concurrency", 6));
const OUT = join(HERE, "out", `run-${label}.jsonl`);

const snapshot = readFileSync(join(HERE, "out", "snapshot.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const done = new Set(
  existsSync(OUT)
    ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error).map((r) => r.trend_id)
    : [],
);
const todo = snapshot.filter((s) => !done.has(s.trend_id)).slice(0, limit);
console.error(`${label} (${model}): ${snapshot.length} frozen, ${done.size} done, ${todo.length} to run, concurrency ${concurrency}`);

const { ALL_TOOL_NAMES, toFunctionDeclarations, dispatchTool } = await loadStep(ENTRY, [
  "ALL_TOOL_NAMES", "toFunctionDeclarations", "dispatchTool",
]);
const apiKey = geminiKey();

async function evaluate(s) {
  const snapMs = new Date(s.snapshot_at).getTime();
  const pinnedDispatch = (name, args, ctx) => {
    const realNow = Date.now;
    Date.now = () => snapMs;
    // The deployed dispatchers are synchronous, so the pin covers the whole call.
    try { return dispatchTool(name, args, ctx); } finally { Date.now = realNow; }
  };
  const p = s.model_params || {};
  const result = await runLoop({
    apiKey, model,
    system: s.system,
    userMessage: s.user_message,
    tools: [{ functionDeclarations: toFunctionDeclarations(ALL_TOOL_NAMES) }],
    dispatchTool: pinnedDispatch,
    context: { ...s.context, proposed_decision: null },
    maxIterations: Number(p.max_iterations) || 8,
    budgetUsd: Number(p.budget_usd) || 0.06,
    perCallMaxTokens: Number(p.per_call_max_tokens) || 3072,
    thinkingLevel: p.thinking_level || "medium",
    temperature: 1.0,
  });
  return {
    trend_id: s.trend_id, stratum: s.stratum, current_status: s.current_status, label, model,
    emission: terminalEmission(result, "propose_lifecycle_decision"),
    stop_reason: result.stop_reason, finish_reasons: result.finish_reasons, turns: result.turns,
    tool_sequence: result.tool_calls.map((t) => t.name),
    accounting: result.accounting,
  };
}

async function withRetry(s) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await evaluate(s);
    } catch (e) {
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || /fetch failed|abort/i.test(e.message);
      if (!retryable || attempt >= 4) {
        return { trend_id: s.trend_id, stratum: s.stratum, current_status: s.current_status, label, model, error: e.message.slice(0, 600) };
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
    console.error(`${label} ${s.trend_id} [${s.stratum}] ${row.error ? "ERROR " + row.error.slice(0, 120) : `${row.emission?.status ?? "(no emission)"} next=${row.emission?.next_eval_in_hours} $${row.accounting.cost_with_thinking}`}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.error(`${label}: finished, ${failed} error row(s). Re-run the same command to retry them.`);
