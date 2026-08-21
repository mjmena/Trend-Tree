// CRMA-757 validity check — is the tool-channel shape STILL GROUNDED?
//
// G_tool returns a clean answer 45 times out of 45. That number is worthless
// if declaring a function made the model stop calling google_search, because
// then the shape is not "grounded and complete", it is "ungrounded and
// therefore complete" — and the discovery lane's entire job is grounding.
//
// This fires both shapes and compares groundingMetadata directly. A shape
// passes only if it searches AND returns whole.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callGemini } from "../lib/gemini.mjs";
import { geminiKey } from "../lib/secrets.mjs";

const FROZEN = JSON.parse(
  readFileSync(join(import.meta.dirname, process.env.PROMPT_FILE || "frozen_prompt.json"), "utf8"),
);
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

const TOOL_PROMPT = `${PROMPT_TEXT}

OUTPUT CHANNEL OVERRIDE: do NOT write the JSON array as text. Call the
\`submit_proposals\` function exactly once, passing every proposal in its
\`proposals\` argument. Emit no prose.`;

/** Everything that would prove a real search happened. */
function groundingFacts(raw) {
  const cand = (raw.candidates || [])[0] || {};
  const gm = cand.groundingMetadata || {};
  const queries = gm.webSearchQueries || [];
  const chunks = gm.groundingChunks || [];
  const supports = gm.groundingSupports || [];
  return {
    has_metadata: Boolean(cand.groundingMetadata),
    search_queries: queries.length,
    queries_sample: queries.slice(0, 3),
    grounding_chunks: chunks.length,
    grounding_supports: supports.length,
  };
}

const apiKey = geminiKey();
const MODEL = "gemini-3.7-flash";
const n = Number(process.env.N || 6);

async function fire(label, args) {
  const r = await callGemini({ apiKey, model: MODEL, ...args });
  const facts = groundingFacts(r.raw);
  const call = (r.parts || []).find((p) => p.functionCall)?.functionCall;
  const items = Array.isArray(call?.args?.proposals) ? call.args.proposals.length : null;
  return { label, ...facts, items, finishReason: r.finishReason };
}

const jobs = [];
for (let i = 0; i < n; i++) {
  jobs.push(
    fire("A_prod_text", {
      contents: [{ parts: [{ text: PROMPT_TEXT }] }],
      tools: [SEARCH_TOOL],
      temperature: 0.5,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
    }),
    fire("G_tool", {
      contents: [{ parts: [{ text: TOOL_PROMPT }] }],
      tools: [SEARCH_TOOL, SUBMIT_TOOL],
      temperature: 0.5,
      thinkingLevel: null,
      maxOutputTokens: null,
      functionCallingMode: null,
      includeServerSideToolInvocations: true,
    }),
  );
}

const results = await Promise.all(jobs);

console.log("label\tmeta\tqueries\tchunks\tsupports\titems");
for (const r of results) {
  console.log(
    [r.label, r.has_metadata, r.search_queries, r.grounding_chunks, r.grounding_supports, r.items].join("\t"),
  );
}

console.log("\n# means");
for (const label of ["A_prod_text", "G_tool"]) {
  const rows = results.filter((r) => r.label === label);
  const m = (f) => (rows.reduce((a, r) => a + (r[f] || 0), 0) / rows.length).toFixed(1);
  const grounded = rows.filter((r) => r.search_queries > 0).length;
  console.log(
    `${label}\tgrounded_runs=${grounded}/${rows.length}\tqueries=${m("search_queries")}\tchunks=${m("grounding_chunks")}\tsupports=${m("grounding_supports")}`,
  );
}

console.log("\n# sample queries actually issued");
for (const r of results.slice(0, 4)) {
  console.log(`  ${r.label}\t${JSON.stringify(r.queries_sample)}`);
}
