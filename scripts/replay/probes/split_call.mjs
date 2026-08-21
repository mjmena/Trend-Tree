// CRMA-757 option 1 — the two-call split.
//
// A Google staff account suggested it in the forum thread CRMA-756 found:
// ground first, format second. It is a workaround, not a bug fix, and it
// doubles the call count, so it has to earn its cost.
//
// THE SPLIT ONLY HELPS IF THE FIRST CALL STOPS ASKING FOR JSON.
// If call 1 keeps production's "respond in valid JSON" instruction, a
// truncated head still eats the first item and call 2 cannot invent it back
// — that is option 4 (a tolerant parser) wearing a second API call, and the
// matrix probe already measures what a lenient scan recovers. So call 1 here
// asks for PROSE NOTES, where a lost head is a lost sentence rather than a
// lost proposal, and call 2 converts notes to the strict array with no tools
// attached.
//
// Call 2 is ungrounded, and the map's established facts say the ungrounded
// distillation lane shows no truncation at all. That is the mechanism this
// probe is betting on.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { callGemini, costBothWays } from "../lib/gemini.mjs";
import { geminiKey } from "../lib/secrets.mjs";

const FROZEN = JSON.parse(
  readFileSync(join(import.meta.dirname, "frozen_prompt.json"), "utf8"),
);
const PROMPT_TEXT = FROZEN.contents[0].parts[0].text;

// Cut the JSON-output contract off the end of the production prompt and ask
// for notes instead. Everything above it — the vertical, the active-trend
// exclusions, the URL and freshness discipline — is preserved verbatim,
// because those are the lane's job and the map forbids redefining it.
const JSON_BLOCK = /Respond in valid JSON[\s\S]*?\n\]/;
if (!JSON_BLOCK.test(PROMPT_TEXT)) {
  throw new Error(
    "Could not find the JSON output block in the frozen prompt. The registry " +
      "template changed; re-read it before trusting this probe.",
  );
}

const NOTES_INSTRUCTION = `Report your findings as plain prose notes, one numbered entry per proposal.
For each entry write, on its own line: the behavior, the evidence URL you actually
found it at, and one or two sentences on what is driving it right now. Do not write
JSON. Do not wrap the answer in code fences.`;

const CALL1_PROMPT = PROMPT_TEXT.replace(JSON_BLOCK, NOTES_INSTRUCTION);

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

const CALL2_PROMPT = (notes) =>
  `Convert the research notes below into a JSON array. One object per numbered entry.

Copy each evidence URL EXACTLY as it appears in the notes. Do not repair, shorten,
normalise, or invent a URL. If an entry has no URL, drop that entry.

Fields per object: topic (the behavior, <=80 chars), evidence_url, why_now, vertical.
Set vertical to "${FROZEN.case_id}" on every object.

NOTES:
${notes}`;

function stripFence(text) {
  let t = String(text || "").trim();
  const open = t.match(/^```(?:json)?\s*\n?/i);
  if (open) t = t.slice(open[0].length);
  t = t.replace(/\n?```\s*$/, "");
  return t.trim();
}

function classify(text) {
  const body = stripFence(text);
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
    /* expected on a truncated head */
  }
  return { head_ok, parses_direct, direct_items, head_120: body.slice(0, 120), body_chars: body.length };
}

const answerText = (parts) =>
  (parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");

const apiKey = geminiKey();
const MODEL = "gemini-3.7-flash";

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

/** Count how many http(s) URLs survive from call 1's notes into call 2's array. */
function urlFidelity(notesText, arr) {
  const inNotes = new Set((notesText.match(/https?:\/\/[^\s)"'\]]+/g) || []).map((u) => u.replace(/[.,;]+$/, "")));
  const emitted = Array.isArray(arr) ? arr.map((o) => String(o?.evidence_url || "")).filter(Boolean) : [];
  const kept = emitted.filter((u) => inNotes.has(u.replace(/[.,;]+$/, "")));
  return {
    urls_in_notes: inNotes.size,
    urls_emitted: emitted.length,
    urls_traceable_to_notes: kept.length,
    invented: emitted.length - kept.length,
  };
}

async function runOne(i) {
  try {
    // Call 1 — grounded, prose. Production's tools and temperature.
    const r1 = await callWithRetry({
      model: MODEL,
      contents: [{ parts: [{ text: CALL1_PROMPT }] }],
      tools: [{ google_search: {} }],
      temperature: 0.5,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
    });
    const notes = answerText(r1.parts);

    // Call 2 — ungrounded, strict. No tools at all, schema enforced.
    const r2 = await callWithRetry({
      model: MODEL,
      contents: [{ parts: [{ text: CALL2_PROMPT(notes) }] }],
      responseSchema: ARRAY_SCHEMA,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
    });
    const out = answerText(r2.parts);
    const cls = classify(out);

    let parsed = null;
    try {
      parsed = JSON.parse(stripFence(out));
    } catch {
      /* recorded by cls */
    }

    const c1 = costBothWays(r1.usage, MODEL);
    const c2 = costBothWays(r2.usage, MODEL);

    return {
      i,
      ok: true,
      call1: {
        finishReason: r1.finishReason,
        chars: notes.length,
        duration_ms: r1.duration_ms,
        cost: c1.cost_with_thinking,
        thoughts: c1.thoughts_tokens,
        // Prose has no array opener to lose. Recorded so a reader can see
        // whether call 1 truncated at all, not to judge it as a failure.
        head_60: notes.slice(0, 60),
      },
      call2: {
        finishReason: r2.finishReason,
        duration_ms: r2.duration_ms,
        cost: c2.cost_with_thinking,
        thoughts: c2.thoughts_tokens,
        ...cls,
      },
      items: cls.direct_items,
      fidelity: urlFidelity(notes, parsed),
      total_cost: +(c1.cost_with_thinking + c2.cost_with_thinking).toFixed(4),
      total_ms: r1.duration_ms + r2.duration_ms,
    };
  } catch (e) {
    return { i, ok: false, error: e.message.slice(0, 300) };
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

const n = Number(process.env.N || 12);
const concurrency = Number(process.env.CONCURRENCY || 4);

console.log(`# CRMA-757 two-call split (option 1)`);
console.log(`# call 1: grounded prose · call 2: ungrounded + responseSchema`);
console.log(`# prompt: ${FROZEN.case_id} · n=${n}\n`);

const results = await pool([...Array(n).keys()], concurrency, runOne);

const good = results.filter((r) => r.ok);
const clean = good.filter((r) => r.call2.head_ok && r.call2.parses_direct);
const meanCost = good.length ? good.reduce((a, r) => a + r.total_cost, 0) / good.length : 0;
const meanMs = good.length ? Math.round(good.reduce((a, r) => a + r.total_ms, 0) / good.length) : 0;
const meanItems = good.length ? (good.reduce((a, r) => a + (r.items || 0), 0) / good.length).toFixed(1) : 0;
const invented = good.reduce((a, r) => a + (r.fidelity?.invented || 0), 0);
const emitted = good.reduce((a, r) => a + (r.fidelity?.urls_emitted || 0), 0);

console.log("n\tclean\tclean_rate\tmean_items\tmean_ms\tmean_$\turls_emitted\turls_invented");
console.log(
  [n, clean.length, good.length ? (clean.length / good.length).toFixed(3) : "-", meanItems, meanMs, meanCost.toFixed(4), emitted, invented].join("\t"),
);

console.log("\n# per run:");
for (const r of results) {
  if (!r.ok) {
    console.log(`  #${r.i}\tERROR\t${r.error}`);
    continue;
  }
  console.log(
    `  #${r.i}\tc1=${r.call1.finishReason}/${r.call1.chars}ch\tc2=${r.call2.finishReason}\thead_ok=${r.call2.head_ok}\titems=${r.items}\t$${r.total_cost}\t${r.total_ms}ms\tinvented=${r.fidelity.invented}`,
  );
}

const outDir = join(import.meta.dirname, "out");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `split-call__${stamp}.json`);
writeFileSync(
  outFile,
  JSON.stringify(
    {
      ticket: "CRMA-757",
      option: "1 — two-call split (grounded prose, then ungrounded format)",
      ran_at: new Date().toISOString(),
      model: MODEL,
      prompt: { case_id: FROZEN.case_id, frozen_at: FROZEN.captured_at, call1_chars: CALL1_PROMPT.length },
      n,
      summary: {
        clean: clean.length,
        of: good.length,
        mean_cost_usd: +meanCost.toFixed(4),
        mean_ms: meanMs,
        mean_items: +meanItems,
        urls_emitted: emitted,
        urls_invented: invented,
      },
      results,
    },
    null,
    2,
  ),
);
console.log(`\n#ARTIFACT\t${outFile}`);
