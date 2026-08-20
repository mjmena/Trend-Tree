// Lane: the four discovery verticals + the prompt-tester default (CRMA-730).
//
// THIS IS THE LANE THE THINKING FLOOR LANDS ON. CRMA-727 established that
// the nine Pro loops already run thinking_level "medium", while these four
// run single-shot at temperature 0.3 with no thinking parameter at all. On
// gemini-3.7-flash thinking cannot be switched off — "low" is the floor and
// every call bills thinking tokens at the output rate. So this lane is the
// one where the cost shape genuinely changes rather than merely scaling,
// and the harness reports thinking tokens explicitly for exactly that
// reason.
//
// Two structural limits, both declared rather than worked around:
//
//   1. These lanes are grounded in live Google Search and their prompt is
//      dated "today". A historical run is NOT reproducible — the web moved.
//      So the comparison is both models fired today against the same
//      prompt, and the ledger rows are background, not a target.
//   2. Output is a set of discovered trends, not one record. Judge the SET
//      — count, specificity, URL liveness — not a field-by-field diff.

import { join } from "node:path";
import { query, sqlStr } from "../lib/snowflake.mjs";
import { loadStep, readPin } from "../lib/entry_module.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

/** Every vertical, plus the prompt-tester whose DEFAULT_MODEL shares the pin. */
const VERTICALS = {
  wellness: "ingestion/LLM/gemini-wellness-p_zAC1DvL",
  "food-drink": "ingestion/LLM/gemini-food-drink-p_5VCPJVJ",
  travel: "ingestion/LLM/gemini-travel-p_BjC3yGQ",
  other: "ingestion/LLM/gemini-other-p_dDCWMDJ",
};

export const name = "verticals";
export const summary =
  "The four Gemini discovery verticals. The only lanes with no thinking parameter — where 3.7 Flash's thinking floor actually bites.";
export const incumbentModel = "gemini-3-flash-preview";
export const ticket = "CRMA-730";
export const requiresRerun = true;

/** One case per vertical; --case wellness narrows to one. */
export async function cases({ limit = 4, caseId = null }) {
  const wanted = caseId ? [caseId] : Object.keys(VERTICALS).slice(0, limit);
  const out = [];

  for (const vertical of wanted) {
    const dir = VERTICALS[vertical];
    if (!dir) throw new Error(`Unknown vertical '${vertical}'. Try: ${Object.keys(VERTICALS).join(", ")}`);
    const entry = join(REPO_ROOT, dir, "fetch_source", "entry.js");
    const { SOURCE_NAME } = await loadStep(entry, ["SOURCE_NAME"]);
    const pin = readPin(entry);

    // What this vertical most recently wrote — background for the diff.
    const rows = query(`
      SELECT SIGNAL_TITLE, COALESCE(URL, SIGNAL_ID) AS URL, INGESTED_AT, METADATA:model::STRING AS MODEL, METADATA:run_date::STRING AS RUN_DATE
        FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
       WHERE SOURCE_NAME = ${sqlStr(SOURCE_NAME)}
       ORDER BY INGESTED_AT DESC
       LIMIT 25
    `);
    const runDate = rows[0]?.RUN_DATE ?? null;
    const latest = rows.filter((r) => r.RUN_DATE === runDate);

    out.push({
      id: vertical,
      label: `${vertical} (${SOURCE_NAME}) · last run ${runDate ?? "unknown"} · pin ${pin.model}`,
      incumbentAt: runDate,
      incumbent: {
        emission: {
          trends: latest.map((r) => ({ title: r.SIGNAL_TITLE, source_url: r.URL })),
        },
        telemetry: { model: latest[0]?.MODEL ?? pin.model, run_date: runDate, signals: latest.length },
      },
    });
  }
  return out;
}

export async function build(c) {
  const entry = join(REPO_ROOT, VERTICALS[c.id], "fetch_source", "entry.js");
  const { buildPrompt, SOURCE_NAME, CATEGORY, resolveAndVerify } = await loadStep(entry, [
    "buildPrompt",
    "SOURCE_NAME",
    "CATEGORY",
    "resolveAndVerify",
  ]);
  const prompt = buildPrompt();

  return {
    mode: "single",
    system: null,
    contents: [{ parts: [{ text: prompt }] }],
    // Google Search grounding, exactly as the deployed step sends it. Note
    // the step deliberately omits responseMimeType — setting it breaks
    // grounding (see discovery-p_5VCPP3N/discover_gemini/entry.js:7).
    tools: [{ google_search: {} }],
    // The deployed step sends temperature 0.3. It is deprecated as of
    // 2026-07-21, but this lane's incumbent behaviour depends on it, so the
    // replay sends it and the lane ticket decides whether to drop it.
    temperature: 0.3,
    // 3.7 Flash has no "minimal"; the client floors this to "low".
    thinkingLevel: "low",
    maxOutputTokens: 16384,
    // The deployed step does not stop at parsing: it resolves each grounding
    // redirect and DROPS any URL that is not live (resolveAndVerify). Without
    // that step every candidate URL reads as
    // "vertexaisearch.cloud.google.com" and the lane looks worse than it is,
    // so the replay runs production's own resolver.
    parse: async (text) => {
      const m = String(text).match(/\[[\s\S]*\]/);
      if (!m) return null;
      let trends;
      try {
        trends = JSON.parse(m[0]);
      } catch {
        return null;
      }
      const resolved = [];
      for (const t of trends) {
        if (!t?.source_url) {
          resolved.push({ ...t, url_live: false });
          continue;
        }
        const r = await resolveAndVerify(t.source_url);
        resolved.push({ ...t, source_url: r.url, url_live: r.ok });
      }
      return { trends: resolved };
    },
    promptProvenance: null,
    notes: {
      source_name: SOURCE_NAME,
      category: CATEGORY,
      prompt_chars: prompt.length,
      prompt_source: "hardcoded in the step — this lane does NOT read DIM_LLM_PROMPT",
      thinking_floor:
        "the incumbent sends no thinking parameter at all; 3.7 Flash cannot disable thinking, so compare thinking tokens closely",
      grounding: "live Google Search — results are not reproducible across days",
    },
  };
}

export function compareRows(incumbent, candidate) {
  const a = incumbent?.emission?.trends ?? [];
  const b = candidate?.emission?.trends ?? [];
  const titles = (x) => x.map((t, i) => `${i + 1}. ${t.title}`).join("\n") || "—";
  const hosts = (x) =>
    [
      ...new Set(
        x
          .map((t) => {
            try {
              return new URL(t.source_url).host.replace(/^www\./, "");
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      ),
    ]
      .sort()
      .join("\n") || "—";
  const missingUrl = (x) => x.filter((t) => !t.source_url).length;
  // url_live is only known for the candidate — the incumbent's dead URLs
  // were already dropped by the deployed step before they reached the table.
  const dead = (x) => x.filter((t) => t.url_live === false).length;

  return [
    { field: "trend count", left: a.length, right: b.length, note: "incumbent = last production run, a DIFFERENT day" },
    { field: "titles", left: titles(a), right: titles(b) },
    { field: "distinct publishers", left: hosts(a), right: hosts(b) },
    { field: "missing source_url", left: missingUrl(a), right: missingUrl(b) },
    {
      field: "dead URLs (candidate only)",
      left: "—",
      right: dead(b),
      note: "HEAD from a laptop; publishers that 403 this IP would pass from Pipedream — confirm before counting it against the lane",
    },
  ];
}

export default { name, summary, incumbentModel, ticket, requiresRerun, cases, build, compareRows };
