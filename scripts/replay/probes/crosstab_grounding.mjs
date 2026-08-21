// CRMA-757 — does the truncation happen ONLY when grounding actually fires?
//
// Two observations from the grounding check force this question:
//   1. The tool-channel shape returns whole answers because it STOPS
//      SEARCHING — 0 of 6 runs issued a single query. It is not a fix.
//   2. Production's own shape only issued search queries on 3 of 6 runs.
//
// If truncation lands only on the grounded subset, then the ~27% headline
// rate is the product of two numbers — how often the model searches, and how
// often a grounded answer arrives whole — and the lane's real exposure is
// much worse than 27% on the runs that matter. It also names the mechanism:
// something in grounded-answer assembly, not the model's decoding.
//
// One arm, production's exact shape, with grounding and truncation recorded
// per call and crossed against each other.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { callGemini, costBothWays } from "../lib/gemini.mjs";
import { geminiKey } from "../lib/secrets.mjs";

const FROZEN = JSON.parse(
  readFileSync(join(import.meta.dirname, process.env.PROMPT_FILE || "frozen_prompt.json"), "utf8"),
);
const PROMPT_TEXT = FROZEN.contents[0].parts[0].text;

function stripFence(text) {
  let t = String(text || "").trim();
  const open = t.match(/^```(?:json)?\s*\n?/i);
  if (open) t = t.slice(open[0].length);
  return t.replace(/\n?```\s*$/, "").trim();
}

const answerText = (parts) =>
  (parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");

function groundingFacts(raw) {
  const cand = (raw.candidates || [])[0] || {};
  const gm = cand.groundingMetadata || {};
  const queries = gm.webSearchQueries || [];
  return {
    grounded: queries.length > 0,
    search_queries: queries.length,
    grounding_chunks: (gm.groundingChunks || []).length,
    grounding_supports: (gm.groundingSupports || []).length,
  };
}

const apiKey = geminiKey();
const MODEL = process.env.MODEL || "gemini-3.7-flash";

async function runOne(i) {
  try {
    const r = await callGemini({
      apiKey,
      model: MODEL,
      contents: [{ parts: [{ text: PROMPT_TEXT }] }],
      tools: [{ google_search: {} }],
      temperature: 0.5,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
    });
    const body = stripFence(answerText(r.parts));
    let items = null;
    try {
      const v = JSON.parse(body);
      if (Array.isArray(v)) items = v.length;
    } catch {
      /* truncated */
    }
    return {
      i,
      ok: true,
      head_ok: body.startsWith("["),
      items,
      ...groundingFacts(r.raw),
      finishReason: r.finishReason,
      cost: costBothWays(r.usage, MODEL).cost_with_thinking,
      head_80: body.slice(0, 80),
    };
  } catch (e) {
    return { i, ok: false, error: e.message.slice(0, 200) };
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const n = Number(process.env.N || 40);
const concurrency = Number(process.env.CONCURRENCY || 6);

console.log(`# CRMA-757 grounding x truncation crosstab`);
console.log(`# model=${MODEL} shard=${FROZEN.case_id} n=${n}\n`);

const results = await pool([...Array(n).keys()], concurrency, runOne);
const good = results.filter((r) => r.ok);

const cell = (g, h) => good.filter((r) => r.grounded === g && r.head_ok === h).length;

const groundedRuns = good.filter((r) => r.grounded);
const ungroundedRuns = good.filter((r) => !r.grounded);

console.log("                 whole    truncated   total   truncation_rate");
const row = (label, rows) => {
  const whole = rows.filter((r) => r.head_ok).length;
  const cut = rows.length - whole;
  const rate = rows.length ? ((cut / rows.length) * 100).toFixed(1) + "%" : "-";
  console.log(`${label.padEnd(16)} ${String(whole).padEnd(8)} ${String(cut).padEnd(11)} ${String(rows.length).padEnd(7)} ${rate}`);
};
row("GROUNDED", groundedRuns);
row("not grounded", ungroundedRuns);
row("ALL", good);

console.log(`\n# grounding rate: ${groundedRuns.length}/${good.length} (${((groundedRuns.length / good.length) * 100).toFixed(1)}%)`);
console.log(`# mean queries when grounded: ${groundedRuns.length ? (groundedRuns.reduce((a, r) => a + r.search_queries, 0) / groundedRuns.length).toFixed(1) : 0}`);
console.log(`# mean items, whole+grounded: ${(() => { const s = groundedRuns.filter((r) => r.head_ok); return s.length ? (s.reduce((a, r) => a + (r.items || 0), 0) / s.length).toFixed(1) : "-"; })()}`);
console.log(`# mean items, whole+ungrounded: ${(() => { const s = ungroundedRuns.filter((r) => r.head_ok); return s.length ? (s.reduce((a, r) => a + (r.items || 0), 0) / s.length).toFixed(1) : "-"; })()}`);

const outDir = join(import.meta.dirname, "out");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `crosstab__${MODEL}__${FROZEN.case_id}__${stamp}.json`);
writeFileSync(
  outFile,
  JSON.stringify(
    {
      ticket: "CRMA-757",
      ran_at: new Date().toISOString(),
      model: MODEL,
      shard: FROZEN.case_id,
      n,
      crosstab: {
        grounded_whole: cell(true, true),
        grounded_truncated: cell(true, false),
        ungrounded_whole: cell(false, true),
        ungrounded_truncated: cell(false, false),
      },
      results,
    },
    null,
    2,
  ),
);
console.log(`\n#ARTIFACT\t${outFile}`);
