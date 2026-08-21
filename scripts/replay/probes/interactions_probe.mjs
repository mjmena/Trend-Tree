// CRMA-757 option 3 — the Interactions API.
//
// The crosstab established the defect precisely: on gemini-3.7-flash,
// truncation happens ONLY on runs where google_search actually fired
// (14 of 14 truncations grounded, 0 of 9 ungrounded), at 45% of grounded
// calls. That places the fault in GROUNDED-ANSWER ASSEMBLY on the legacy
// generateContent surface.
//
// The Interactions API assembles a grounded answer completely differently.
// Per CRMA-756: typed steps[] rather than one flattened text blob, and
// citations as inline url_citation annotations rather than byte offsets into
// a joined string. If the fault is in the legacy flattening, this surface
// should not show it.
//
// Run with EXPLORE=1 to dump one raw response and learn the real field
// names before trusting any parser written against the docs.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { geminiKey } from "../lib/secrets.mjs";

const FROZEN = JSON.parse(
  readFileSync(join(import.meta.dirname, process.env.PROMPT_FILE || "frozen_prompt.json"), "utf8"),
);
const PROMPT_TEXT = FROZEN.contents[0].parts[0].text;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = process.env.MODEL || "gemini-3.7-flash";
const apiKey = geminiKey();

async function interact(body, timeoutMs = 180_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let resp;
  try {
    resp = await fetch(`${ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (!resp.ok) {
    const e = new Error(`Interactions HTTP ${resp.status}: ${text.slice(0, 600)}`);
    e.status = resp.status;
    throw e;
  }
  return { data: JSON.parse(text), duration_ms: Date.now() - started };
}

// Interactions declares tools by a `type` discriminator, NOT by the legacy
// surface's `{google_search: {}}` nesting. Learned from a 400 that names the
// missing field; no CRMA-756 doc page spelled the tool shape out.
const REQUEST = {
  model: MODEL,
  input: PROMPT_TEXT,
  tools: [{ type: "google_search" }],
  store: false,
};

// ---------------------------------------------------------------------------
// Explore mode — learn the shape rather than assume it
// ---------------------------------------------------------------------------
if (process.env.EXPLORE) {
  const { data, duration_ms } = await interact(REQUEST);
  console.log(`# ${duration_ms}ms`);
  console.log(`# top-level keys: ${Object.keys(data).join(", ")}`);
  const steps = data.steps || [];
  console.log(`# steps: ${steps.length}`);
  for (const [i, s] of steps.entries()) {
    const keys = Object.keys(s).join(",");
    console.log(`  [${i}] type=${s.type || "?"}\tkeys=${keys}`);
  }
  const dump = join(import.meta.dirname, "out", `interactions-explore-${Date.now()}.json`);
  mkdirSync(join(import.meta.dirname, "out"), { recursive: true });
  writeFileSync(dump, JSON.stringify(data, null, 2));
  console.log(`\n#RAW\t${dump}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Measurement mode
// ---------------------------------------------------------------------------

/**
 * Walk steps and collect model text. CRMA-756's trap: output_text drops text
 * blocks separated by non-text content, and a grounded run ALWAYS has tool
 * steps in the middle — so the text is assembled by walking steps here, never
 * by reading output_text.
 */
function assemble(data) {
  const steps = data.steps || [];
  const texts = [];
  const citations = [];
  let searchCalls = 0;
  for (const s of steps) {
    const type = s.type || "";
    if (type.includes("search_call")) searchCalls++;
    const content = s.content || s.text || s.output || null;
    if (typeof content === "string" && type.includes("model_output")) texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (typeof b === "string") texts.push(b);
        else if (b?.text) {
          texts.push(b.text);
          for (const a of b.annotations || []) {
            if (a.url) citations.push({ url: a.url, title: a.title });
          }
        }
      }
    }
    for (const a of s.annotations || []) if (a.url) citations.push({ url: a.url, title: a.title });
  }
  return { text: texts.join(""), citations, searchCalls, stepCount: steps.length };
}

function stripFence(t) {
  let s = String(t || "").trim();
  const open = s.match(/^```(?:json)?\s*\n?/i);
  if (open) s = s.slice(open[0].length);
  return s.replace(/\n?```\s*$/, "").trim();
}

async function runOne(i) {
  try {
    const { data, duration_ms } = await interact(REQUEST);
    const { text, citations, searchCalls, stepCount } = assemble(data);
    const body = stripFence(text);
    let items = null;
    try {
      const v = JSON.parse(body);
      if (Array.isArray(v)) items = v.length;
    } catch {
      /* truncated */
    }
    const publisherUrls = citations.filter((c) => !/vertexaisearch\.cloud\.google\.com/.test(c.url));
    return {
      i,
      ok: true,
      head_ok: body.startsWith("["),
      items,
      grounded: searchCalls > 0,
      search_calls: searchCalls,
      steps: stepCount,
      citations: citations.length,
      publisher_urls: publisherUrls.length,
      redirect_urls: citations.length - publisherUrls.length,
      sample_url: citations[0]?.url || null,
      duration_ms,
      head_80: body.slice(0, 80),
      usage: data.usage || data.usageMetadata || null,
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

const n = Number(process.env.N || 25);
const concurrency = Number(process.env.CONCURRENCY || 5);

console.log(`# CRMA-757 Interactions API · model=${MODEL} · shard=${FROZEN.case_id} · n=${n}\n`);
const results = await pool([...Array(n).keys()], concurrency, runOne);
const good = results.filter((r) => r.ok);
const grounded = good.filter((r) => r.grounded);

const row = (label, rows) => {
  const whole = rows.filter((r) => r.head_ok).length;
  const cut = rows.length - whole;
  console.log(
    `${label.padEnd(16)} ${String(whole).padEnd(8)} ${String(cut).padEnd(11)} ${String(rows.length).padEnd(7)} ${rows.length ? ((cut / rows.length) * 100).toFixed(1) + "%" : "-"}`,
  );
};
console.log("                 whole    truncated   total   truncation_rate");
row("GROUNDED", grounded);
row("not grounded", good.filter((r) => !r.grounded));
row("ALL", good);

const pub = good.reduce((a, r) => a + r.publisher_urls, 0);
const red = good.reduce((a, r) => a + r.redirect_urls, 0);
console.log(`\n# api errors: ${results.length - good.length}`);
console.log(`# grounding rate: ${grounded.length}/${good.length}`);
console.log(`# citations: ${pub} publisher URLs, ${red} vertexaisearch redirects`);
console.log(`# mean items: ${good.length ? (good.reduce((a, r) => a + (r.items || 0), 0) / good.length).toFixed(1) : "-"}`);
console.log(`# mean ms: ${good.length ? Math.round(good.reduce((a, r) => a + r.duration_ms, 0) / good.length) : "-"}`);
console.log(`# sample citation: ${good.find((r) => r.sample_url)?.sample_url || "(none)"}`);

for (const r of results) if (!r.ok) console.log(`  ERR #${r.i}\t${r.error}`);
for (const r of good) if (!r.head_ok) console.log(`  CUT #${r.i}\tsteps=${r.steps}\t${JSON.stringify(r.head_80)}`);

const outDir = join(import.meta.dirname, "out");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `interactions__${MODEL}__${FROZEN.case_id}__${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(outFile, JSON.stringify({ ticket: "CRMA-757", model: MODEL, shard: FROZEN.case_id, n, results }, null, 2));
console.log(`\n#ARTIFACT\t${outFile}`);
