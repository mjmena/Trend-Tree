// CRMA-1672, offline measurement: what a cancelled Gemini batch reports about
// spend. Submits the CRMA-1651 one-request batch, cancels it after a delay,
// then records state, batchStats and any returned usageMetadata.
//
//   node docs/wayfinder/assets/crma-1672/cancel-billing.mjs --size=120 --cancel-after-s=0
//   node docs/wayfinder/assets/crma-1672/cancel-billing.mjs --size=120 --cancel-after-s=90
//
// Setup is copied from crma-1651/batch-latency.mjs, which runs on import.

import { readFileSync, appendFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStep } from "../crma-1647/lib/entry_module.mjs";
import { geminiKey } from "../crma-1647/lib/secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "..", "..", "..", "lifecycle-subagent-p_gYC562o", "run_subagent", "entry.js");
const LOG = join(HERE, "cancel-billing-log.jsonl");
const API = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3.8-flash";
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const size = Number(arg("size", 120));
const cancelAfterS = Number(arg("cancel-after-s", 0));
const log = (o) => {
  const row = { at: new Date().toISOString(), size, cancelAfterS, ...o };
  appendFileSync(LOG, JSON.stringify(row) + "\n");
  console.error(JSON.stringify(row));
};

// Same edits as oneshot.mjs with --retire-note.
const EDITS = [
  [/emitting one structured decision via `propose_lifecycle_decision`/, "returning one structured JSON decision"],
  [/ The in-process query tools just slice and filter that prefetched data\./, ""],
  [/═══ AVAILABLE TOOLS ═══[\s\S]*?(?=═══ THE DECISION YOU MUST MAKE ═══)/, ""],
  [/Output via `propose_lifecycle_decision`:/, "Output one JSON object:"],
  [/Use query tools if you want to slice it differently\. /, ""],
  [/Then call `propose_lifecycle_decision` exactly once with your final answer\./, "Then return your final answer as one JSON object."],
  [
    /Otherwise this is the first proposal and the trend stays DORMANT\/DECLINING for now\./,
    "Otherwise this is the first proposal. Still return `status: RETIRED`: the commit step records it as the first proposal and keeps the trend DORMANT/DECLINING for now. Returning DORMANT records no proposal.",
  ],
];
function oneShotSystem(system) {
  let s = system;
  for (const [re, to] of EDITS) {
    if (!re.test(s)) throw new Error(`prompt edit did not match: ${re}`);
    s = s.replace(re, to);
  }
  if (/propose_lifecycle_decision|query_(trend|signal|lifecycle)/.test(s)) throw new Error("tool wording left in prompt");
  return s;
}
const oneShotUser = (u) => u.replace("Call propose_lifecycle_decision exactly once with your final answer.", "Return your final answer as one JSON object.");

const snapshot = gunzipSync(readFileSync(join(HERE, "..", "crma-1647", "out", "snapshot.jsonl.gz")))
  .toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(0, size);
const { TOOL_SCHEMAS } = await loadStep(ENTRY, ["TOOL_SCHEMAS"]);
const responseSchema = TOOL_SCHEMAS.propose_lifecycle_decision.input_schema;
const key = geminiKey();

const requests = snapshot.map((s) => ({
  metadata: { key: s.trend_id },
  request: {
    systemInstruction: { parts: [{ text: oneShotSystem(s.system) }] },
    contents: [{ role: "user", parts: [{ text: oneShotUser(s.user_message) }] }],
    generationConfig: {
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingLevel: s.model_params?.thinking_level || "medium" },
      temperature: 1.0,
      responseMimeType: "application/json",
      responseSchema,
    },
  },
}));

async function api(method, path, body) {
  const r = await fetch(`${API}/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: body && JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

const payload = { batch: { displayName: `crma-1672-cancel-${size}-${cancelAfterS}s`, inputConfig: { requests: { requests } } } };
const t0 = Date.now();
const op = await api("POST", `models/${MODEL}:batchGenerateContent`, payload);
log({ event: "submitted", name: op.name, state: op.metadata?.state });

await new Promise((r) => setTimeout(r, cancelAfterS * 1000));
const before = await api("GET", op.name);
log({ event: "before_cancel", state: before.metadata?.state, stats: before.metadata?.batchStats, elapsed_s: (Date.now() - t0) / 1000 });
const cancel = await api("POST", `${op.name}:cancel`, {});
log({ event: "cancel_called", response: cancel, elapsed_s: (Date.now() - t0) / 1000 });

let b = before;
const DONE = /SUCCEEDED|FAILED|CANCELLED|EXPIRED/;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  b = await api("GET", op.name);
  if (DONE.test(b.metadata?.state ?? "")) break;
}
log({ event: "after_cancel", elapsed_s: (Date.now() - t0) / 1000, metadata: { ...b.metadata, output: undefined }, done: b.done, has_response: !!b.response, error: b.error });

const inl = b.response?.inlinedResponses?.inlinedResponses ?? b.metadata?.output?.inlinedResponses?.inlinedResponses ?? [];
const c = { returned: inl.length, succeeded: 0, errored: 0, sample_error: undefined, usage: { prompt: 0, candidates: 0, thoughts: 0 } };
for (const r of inl) {
  if (r.error || !r.response) { c.errored++; c.sample_error ??= r.error; continue; }
  c.succeeded++;
  const u = r.response.usageMetadata ?? {};
  c.usage.prompt += u.promptTokenCount ?? 0;
  c.usage.candidates += u.candidatesTokenCount ?? 0;
  c.usage.thoughts += u.thoughtsTokenCount ?? 0;
}
c.cost_usd_batch = +((c.usage.prompt * 0.375 + (c.usage.candidates + c.usage.thoughts) * 1.875) / 1e6).toFixed(4);
c.raw_shape = JSON.stringify({ ...b, response: b.response && { ...b.response, inlinedResponses: `<${inl.length}>` } }).slice(0, 2000);
log({ event: "results", name: op.name, ...c });
