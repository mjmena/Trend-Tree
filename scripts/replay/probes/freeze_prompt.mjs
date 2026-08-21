// CRMA-757 — freeze the discovery lane's rendered prompt to disk ONCE.
//
// Every call shape in the truncation matrix must be judged against a
// BYTE-IDENTICAL prompt. Re-rendering per shape would re-read
// DIM_LLM_PROMPT and re-run the two context queries, so active trends and
// examples could drift between shapes and a shape difference would be
// confounded by a prompt difference.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as discovery from "../lanes/discovery.mjs";

const vertical = process.argv[2] || null;
const cases = await discovery.cases({ limit: 1, caseId: vertical });
const c = cases[0];
const built = await discovery.build(c);

const frozen = {
  captured_at: new Date().toISOString(),
  lane: "discovery",
  case_id: c.id,
  label: c.label,
  system: built.system,
  contents: built.contents,
  production_tools: built.tools,
  production_temperature: built.temperature,
  notes: built.notes,
  promptProvenance: built.promptProvenance,
};

const out = join(import.meta.dirname, process.argv[3] || "frozen_prompt.json");
writeFileSync(out, JSON.stringify(frozen, null, 2));
const chars = built.contents[0].parts[0].text.length;
console.log(`FROZEN\t${c.id}\t${chars} chars\t${out}`);
console.log(`TOOLS\t${JSON.stringify(built.tools)}`);
console.log(`TEMP\t${built.temperature}`);
