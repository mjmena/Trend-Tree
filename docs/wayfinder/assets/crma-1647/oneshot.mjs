// PROTOTYPE (CRMA-1649), throwaway: one generateContent request per trend
// instead of the tool loop, over the same frozen snapshot as run.mjs.
//
// The snapshot's system prompt already carries every prefetched block, and the
// four tools only re-slice it. So this sends the same prompt with the tool
// wording rewritten, no tools, and propose_lifecycle_decision's own schema as
// the responseSchema. Rows use run.mjs's format, so score.mjs reads them as-is.
//
//   node docs/wayfinder/assets/crma-1647/oneshot.mjs --model=gemini-3.8-flash --label=flash-1req
//   node docs/wayfinder/assets/crma-1647/oneshot.mjs --model=gemini-3.8-flash --label=flash-1req-8k --max-tokens=8192
//   node docs/wayfinder/assets/crma-1647/oneshot.mjs --model=gemini-3.8-flash --label=flash-1req-note --max-tokens=8192 --retire-note
//   node docs/wayfinder/assets/crma-1647/score.mjs --c=flash-1req --out=report-flash-1req

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStep } from "./lib/entry_module.mjs";
import { callGemini, costBothWays } from "./lib/gemini.mjs";
import { geminiKey } from "./lib/secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "..", "..", "..", "lifecycle-subagent-p_gYC562o", "run_subagent", "entry.js");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const model = arg("model");
const label = arg("label");
if (!model || !label) throw new Error("--model and --label are required");
const limit = Number(arg("limit", Infinity));
const concurrency = Number(arg("concurrency", 6));
const maxTokens = arg("max-tokens"); // default: the snapshot's per_call_max_tokens
const retireNote = process.argv.includes("--retire-note");
const OUT = join(HERE, "out", `run-${label}.jsonl`);

const snapshot = readFileSync(join(HERE, "out", "snapshot.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const done = new Set(
  existsSync(OUT)
    ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error).map((r) => r.trend_id)
    : [],
);
const only = arg("only")?.split(",");
const todo = snapshot.filter((s) => !done.has(s.trend_id) && (!only || only.includes(s.trend_id))).slice(0, limit);
console.error(`${label} (${model}, one request): ${snapshot.length} frozen, ${done.size} done, ${todo.length} to run`);

const { TOOL_SCHEMAS } = await loadStep(ENTRY, ["TOOL_SCHEMAS"]);
const responseSchema = TOOL_SCHEMAS.propose_lifecycle_decision.input_schema;
const apiKey = geminiKey();

const EDITS = [
  [/emitting one structured decision via `propose_lifecycle_decision`/, "returning one structured JSON decision"],
  [/ The in-process query tools just slice and filter that prefetched data\./, ""],
  [/═══ AVAILABLE TOOLS ═══[\s\S]*?(?=═══ THE DECISION YOU MUST MAKE ═══)/, ""],
  [/Output via `propose_lifecycle_decision`:/, "Output one JSON object:"],
  [/Use query tools if you want to slice it differently\. /, ""],
  [/Then call `propose_lifecycle_decision` exactly once with your final answer\./, "Then return your final answer as one JSON object."],
];
// --retire-note: the loop's tool framing made models emit RETIRED for a first
// proposal; one request loses that, and a DORMANT answer records no proposal.
const RETIRE_NOTE = [
  /Otherwise this is the first proposal and the trend stays DORMANT\/DECLINING for now\./,
  "Otherwise this is the first proposal. Still return `status: RETIRED`: the commit step records it as the first proposal and keeps the trend DORMANT/DECLINING for now. Returning DORMANT records no proposal.",
];
function oneShotSystem(system) {
  let s = system;
  for (const [re, to] of retireNote ? [...EDITS, RETIRE_NOTE] : EDITS) {
    if (!re.test(s)) throw new Error(`prompt edit did not match: ${re}`);
    s = s.replace(re, to);
  }
  if (/propose_lifecycle_decision|query_(trend|signal|lifecycle)/.test(s)) throw new Error("tool wording left in prompt");
  return s;
}
const oneShotUser = (u) => u.replace("Call propose_lifecycle_decision exactly once with your final answer.", "Return your final answer as one JSON object.");

async function evaluate(s) {
  const p = s.model_params || {};
  const resp = await callGemini({
    apiKey, model,
    system: oneShotSystem(s.system),
    contents: [{ role: "user", parts: [{ text: oneShotUser(s.user_message) }] }],
    responseSchema,
    thinkingLevel: p.thinking_level || "medium",
    maxOutputTokens: Number(maxTokens ?? p.per_call_max_tokens) || 3072,
    temperature: 1.0,
  });
  const text = resp.parts.filter((x) => !x.thought && typeof x.text === "string").map((x) => x.text).join("");
  let emission = null;
  try { emission = JSON.parse(text); } catch {}
  const c = costBothWays(resp.usage, model);
  return {
    trend_id: s.trend_id, stratum: s.stratum, current_status: s.current_status, label, model,
    emission, stop_reason: resp.finishReason, finish_reasons: [resp.finishReason], turns: 1, tool_sequence: [],
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
