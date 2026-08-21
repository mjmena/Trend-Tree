// CRMA-757 round 2 — three shapes the first matrix did not test.
//
// Round 1 established: every text-answer shape truncates at 20-30%, the loss
// is ONE ARRAY ELEMENT (clean minus truncated = 1.00 items, near-identical
// cut token on 26 of 27), and gemini-2.5-flash never does it.
//
// Round 1 also rules out the cheap knobs: thinking_level in both directions,
// dropping the deprecated temperature, and responseSchema all sit inside the
// same 70-80% band as the production baseline.
//
// What is left are three shapes that change WHERE THE ANSWER COMES BACK,
// rather than how the model is tuned:
//
//   F_pad    A sacrificial preamble ahead of the array. Only helps if a
//            fixed byte window is lost. Round 1's evidence points at a lost
//            ELEMENT instead, so this is here to FALSIFY the byte-window
//            reading cheaply rather than because it is expected to work.
//
//   G_tool   The answer arrives as a functionCall argument instead of text.
//            This is the real candidate. Every lane that truncates returns
//            TEXT under grounding; the ungrounded distillation lane returns
//            a tool call and is clean. That comparison is confounded — the
//            clean lane is also ungrounded — and this arm removes the
//            confound by grounding a tool-returning call.
//
//   H_wrap   The array nested inside an object, via responseSchema. If the
//            loss is specific to a TOP-LEVEL array, a wrapper key moves the
//            first element out of the danger position.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { callGemini, costBothWays } from "../lib/gemini.mjs";
import { geminiKey } from "../lib/secrets.mjs";

const FROZEN = JSON.parse(readFileSync(join(import.meta.dirname, process.env.PROMPT_FILE || "frozen_prompt.json"), "utf8"));
const PROMPT_TEXT = FROZEN.contents[0].parts[0].text;
const SEARCH_TOOL = { google_search: {} };

const ITEM_SCHEMA = {
  type: "OBJECT",
  properties: {
    topic: { type: "STRING" },
    evidence_url: { type: "STRING" },
    why_now: { type: "STRING" },
    vertical: { type: "STRING" },
  },
  required: ["topic", "evidence_url", "why_now", "vertical"],
};

// Sized from round 1: a serialised element runs ~590-640 chars, so 1,200
// chars of padding is roughly two elements' worth of slack.
const PAD = "PADDING".repeat(170);
const PAD_PROMPT = `${PROMPT_TEXT}

OUTPUT PREFIX (mandatory): before the JSON array, emit this line verbatim and nothing else on it:
${PAD}
Then emit the JSON array exactly as specified above.`;

const WRAP_PROMPT = `${PROMPT_TEXT}

OUTPUT SHAPE OVERRIDE: instead of a bare array, return an object with a single
key "proposals" whose value is the array described above.`;

const TOOL_PROMPT = `${PROMPT_TEXT}

OUTPUT CHANNEL OVERRIDE: do NOT write the JSON array as text. Call the
\`submit_proposals\` function exactly once, passing every proposal in its
\`proposals\` argument. Emit no prose.`;

const SUBMIT_TOOL = {
  functionDeclarations: [
    {
      name: "submit_proposals",
      description: "Submit the discovered consumer-behavior proposals.",
      parameters: {
        type: "OBJECT",
        properties: { proposals: { type: "ARRAY", items: ITEM_SCHEMA } },
        required: ["proposals"],
      },
    },
  ],
};

function stripFence(text) {
  let t = String(text || "").trim();
  const open = t.match(/^```(?:json)?\s*\n?/i);
  if (open) t = t.slice(open[0].length);
  return t.replace(/\n?```\s*$/, "").trim();
}

const answerText = (parts) =>
  (parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
const functionCalls = (parts) => (parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);

/** F_pad: did the array opener survive the padding? */
function classifyPad(text) {
  const body = stripFence(text);
  const idx = body.indexOf("[");
  const end = body.lastIndexOf("]");
  const padSurvived = body.startsWith("PADDING");
  let items = null;
  // Slice opener-to-closer: the model may fence the array AFTER the padding
  // line, which a leading-fence strip cannot reach.
  if (idx >= 0 && end > idx) {
    try {
      const v = JSON.parse(body.slice(idx, end + 1));
      if (Array.isArray(v)) items = v.length;
    } catch {
      /* opener present but body truncated elsewhere */
    }
  }
  return {
    head_ok: idx >= 0 && items != null,
    pad_survived: padSurvived,
    // How much of the mandated padding actually arrived. If the padding is
    // whole and the array is STILL cut, no leading byte window was lost and
    // a sacrificial preamble cannot be the fix.
    pad_chars_present: (body.match(/^(?:PADDING)+/) || [""])[0].length,
    pad_chars_sent: PAD.length,
    items,
    head_120: body.slice(0, 120),
    around_bracket: idx >= 0 ? body.slice(Math.max(0, idx - 20), idx + 100) : null,
    body_chars: body.length,
  };
}

/** H_wrap: did the object open and carry a complete proposals array? */
function classifyWrap(text) {
  const body = stripFence(text);
  const head_ok = body.startsWith("{");
  let items = null;
  try {
    const v = JSON.parse(body);
    if (v && Array.isArray(v.proposals)) items = v.proposals.length;
  } catch {
    /* truncated */
  }
  return { head_ok: head_ok && items != null, items, head_120: body.slice(0, 120), body_chars: body.length };
}

/** G_tool: did a complete functionCall arrive, with every item intact? */
function classifyTool(parts) {
  const calls = functionCalls(parts);
  const call = calls.find((c) => c.name === "submit_proposals");
  if (!call) {
    return { head_ok: false, items: null, no_call: true, head_120: answerText(parts).slice(0, 120), body_chars: 0 };
  }
  const arr = call.args?.proposals;
  const items = Array.isArray(arr) ? arr.length : null;
  // A complete call means every item carries all four required fields.
  const complete =
    Array.isArray(arr) && arr.every((o) => o && o.topic && o.evidence_url && o.why_now && o.vertical);
  return {
    head_ok: items != null && items > 0 && complete,
    items,
    all_fields_present: complete,
    head_120: JSON.stringify(arr?.[0] || {}).slice(0, 120),
    body_chars: JSON.stringify(call.args || {}).length,
  };
}

const SHAPES = {
  F_pad: {
    why: "sacrificial 1,190-char preamble — falsifies the fixed-byte-window reading",
    args: {
      contents: [{ parts: [{ text: PAD_PROMPT }] }],
      tools: [SEARCH_TOOL],
      temperature: 0.5,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
    },
    classify: (r) => classifyPad(answerText(r.parts)),
  },
  G_tool: {
    why: "answer returns as a functionCall argument, not text — grounded",
    args: {
      contents: [{ parts: [{ text: TOOL_PROMPT }] }],
      tools: [SEARCH_TOOL, SUBMIT_TOOL],
      temperature: 0.5,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
      // The API rejects built-in tools alongside functionDeclarations without
      // this. Found by the 400 on the first attempt (CRMA-757).
      includeServerSideToolInvocations: true,
    },
    classify: (r) => classifyTool(r.parts),
  },
  H_wrap: {
    why: "array nested under a wrapper key — tests whether a TOP-LEVEL array is the trigger",
    args: {
      contents: [{ parts: [{ text: WRAP_PROMPT }] }],
      tools: [SEARCH_TOOL],
      temperature: 0.5,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
      responseSchema: {
        type: "OBJECT",
        properties: { proposals: { type: "ARRAY", items: ITEM_SCHEMA } },
        required: ["proposals"],
      },
    },
    classify: (r) => classifyWrap(answerText(r.parts)),
  },
};

const apiKey = geminiKey();
const MODEL = "gemini-3.7-flash";

async function callWithRetry(args, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callGemini({ apiKey, model: MODEL, ...args });
    } catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || e.status >= 500 || !e.status;
      if (!retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function runOne(name, shape, i) {
  try {
    const r = await callWithRetry(shape.args);
    return {
      shape: name,
      i,
      ok: true,
      finishReason: r.finishReason,
      parts_len: r.parts.length,
      duration_ms: r.duration_ms,
      cost: costBothWays(r.usage, MODEL),
      ...shape.classify(r),
    };
  } catch (e) {
    return { shape: name, i, ok: false, error: e.message.slice(0, 400) };
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

const n = Number(process.env.N || 20);
const only = process.argv[2] ? process.argv[2].split(",") : Object.keys(SHAPES);
const concurrency = Number(process.env.CONCURRENCY || 6);

const jobs = [];
for (const name of only) {
  if (!SHAPES[name]) throw new Error(`Unknown shape '${name}'`);
  for (let i = 0; i < n; i++) jobs.push({ name, shape: SHAPES[name], i });
}

console.log(`# CRMA-757 round 2 — shapes: ${only.join(", ")} · n=${n} · ${jobs.length} calls\n`);

const results = await pool(jobs, concurrency, (j) => runOne(j.name, j.shape, j.i));

const bySh = {};
for (const r of results) (bySh[r.shape] ||= []).push(r);

const summary = [];
console.log("shape\tn\tclean\tbad\terr\tclean_rate\tmean_items\tmean_ms\tmean_$");
for (const name of only) {
  const rows = bySh[name] || [];
  const good = rows.filter((r) => r.ok);
  const errs = rows.filter((r) => !r.ok);
  const clean = good.filter((r) => r.head_ok);
  const meanItems = good.length ? good.reduce((a, r) => a + (r.items || 0), 0) / good.length : 0;
  const meanMs = good.length ? Math.round(good.reduce((a, r) => a + r.duration_ms, 0) / good.length) : 0;
  const meanCost = good.length ? good.reduce((a, r) => a + r.cost.cost_with_thinking, 0) / good.length : 0;
  const row = {
    shape: name,
    why: SHAPES[name].why,
    n: rows.length,
    api_errors: errs.length,
    clean: clean.length,
    bad: good.length - clean.length,
    clean_rate: good.length ? +(clean.length / good.length).toFixed(3) : null,
    mean_items: +meanItems.toFixed(2),
    mean_ms: meanMs,
    mean_cost_usd: +meanCost.toFixed(4),
  };
  summary.push(row);
  console.log([row.shape, row.n, row.clean, row.bad, row.api_errors, row.clean_rate, row.mean_items, row.mean_ms, row.mean_cost_usd].join("\t"));
}

console.log("\n# failures:");
for (const r of results) {
  if (r.ok && !r.head_ok) {
    const pad = r.pad_chars_present != null ? `pad=${r.pad_chars_present}/${r.pad_chars_sent}` : "";
    const shown = r.around_bracket || r.head_120 || "";
    console.log(`  ${r.shape}#${r.i}\tfinish=${r.finishReason}\tparts=${r.parts_len}\titems=${r.items}\tno_call=${r.no_call || false}\t${pad}\t${JSON.stringify(shown.slice(0, 110))}`);
  }
}
console.log("\n# api errors:");
for (const r of results) if (!r.ok) console.log(`  ${r.shape}#${r.i}\t${r.error}`);

const outDir = join(import.meta.dirname, "out");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `shape-round2__${stamp}.json`);
writeFileSync(
  outFile,
  JSON.stringify(
    { ticket: "CRMA-757", ran_at: new Date().toISOString(), model: MODEL, prompt: { case_id: FROZEN.case_id, frozen_at: FROZEN.captured_at }, n_per_shape: n, summary, results },
    null,
    2,
  ),
);
console.log(`\n#ARTIFACT\t${outFile}`);
