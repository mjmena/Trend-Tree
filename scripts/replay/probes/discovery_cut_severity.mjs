// CRMA-731 — what does a head-truncated grounded answer cost THIS lane?
//
// The map records the discovery lane as losing "one proposal" to the cut
// where the verticals lose the whole run. That contrast rests on the two
// lanes parsing differently. They do not differ in the way that matters:
// `extractJsonArray` starts at `text.indexOf("[")`, and the cut removes the
// array opener, so the lane needs the same byte the verticals need.
//
// This fires production's exact call shape and runs the DEPLOYED parser and
// the DEPLOYED proposal filter over every response, so the number reported
// is proposals production would have stored — not proposals the model emitted.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { callGemini } from "../lib/gemini.mjs";
import { geminiKey } from "../lib/secrets.mjs";
import { loadStep } from "../lib/entry_module.mjs";

const GEMINI_STEP = "discovery-p_5VCPP3N/discover_gemini/entry.js";
const { extractJsonArray } = await loadStep(GEMINI_STEP, ["extractJsonArray"]);

const FROZEN = JSON.parse(
  readFileSync(join(import.meta.dirname, process.env.PROMPT_FILE || "frozen_prompt.json"), "utf8"),
);
const PROMPT_TEXT = FROZEN.contents[0].parts[0].text;

const answerText = (parts) =>
  (parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");

function stripFence(text) {
  let t = String(text || "").trim();
  const open = t.match(/^```(?:json)?\s*\n?/i);
  if (open) t = t.slice(open[0].length);
  return t.replace(/\n?```\s*$/, "").trim();
}

// discover_gemini/entry.js:116-123, verbatim in effect.
function productionParse(text, vertical) {
  const arrText = extractJsonArray(text);
  if (!arrText) return { threw: true, reason: "no_json_array", proposals: 0 };
  let parsed;
  try {
    parsed = JSON.parse(arrText);
  } catch (e) {
    return { threw: true, reason: "json_parse_failed", proposals: 0 };
  }
  if (!Array.isArray(parsed)) return { threw: true, reason: "not_an_array", proposals: 0 };
  const proposals = parsed.filter((p) => p && typeof p === "object" && p.topic);
  return { threw: false, reason: null, proposals: proposals.length, parsed_items: parsed.length };
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
    const gm = (r.raw.candidates || [])[0]?.groundingMetadata || {};
    const grounded = (gm.webSearchQueries || []).length > 0;
    const head_ok = body.startsWith("[");
    const parse = productionParse(body, FROZEN.case_id);
    return {
      i,
      ok: true,
      grounded,
      head_ok,
      has_bracket_anywhere: body.includes("["),
      ...parse,
      finishReason: r.finishReason,
      head_60: body.slice(0, 60),
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

const n = Number(process.env.N || 20);
const results = await pool([...Array(n).keys()], Number(process.env.CONCURRENCY || 5), runOne);
const good = results.filter((r) => r.ok);

const cut = good.filter((r) => !r.head_ok);
const whole = good.filter((r) => r.head_ok);

console.log(`# CRMA-731 cut severity — model=${MODEL} shard=${FROZEN.case_id} n=${n}\n`);
const row = (label, rows) => {
  if (!rows.length) return console.log(`${label.padEnd(22)} (none)`);
  const lost = rows.filter((r) => r.threw).length;
  const props = rows.reduce((a, r) => a + r.proposals, 0);
  console.log(
    `${label.padEnd(22)} runs=${String(rows.length).padEnd(4)} shard_lost=${String(lost).padEnd(4)} ` +
      `stored_proposals=${String(props).padEnd(5)} mean=${(props / rows.length).toFixed(2)}`,
  );
};
row("head WHOLE", whole);
row("head TRUNCATED", cut);
console.log(`\n# truncated runs containing a '[' anywhere: ${cut.filter((r) => r.has_bracket_anywhere).length}/${cut.length}`);
console.log(`# grounded: ${good.filter((r) => r.grounded).length}/${good.length}`);

const outDir = join(import.meta.dirname, "out");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `cut-severity__${MODEL}__${FROZEN.case_id}__${stamp}.json`);
writeFileSync(outFile, JSON.stringify({ ticket: "CRMA-731", ran_at: new Date().toISOString(), model: MODEL, shard: FROZEN.case_id, n, results }, null, 2));
console.log(`\n#ARTIFACT\t${outFile}`);
