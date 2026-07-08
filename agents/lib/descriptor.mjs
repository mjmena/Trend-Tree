// descriptor.mjs — canonical reference for the machine-facing trend
// descriptor: the { statement, query } artifact authored by the enrichment
// agent (ADR-0003) and the reusable atomic-query authoring rule.
//
// =====================================================================
// IMPORTANT: This file is the SOURCE OF TRUTH. The actual deployed copies
// live INLINED at the top of each workflow's LLM step entry.js — Pipedream
// GitHub-synced workflows do not bundle cross-file imports (lib/*.mjs,
// sibling .js, etc.). When you change something here, search the codebase
// for the export names and update each inlined copy.
//
// Inlined sites (as of ADR-0003 / issue #52):
//   - enrichment-p_xMC995w/run_enrichment_agent/entry.js
//
// ATOMIC_QUERY_RULE reuse (as of ADR-0004 / issue #59): the distillation
// lead + subagent now author the same atomic query as the [candidate query]
// on every candidate (propose_trend_candidate.query), persisted to
// STG_TREND_CANDIDATES.QUERY. That rule text is inlined (not imported) in the
// ACTIVE authoring path — the workflows that actually write candidates:
//   - distillation-p_mkCBBqb/run_lead_agent/entry.js  (registers + persists)
//   - distillation-subagent-p_jmCjj3J/run_subagent/entry.js  (surfaces it)
//     (both propose_trend_candidate schemas)
// so a corroboration oracle (Exploding Topics, slice 2) can be looked up at
// promotion — before the trend, and thus descriptor.query, exists.
// NB: distillation-cluster-agent-p_YyC89Ke does NOT write candidates — do not
// add the field there (that mis-wire caused the slice-1 misdeploy).
// =====================================================================

// The atomic-query authoring rule. Declarative, no worked one-shot
// examples (per the no-static-seeding standard, ADR-0001). Empirically
// grounded: atomic consumer-vernacular terms match Exploding Topics ~67%
// vs ~6% for compound topic/name strings (ADR-0003 probe, 2026-06-29).
export const ATOMIC_QUERY_RULE =
  "A single atomic, consumer-vernacular search term — the ingredient, " +
  "product, or practice a shopper would actually type into a search box. " +
  "NOT the compound behavior, NOT a coined marketing label, NOT industry " +
  "jargon (e.g. 'retailtainment', 'agentic commerce'), and NOT a fresh " +
  "internet-slang neologism that catalogs lag on (e.g. '-maxxing' coinages). " +
  "Prefer the established noun a category already has over a clever phrase. " +
  "This is a join key to external keyword APIs (Exploding Topics, Google " +
  "Trends) — it is graded on whether those catalogs recognize it, so reach " +
  "for the plainest term that still names THIS trend specifically.";

// The statement authoring rule. The faithful prose core that becomes the
// sole embedding seed (ADR-0003). Reuses the distillation specificity
// rubric's noun-verb framing.
export const STATEMENT_RULE =
  "A tight 2-4 sentence faithful prose core in a machine register: the " +
  "subject, the specific behavior/product (the noun a consumer can put on a " +
  "slide and the verb they are doing), the distinguishing axis vs. sibling " +
  "trends, and the domain. De-buzzworded — no marketing flavor, no " +
  "call-to-action, not action-oriented copy. This is consumed by other " +
  "systems (the trend embedding, external APIs), not by a human reader.";

// Combined declarative guidance block for injection into an agent system
// prompt. Mirrors the shape of the NAMING GUIDANCE block.
export const DESCRIPTOR_GUIDANCE =
  "TREND DESCRIPTOR — a machine-facing canonical artifact, the opposite " +
  "register from the human-facing name. Author two members:\n" +
  `  • statement — ${STATEMENT_RULE}\n` +
  `  • query — ${ATOMIC_QUERY_RULE}\n` +
  "Also self-predict specificity_score (0.0-1.0; 1.0 = a crisp " +
  "noun-verb-product, 0.0 = a bare category). This is telemetry, not a gate.";

// JSON-schema property fragment for the propose_enrichment tool. Spread
// into the tool's input_schema.properties.
export const DESCRIPTOR_TOOL_PROPERTIES = {
  descriptor: {
    type: "object",
    description:
      "Machine-facing canonical artifact (ADR-0003). NOT a summary, NOT the name — the de-buzzworded soul of the trend, authored for other systems.",
    properties: {
      statement: { type: "string", description: STATEMENT_RULE },
      query: { type: "string", description: ATOMIC_QUERY_RULE },
    },
    required: ["statement", "query"],
  },
  specificity_score: {
    type: "number",
    description:
      "Self-predicted 0.0-1.0 (1.0 = crisp noun-verb-product, 0.0 = bare category). Telemetry on how specific this trend is — no gate acts on it.",
  },
};

// Fields to append to the propose_enrichment tool's `required` array.
export const DESCRIPTOR_REQUIRED_FIELDS = ["descriptor", "specificity_score"];
