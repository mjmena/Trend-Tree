// Lane: the daily-digest intro writer (CRMA-738).
//
// The odd one out in three ways, all of which matter to its decision:
//
//   1. It is the ONLY lane in the repo that declares structured output
//      (responseMimeType: "application/json"). Every other structured
//      emission goes through functionDeclarations.
//   2. Its rate table disagrees with the other twelve. It prices the same
//      pinned gemini-3.1-pro-preview at $1.25/$10.00 instead of
//      $2.00/$12.00 (generate_intro/entry.mjs:26-27), under-reporting this
//      lane by roughly 40%. The harness prices the replay from ITS OWN
//      table and reports the deployed constants beside it, so the lane
//      ticket can see the gap rather than inherit it.
//   3. It persists nothing to Snowflake. The intro goes to Braze, so there
//      is NO incumbent record to diff against. This lane therefore always
//      compares both models fired today.
//
// It is also the softest-failing lane: on any error it returns a blank
// intro and the email ships without the editorial block. A silent
// no-emission here is invisible in production, which makes finishReason
// worth reading closely.

import { join } from "node:path";
import { readWorkflow, runStep } from "../lib/workflow.mjs";
import { loadStep, readPin } from "../lib/entry_module.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const WF_DIR = "daily-digest-p_vQCkwgV";
const ENTRY = join(REPO_ROOT, WF_DIR, "generate_intro", "entry.mjs");
const WORKFLOW = join(REPO_ROOT, WF_DIR, "workflow.yaml");

export const name = "daily-digest";
export const summary =
  "Editorial intro for the digest email. The only lane using responseMimeType, and the one whose rate table disagrees with the other twelve.";
export const incumbentModel = "gemini-3.1-pro-preview";
export const ticket = "CRMA-738";
export const requiresRerun = true;

export async function cases({ limit = 1 }) {
  const pin = readPin(ENTRY);
  return [
    {
      id: "today",
      label: `today's dashboard slice · deployed rates $${pin.rates?.input}/$${pin.rates?.output} per 1M`,
      incumbentAt: null,
      // Nothing is persisted — see the header note.
      incumbent: { emission: null, telemetry: { model: pin.model, persisted: false } },
    },
  ];
}

export async function build() {
  const wf = readWorkflow(WORKFLOW);
  const rows = runStep(wf, "query_dashboard", {});
  if (!rows.length) {
    throw new Error("query_dashboard returned no rows — the digest would skip the intro entirely today.");
  }

  const { buildPrompt, extractOutput } = await loadStep(ENTRY, ["buildPrompt", "extractOutput"]);
  const prompt = buildPrompt(rows);
  const pin = readPin(ENTRY);

  return {
    mode: "single",
    system: null,
    contents: [{ parts: [{ text: prompt }] }],
    temperature: 0.5,
    thinkingLevel: "medium",
    maxOutputTokens: 16384,
    // The deployed step sets responseMimeType but declares no schema, so
    // there is no field-coverage measurement to make here — which is
    // precisely why this lane is a poor probe for hazard H8.
    responseSchema: null,
    parse: (text) => {
      try {
        return JSON.parse(text);
      } catch {
        // Fall back to the deployed extractor, which repairs a dangling
        // JSON tail before giving up.
        try {
          return extractOutput({ candidates: [{ content: { parts: [{ text }] } }] });
        } catch {
          return null;
        }
      }
    },
    promptProvenance: null,
    notes: {
      dashboard_rows: rows.length,
      prompt_chars: prompt.length,
      prompt_source: "hardcoded in the step — this lane does NOT read DIM_LLM_PROMPT",
      deployed_rates: pin.rates,
      rate_table_discrepancy:
        "the step prices Pro at 1.25/10.00 while twelve other sites price it at 2.00/12.00 — the harness uses 2.00/12.00",
      no_incumbent_record: "output goes to Braze, never Snowflake — compare both models today",
    },
  };
}

export function compareRows(incumbent, candidate) {
  const a = incumbent?.emission ?? {};
  const b = candidate?.emission ?? {};
  return [
    { field: "preheader", left: a.preheader, right: b.preheader, note: "no persisted incumbent — use --rerun-incumbent" },
    { field: "intro", left: a.intro, right: b.intro },
  ];
}

export default { name, summary, incumbentModel, ticket, requiresRerun, cases, build, compareRows };
