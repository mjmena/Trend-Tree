// Lane: the registry-driven discovery.gemini.search lane (CRMA-731).
//
// THIS LANE IS STRUCTURALLY DIFFERENT FROM EVERY OTHER ONE, and that
// difference is most of its decision. Every other lane pins its model in a
// `const MODEL` inside the step file, so moving it is a code change that
// ships through a Pipedream redeploy. This lane reads its model from
// DIM_LLM_PROMPT.MODEL at runtime, so moving it is an UPDATE statement —
// no deploy, no PR, effective on the next run, and reversible just as fast.
//
// Two consequences the lane ticket should weigh, neither of which shows up
// in an output diff:
//   - It is the cheapest lane in the fleet to try AND to roll back.
//   - It is the only lane where the running model can drift from the repo
//     without any commit, so whatever it is set to must be recorded
//     somewhere a reader of the code will actually look.
//
// The registry currently has this lane on gemini-2.5-flash, which is an
// OLDER model than the gemini-3-flash-preview the four hardcoded verticals
// run. The two discovery families have already drifted apart.
//
// Like the verticals, this lane is grounded in live Google Search and its
// prompt is dated today, so a historical run is not reproducible — compare
// both models fired now.

import { join } from "node:path";
import { readWorkflow, runStep } from "../lib/workflow.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const WF_DIR = "discovery-p_5VCPP3N";
const WORKFLOW = join(REPO_ROOT, WF_DIR, "workflow.yaml");
const PROMPT_KEY = "discovery.gemini.search";

export const name = "discovery";
export const summary =
  "The one registry-driven lane: its model comes from DIM_LLM_PROMPT, so moving it is an UPDATE, not a deploy.";
export const incumbentModel = "gemini-2.5-flash";
export const ticket = "CRMA-731";
export const requiresRerun = true;

export async function cases({ limit = 1, caseId = null }) {
  const loaded = loadPrompts([PROMPT_KEY]);
  const p = loaded[PROMPT_KEY];
  const vertical = caseId || "consumer";
  return [
    {
      id: vertical,
      label: `${PROMPT_KEY} v${p.version} · registry model ${p.model} · vertical "${vertical}"`,
      incumbentAt: null,
      // Registry rows are per-shard prompts, not per-run outputs, and the
      // signals this lane writes are merged in with every other discovery
      // source. There is no clean per-run incumbent to diff.
      incumbent: {
        emission: null,
        telemetry: { model: p.model, registry_driven: true, prompt_version: p.version },
      },
    },
  ];
}

export async function build(c) {
  const wf = readWorkflow(WORKFLOW);
  const activeRows = runStep(wf, "q_load_active_trends", {});
  const exampleRows = runStep(wf, "q_load_examples", {});

  const loaded = loadPrompts([PROMPT_KEY]);
  const p = loaded[PROMPT_KEY];

  // build_discovery_context/entry.js:30-42
  const active_trends_formatted =
    activeRows.map((r, i) => `${i + 1}. ${r.TREND_TOPIC || "(untitled)"}`).join("\n") ||
    "(no active trends in last 30d)";

  const valuable_examples_formatted =
    exampleRows
      .map((r, i) => {
        const b2b = r.TREND_NAME_B2B || "";
        const b2c = r.TREND_NAME_B2C || "";
        const cat = `${r.CATEGORY || "?"}/${r.SUBCATEGORY || "?"}`;
        const summary = (r.SUMMARY_SHORT || "").replace(/\s+/g, " ").trim().slice(0, 240);
        return `${i + 1}. "${b2b}" / "${b2c}" — ${cat}: ${summary}`;
      })
      .join("\n") || "(no examples available)";

  const rendered = render(p.template, {
    active_trends: active_trends_formatted,
    valuable_examples: valuable_examples_formatted,
    vertical: c.id,
    current_date: new Date().toISOString().slice(0, 10),
  });

  return {
    mode: "single",
    system: null,
    contents: [{ parts: [{ text: rendered }] }],
    // Both come from MODEL_PARAMS in the registry, with the step's defaults.
    tools: p.params.tools ?? [{ google_search: {} }],
    temperature: p.params.temperature ?? 0.5,
    thinkingLevel: "low",
    maxOutputTokens: 16384,
    parse: (text) => {
      // The deployed step uses a brace-balancing extractor rather than the
      // greedy regex the prompt-tester uses; a greedy match here would
      // swallow trailing prose and fail differently from production.
      const s = String(text);
      const start = s.indexOf("[");
      if (start === -1) return null;
      let depth = 0;
      for (let i = start; i < s.length; i++) {
        if (s[i] === "[") depth++;
        else if (s[i] === "]") {
          depth--;
          if (depth === 0) {
            try {
              return { proposals: JSON.parse(s.slice(start, i + 1)) };
            } catch {
              return null;
            }
          }
        }
      }
      return null;
    },
    promptProvenance: provenance(loaded),
    notes: {
      registry_model: p.model,
      prompt_version: p.version,
      active_trends: activeRows.length,
      examples: exampleRows.length,
      vertical: c.id,
      how_to_switch: `UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT SET MODEL='<id>' WHERE PROMPT_KEY='${PROMPT_KEY}' AND IS_ACTIVE=TRUE`,
      drift_note: "registry has this lane on gemini-2.5-flash while the hardcoded verticals run gemini-3-flash-preview",
    },
  };
}

export function compareRows(incumbent, candidate) {
  const b = candidate?.emission?.proposals ?? [];
  const titles = (x) => x.map((t, i) => `${i + 1}. ${t.title ?? t.topic ?? JSON.stringify(t).slice(0, 80)}`).join("\n") || "—";
  return [
    {
      field: "proposals",
      left: "— (no per-run incumbent)",
      right: b.length,
      note: "use --rerun-incumbent to fire the registry model alongside",
    },
    { field: "titles", left: "—", right: titles(b) },
  ];
}

export default { name, summary, incumbentModel, ticket, requiresRerun, cases, build, compareRows };
