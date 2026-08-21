// CRMA-730 — does the grounded head-truncation fire on the VERTICALS, and
// what does production's own parser do when it does?
//
// CRMA-757 measured the truncation on `discovery.gemini.search`'s prompt and
// concluded it fires on ~41% of grounded calls. The verticals were ruled to
// STAY on that number, but nobody fired it at a vertical. That was the one
// inference in the finding. This probe removes it.
//
// The second half matters more than the first. The two lanes parse the answer
// differently, so the SAME truncation costs them different amounts:
//
//   discovery.gemini.search  walks a JSON array tolerantly -> loses ONE item
//   the four verticals       `textContent.match(/\[[\s\S]*\]/)` -> needs the
//                            array opener, the exact byte the cut removes
//
// So this probe replays production's call shape AND production's parser
// verbatim (`fetch_source/entry.js`: parts[0].text, the bracket regex, the
// four-required-field filter) and records what the deployed step would have
// stored. `head_ok` is the model's behaviour; `prod_signals` is the lane's.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { callGemini, costBothWays } from "../lib/gemini.mjs";
import { geminiKey } from "../lib/secrets.mjs";

// The four verticals differ only in CATEGORY and the noun list. Held
// verbatim from ingestion/LLM/gemini-wellness-*/fetch_source/entry.js so the
// probe is judged on production's prompt, not a paraphrase of it.
const VERTICALS = {
  wellness: "emerging wellness, health, fitness, and personal care consumer trends",
  "food-drink": "emerging food and drink consumer trends",
  travel: "emerging travel and hospitality consumer trends",
  other: "emerging consumer trends across retail, home, beauty, and lifestyle",
};

function buildPrompt(topic) {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. Search the web for 10-15 ${topic} in the United States reported THIS WEEK.

Return ONLY a JSON array matching this exact format — no other text:
[{"title": "Short Trend Name", "description": "1-2 sentence summary.", "source_url": "https://example.com/article", "source_name": "Publication Name"}]

Every object MUST have all 4 fields. Do not omit source_url.`;
}

/**
 * The deployed step's parse, copied from fetch_source/entry.js:96-108 and
 * :113-131. Reproduced rather than imported: entry.js is a Pipedream
 * component with a `defineComponent` wrapper and an app prop, so it cannot
 * be loaded here. Any drift makes this probe wrong, so it stays annotated.
 */
function productionParse(rawResponse) {
  const candidate = rawResponse.candidates?.[0];
  // entry.js:87 reads parts[0] only — CRMA-731 defect 6. Kept, because the
  // question is what production stores, not what a fixed parser would.
  const textContent = candidate?.content?.parts?.[0]?.text || "";

  let trends;
  try {
    const jsonMatch = textContent.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { ok: false, reason: "No JSON array found in response", signals: 0 };
    trends = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(trends)) return { ok: false, reason: "Parsed value is not an array", signals: 0 };
  } catch (e) {
    return { ok: false, reason: `JSON parse failed: ${e.message}`, signals: 0 };
  }

  // entry.js:118-127 — a trend missing any of the four fields is skipped.
  let kept = 0;
  for (const t of trends) {
    const title = (t?.title || "").trim();
    const description = (t?.description || "").trim();
    const url = (t?.source_url || "").trim();
    const sourceName = (t?.source_name || "").trim();
    if (!title || !description || !url || !sourceName) continue;
    if (!url.startsWith("http")) continue;
    kept += 1;
  }
  return { ok: true, reason: null, signals: kept, emitted: trends.length };
}

const answerText = (parts) =>
  (parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");

function stripFence(text) {
  let t = String(text || "").trim();
  const open = t.match(/^```(?:json)?\s*\n?/i);
  if (open) t = t.slice(open[0].length);
  return t.replace(/\n?```\s*$/, "").trim();
}

function groundingFacts(raw) {
  const cand = (raw.candidates || [])[0] || {};
  const gm = cand.groundingMetadata || {};
  const queries = gm.webSearchQueries || [];
  return {
    grounded: queries.length > 0,
    search_queries: queries.length,
    grounding_chunks: (gm.groundingChunks || []).length,
  };
}

const apiKey = geminiKey();
const MODEL = process.env.MODEL || "gemini-3.7-flash";

async function runOne({ i, vertical }) {
  try {
    const r = await callGemini({
      apiKey,
      model: MODEL,
      contents: [{ parts: [{ text: buildPrompt(VERTICALS[vertical]) }] }],
      tools: [{ google_search: {} }],
      // production's exact generationConfig: temperature 0.3 and nothing else.
      temperature: 0.3,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
    });

    const body = stripFence(answerText(r.parts));
    const prod = productionParse(r.raw);

    return {
      i,
      vertical,
      ok: true,
      head_ok: body.startsWith("["),
      prod_parse_ok: prod.ok,
      prod_fail_reason: prod.reason,
      prod_signals: prod.signals,
      prod_emitted: prod.emitted ?? null,
      parts: (r.parts || []).length,
      ...groundingFacts(r.raw),
      finishReason: r.finishReason,
      cost: costBothWays(r.usage, MODEL).cost_with_thinking,
      head_80: body.slice(0, 80),
    };
  } catch (e) {
    return { i, vertical, ok: false, error: e.message.slice(0, 200) };
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
const names = Object.keys(VERTICALS);
const jobs = Array.from({ length: n }, (_, i) => ({ i, vertical: names[i % names.length] }));

console.log(`# CRMA-730 verticals: grounding x truncation x production parse`);
console.log(`# model=${MODEL} n=${n} verticals=${names.join(",")}\n`);

const results = await pool(jobs, concurrency, runOne);
const good = results.filter((r) => r.ok);
const grounded = good.filter((r) => r.grounded);
const ungrounded = good.filter((r) => !r.grounded);

const row = (label, rows) => {
  const whole = rows.filter((r) => r.head_ok).length;
  const cut = rows.length - whole;
  const rate = rows.length ? ((cut / rows.length) * 100).toFixed(1) + "%" : "-";
  console.log(
    `${label.padEnd(16)} ${String(whole).padEnd(8)} ${String(cut).padEnd(11)} ${String(rows.length).padEnd(7)} ${rate}`,
  );
};
console.log("                 whole    truncated   total   truncation_rate");
row("GROUNDED", grounded);
row("not grounded", ungrounded);
row("ALL", good);

const zeroRuns = good.filter((r) => !r.prod_parse_ok);
console.log(`\n# grounding rate: ${grounded.length}/${good.length} (${((grounded.length / good.length) * 100).toFixed(1)}%)`);
console.log(`# production parse FAILED (lane stores 0 signals): ${zeroRuns.length}/${good.length} (${((zeroRuns.length / good.length) * 100).toFixed(1)}%)`);
console.log(`# ...of grounded runs: ${grounded.filter((r) => !r.prod_parse_ok).length}/${grounded.length}`);
console.log(`# ...of truncated runs: ${good.filter((r) => !r.head_ok && !r.prod_parse_ok).length}/${good.filter((r) => !r.head_ok).length}`);
const okRuns = good.filter((r) => r.prod_parse_ok);
console.log(`# mean signals kept when parse succeeds: ${okRuns.length ? (okRuns.reduce((a, r) => a + r.prod_signals, 0) / okRuns.length).toFixed(1) : "-"}`);
console.log(`# TOTAL signals across all ${good.length} runs: ${good.reduce((a, r) => a + r.prod_signals, 0)}`);

console.log(`\n# per-vertical`);
for (const v of names) {
  const rows = good.filter((r) => r.vertical === v);
  if (!rows.length) continue;
  const cut = rows.filter((r) => !r.head_ok).length;
  const dead = rows.filter((r) => !r.prod_parse_ok).length;
  console.log(
    `  ${v.padEnd(12)} n=${String(rows.length).padEnd(3)} grounded=${rows.filter((r) => r.grounded).length} truncated=${cut} parse_failed=${dead} signals=${rows.reduce((a, r) => a + r.prod_signals, 0)}`,
  );
}

if (zeroRuns.length) {
  console.log(`\n# what a failed run looks like (first 3)`);
  for (const r of zeroRuns.slice(0, 3)) {
    console.log(`  [${r.vertical}] grounded=${r.grounded} finish=${r.finishReason} ${r.prod_fail_reason}`);
    console.log(`      head: ${JSON.stringify(r.head_80)}`);
  }
}

const outDir = join(import.meta.dirname, "out");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `verticals_truncation__${MODEL}__${stamp}.json`);
writeFileSync(
  outFile,
  JSON.stringify(
    {
      ticket: "CRMA-730",
      ran_at: new Date().toISOString(),
      model: MODEL,
      n,
      crosstab: {
        grounded_whole: grounded.filter((r) => r.head_ok).length,
        grounded_truncated: grounded.filter((r) => !r.head_ok).length,
        ungrounded_whole: ungrounded.filter((r) => r.head_ok).length,
        ungrounded_truncated: ungrounded.filter((r) => !r.head_ok).length,
      },
      production_parse_failures: zeroRuns.length,
      total_signals: good.reduce((a, r) => a + r.prod_signals, 0),
      results,
    },
    null,
    2,
  ),
);
console.log(`\n#ARTIFACT\t${outFile}`);
