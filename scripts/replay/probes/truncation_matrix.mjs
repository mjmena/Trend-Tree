// CRMA-757 — does any call shape make a GROUNDED gemini-3.7-flash call
// return a complete answer?
//
// The measured failure (CRMA-731): with `tools: [{google_search:{}}]` and
// `temperature` only, the model emits its fence and then begins mid-object.
// The array opener and the first item are gone. finishReason is STOP and
// the token accounting is exact, so nothing is lost in transit and it is
// not a client-extraction bug.
//
// WHAT THIS PROBE HOLDS CONSTANT, and why each one matters:
//   - The prompt. Rendered ONCE by freeze_prompt.mjs and read from disk, so
//     a shape difference can never be a prompt difference.
//   - The lane. discovery.gemini.search, production's exact body.
//   - The detector. One function, applied identically to every arm.
// What varies is ONLY the call shape named in SHAPES.
//
// The 2.5 Flash arm is a NEGATIVE CONTROL, not a candidate. CRMA-731
// measured zero truncations on that model. If the detector fires there, the
// detector is wrong and every other number in this run is void.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { callGemini, costBothWays } from "../lib/gemini.mjs";
import { geminiKey } from "../lib/secrets.mjs";

const FROZEN = JSON.parse(
  readFileSync(join(import.meta.dirname, process.env.PROMPT_FILE || "frozen_prompt.json"), "utf8"),
);
const PROMPT_TEXT = FROZEN.contents[0].parts[0].text;
const SEARCH_TOOL = [{ google_search: {} }];

/** The output contract, lifted from the tail of the registry prompt. */
const ARRAY_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      topic: { type: "STRING" },
      evidence_url: { type: "STRING" },
      why_now: { type: "STRING" },
      vertical: { type: "STRING" },
    },
    required: ["topic", "evidence_url", "why_now", "vertical"],
  },
};

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Strip a markdown fence if one is present, without touching anything else.
 * Production's extractJsonArray scans for the array; this deliberately does
 * NOT, because the whole question is whether the array OPENER survived.
 */
function stripFence(text) {
  let t = String(text || "").trim();
  const open = t.match(/^```(?:json)?\s*\n?/i);
  if (open) t = t.slice(open[0].length);
  t = t.replace(/\n?```\s*$/, "");
  return t.trim();
}

/**
 * Classify one answer.
 *
 * head_ok is the finding. Everything else is context for judging the
 * mitigation option (a tolerant parser): `recovered_items` says how much of
 * the payload a lenient scan gets back when the head is gone.
 */
function classify(text) {
  const raw = String(text || "");
  const body = stripFence(raw);
  const head_ok = body.startsWith("[");

  let parses_direct = false;
  let direct_items = null;
  try {
    const v = JSON.parse(body);
    if (Array.isArray(v)) {
      parses_direct = true;
      direct_items = v.length;
    }
  } catch {
    /* not parseable as-is — expected on a truncated head */
  }

  // Lenient recovery: find the first '{' and wrap. This is option 4 from the
  // ticket, measured rather than assumed. It cannot recover the FIRST item
  // when the head is gone, only the remainder.
  let recovered_items = null;
  if (!parses_direct) {
    const firstBrace = body.indexOf("{");
    const lastBrace = body.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const v = JSON.parse(`[${body.slice(firstBrace, lastBrace + 1)}]`);
        if (Array.isArray(v)) recovered_items = v.length;
      } catch {
        /* even lenient recovery failed */
      }
    }
  }

  return {
    head_ok,
    parses_direct,
    direct_items,
    recovered_items,
    empty: body.length === 0,
    head_120: body.slice(0, 120),
    body_chars: body.length,
  };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const PROD = {
  system: null,
  contents: [{ parts: [{ text: PROMPT_TEXT }] }],
  tools: SEARCH_TOOL,
  temperature: 0.5,
  thinkingLevel: null,
  maxOutputTokens: null,
  functionCallingMode: null,
};

export const SHAPES = {
  // The control arm. Production's exact body on the candidate model.
  A_prod: {
    model: "gemini-3.7-flash",
    why: "production's exact call shape — the baseline the ~1-in-5 rate was measured on",
    args: { ...PROD },
  },
  // thinking_level was never varied in CRMA-731's A/B; failures correlated
  // with high thinking-token counts, so both directions are worth a look.
  B_low: {
    model: "gemini-3.7-flash",
    why: "thinking_level low — failures correlated with high thinking-token counts",
    args: { ...PROD, thinkingLevel: "low" },
  },
  C_high: {
    model: "gemini-3.7-flash",
    why: "thinking_level high — tests the correlation in the opposite direction",
    args: { ...PROD, thinkingLevel: "high" },
  },
  // temperature was deprecated 2026-07-21 and every lane still sends it.
  D_notemp: {
    model: "gemini-3.7-flash",
    why: "temperature omitted — it is deprecated, and production still sends it",
    args: { ...PROD, temperature: null },
  },
  // CRMA-756: structured output WITH grounding is Preview and names 3.7
  // explicitly. discover_gemini/entry.js:7-9 asserts it is impossible; that
  // assertion was written against an older model and needs re-testing.
  E_schema: {
    model: "gemini-3.7-flash",
    why: "responseSchema + grounding (Preview on 3.7) — removes the fence entirely",
    args: { ...PROD, responseSchema: ARRAY_SCHEMA },
  },
  // Negative control. Zero truncations measured here (CRMA-731). If this arm
  // fires, the detector is wrong.
  Z_control_25: {
    model: "gemini-2.5-flash",
    why: "NEGATIVE CONTROL — CRMA-731 measured 0 truncations on this model",
    args: { ...PROD },
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const apiKey = geminiKey();

/** Retry transport failures WITHOUT counting them as samples. */
async function callWithRetry(args, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callGemini({ apiKey, ...args });
    } catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || e.status >= 500 || !e.status;
      if (!retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Text of the answer: every non-thought text part, joined. */
function answerText(parts) {
  return (parts || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
}

async function runOne(shapeName, shape, i) {
  const started = Date.now();
  try {
    const r = await callWithRetry({ model: shape.model, ...shape.args });
    const text = answerText(r.parts);
    const cls = classify(text);
    return {
      shape: shapeName,
      i,
      ok: true,
      model: shape.model,
      finishReason: r.finishReason,
      parts_len: r.parts.length,
      duration_ms: r.duration_ms,
      cost: costBothWays(r.usage, shape.model),
      ...cls,
    };
  } catch (e) {
    return {
      shape: shapeName,
      i,
      ok: false,
      model: shape.model,
      error: e.message.slice(0, 300),
      duration_ms: Date.now() - started,
    };
  }
}

/** Bounded-concurrency map — the API rate-limits well below unbounded. */
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

const n = Number(process.env.N || 12);
const only = process.argv[2] ? process.argv[2].split(",") : Object.keys(SHAPES);
const concurrency = Number(process.env.CONCURRENCY || 4);

const jobs = [];
for (const name of only) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`Unknown shape '${name}'. Known: ${Object.keys(SHAPES).join(", ")}`);
  for (let i = 0; i < n; i++) jobs.push({ name, shape, i });
}

console.log(`# CRMA-757 truncation matrix`);
console.log(`# prompt: ${FROZEN.case_id}, ${PROMPT_TEXT.length} chars, frozen ${FROZEN.captured_at}`);
console.log(`# shapes: ${only.join(", ")} · n=${n} each · ${jobs.length} calls\n`);

const results = await pool(jobs, concurrency, (j) => runOne(j.name, j.shape, j.i));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const bySh = {};
for (const r of results) (bySh[r.shape] ||= []).push(r);

const summary = [];
for (const name of only) {
  const rows = bySh[name] || [];
  const good = rows.filter((r) => r.ok);
  const errs = rows.filter((r) => !r.ok);
  const clean = good.filter((r) => r.head_ok);
  const trunc = good.filter((r) => !r.head_ok && !r.empty);
  const empty = good.filter((r) => r.empty);
  const meanMs = good.length ? Math.round(good.reduce((a, r) => a + r.duration_ms, 0) / good.length) : 0;
  const meanCost = good.length
    ? good.reduce((a, r) => a + r.cost.cost_with_thinking, 0) / good.length
    : 0;
  const meanThoughts = good.length
    ? Math.round(good.reduce((a, r) => a + r.cost.thoughts_tokens, 0) / good.length)
    : 0;
  summary.push({
    shape: name,
    model: SHAPES[name].model,
    why: SHAPES[name].why,
    n: rows.length,
    api_errors: errs.length,
    clean: clean.length,
    truncated: trunc.length,
    empty: empty.length,
    clean_rate: good.length ? +(clean.length / good.length).toFixed(3) : null,
    mean_ms: meanMs,
    mean_cost_usd: +meanCost.toFixed(4),
    mean_thought_tokens: meanThoughts,
  });
}

console.log("shape\tmodel\tn\tclean\ttrunc\tempty\terr\tclean_rate\tmean_ms\tmean_$\tthoughts");
for (const s of summary) {
  console.log(
    [
      s.shape, s.model, s.n, s.clean, s.truncated, s.empty, s.api_errors,
      s.clean_rate, s.mean_ms, s.mean_cost_usd, s.mean_thought_tokens,
    ].join("\t"),
  );
}

console.log("\n# truncated heads (first 120 chars):");
for (const r of results) {
  if (r.ok && !r.head_ok) {
    console.log(`  ${r.shape}#${r.i}\tfinish=${r.finishReason}\tparts=${r.parts_len}\trecovered=${r.recovered_items}\t${JSON.stringify(r.head_120.slice(0, 100))}`);
  }
}
console.log("\n# api errors:");
for (const r of results) if (!r.ok) console.log(`  ${r.shape}#${r.i}\t${r.error}`);

const outDir = join(import.meta.dirname, "out");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `truncation-matrix__${stamp}.json`);
writeFileSync(
  outFile,
  JSON.stringify(
    {
      ticket: "CRMA-757",
      ran_at: new Date().toISOString(),
      prompt: { case_id: FROZEN.case_id, chars: PROMPT_TEXT.length, frozen_at: FROZEN.captured_at, provenance: FROZEN.promptProvenance },
      n_per_shape: n,
      shapes: Object.fromEntries(only.map((k) => [k, { model: SHAPES[k].model, why: SHAPES[k].why, args: redact(SHAPES[k].args) }])),
      summary,
      results,
    },
    null,
    2,
  ),
);
console.log(`\n#ARTIFACT\t${outFile}`);

/** Keep the artifact shareable: the prompt text lives in frozen_prompt.json. */
function redact(args) {
  const { contents, ...rest } = args;
  return { ...rest, contents: `<frozen prompt, ${PROMPT_TEXT.length} chars>` };
}
