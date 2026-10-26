// CRMA-1651, offline measurement: how long one inline Gemini batch takes for
// the lifecycle agent's one-request shape (crma-1647/oneshot.mjs --retire-note
// --max-tokens=8192). Submits, polls every 60 s, then counts results.
//
//   node docs/wayfinder/assets/crma-1651/batch-latency.mjs --size=120
//   node docs/wayfinder/assets/crma-1651/batch-latency.mjs --size=25
//
// The prompt edits are copied from oneshot.mjs, not imported: that file runs
// its whole evaluation on import.

import { readFileSync, appendFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStep } from "../crma-1647/lib/entry_module.mjs";
import { geminiKey } from "../crma-1647/lib/secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "..", "..", "..", "lifecycle-subagent-p_gYC562o", "run_subagent", "entry.js");
const LOG = join(HERE, "batch-latency-log.jsonl");
const API = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3.8-flash";
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const size = Number(arg("size", 120));
const MAX_WAIT_MS = 6 * 3600 * 1000;
const log = (o) => {
  const row = { at: new Date().toISOString(), size, ...o };
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

// Same body callGemini builds for oneshot.mjs --max-tokens=8192 --retire-note.
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

const payload = { batch: { displayName: `crma-1651-latency-${size}`, inputConfig: { requests: { requests } } } };
log({ event: "submitting", n: requests.length, payload_bytes: JSON.stringify(payload).length });
const t0 = Date.now();
const op = await api("POST", `models/${MODEL}:batchGenerateContent`, payload);
log({ event: "submitted", name: op.name, state: op.metadata?.state, submit_ms: Date.now() - t0 });

let last = op.metadata?.state;
let b = op;
const DONE = /SUCCEEDED|FAILED|CANCELLED|EXPIRED/;
while (!DONE.test(b.metadata?.state ?? "")) {
  if (Date.now() - t0 > MAX_WAIT_MS) {
    log({ event: "gave_up", name: op.name, state: last, elapsed_s: (Date.now() - t0) / 1000 });
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 60_000));
  try {
    b = await api("GET", op.name);
  } catch (e) {
    log({ event: "poll_error", error: e.message.slice(0, 300) });
    continue;
  }
  const st = b.metadata?.state;
  log({ event: "poll", state: st, changed: st !== last, elapsed_s: (Date.now() - t0) / 1000, stats: b.metadata?.batchStats });
  last = st;
}
log({ event: "done", state: last, elapsed_s: (Date.now() - t0) / 1000, metadata: { ...b.metadata, output: undefined } });

// Inline results come back on the operation's response (or the batch's output).
const inl = b.response?.inlinedResponses?.inlinedResponses ?? b.metadata?.output?.inlinedResponses?.inlinedResponses ?? [];
const c = { returned: inl.length, keyed: 0, succeeded: 0, errored: 0, not_json: 0, missing_status: 0, finish: {}, status_counts: {}, usage: { prompt: 0, candidates: 0, thoughts: 0, total: 0 } };
for (const r of inl) {
  if (r.metadata?.key) c.keyed++;
  if (r.error || !r.response) { c.errored++; c.sample_error ??= r.error; continue; }
  c.succeeded++;
  const cand = r.response.candidates?.[0];
  c.finish[cand?.finishReason] = (c.finish[cand?.finishReason] ?? 0) + 1;
  const u = r.response.usageMetadata ?? {};
  c.usage.prompt += u.promptTokenCount ?? 0;
  c.usage.candidates += u.candidatesTokenCount ?? 0;
  c.usage.thoughts += u.thoughtsTokenCount ?? 0;
  c.usage.total += u.totalTokenCount ?? 0;
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  let e = null;
  try { e = JSON.parse(text); } catch { c.not_json++; continue; }
  if (!e?.status) c.missing_status++;
  else c.status_counts[e.status] = (c.status_counts[e.status] ?? 0) + 1;
}
c.cost_usd_batch = +((c.usage.prompt * 0.375 + (c.usage.candidates + c.usage.thoughts) * 1.875) / 1e6).toFixed(4);
if (!inl.length) c.raw_shape = JSON.stringify(b).slice(0, 1500);
log({ event: "results", name: op.name, ...c });
