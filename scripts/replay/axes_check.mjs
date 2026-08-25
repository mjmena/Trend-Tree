#!/usr/bin/env node
// Authoring-time check for compare axes (CRMA-760).
//
// smoke.sh cannot catch this class: a dry run makes no emission, so
// compareRows never executes and an axis naming a field the terminal tool
// schema does not declare renders blank instead of failing. CRMA-734 lost a
// lifecycle decision to exactly that, and this ticket found two more — the
// audit lane's `report` axis (never declared) and the name-reviewer lane's
// `decode_score` / `alternates` axes (real keys are `score` / `alternate`).
//
// Two halves, no model calls and no Snowflake:
//   1. each fixed lane's axes resolve against a schema-shaped payload
//   2. the runner's dead-axis guard flags a dead axis and only a dead axis
//
//   node scripts/replay/axes_check.mjs

import { join } from "node:path";
import audit, { sectionKeysFrom } from "./lanes/audit.mjs";
import nameReviewer from "./lanes/name-reviewer.mjs";
import enrichment from "./lanes/enrichment.mjs";
import { noteAxisLiveness } from "./lib/runner.mjs";
import { loadStep } from "./lib/entry_module.mjs";
import { REPO_ROOT } from "./lib/runner.mjs";

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};
const deadAfter = (...caseRows) => {
  const seen = new Map();
  for (const rows of caseRows) noteAxisLiveness(seen, rows);
  return [...seen.entries()].filter(([, live]) => !live).map(([f]) => f);
};

// ── audit — keyed the way propose_audit_report declares it ──────────────────
const auditEmission = {
  overall_status: "YELLOW",
  alerts: [{ severity: "WARN", area: "ingestion", summary: "bluesky thin" }],
  ingestion: { status: "YELLOW", gap_notes: "bluesky thin" },
  distillation: { status: "GREEN" },
  promotion: { status: "GREEN" },
  enrichment: { status: "GREEN" },
  lifecycle: { status: "GREEN" },
  dashboard: { status: "GREEN" },
  workflow_health: { status: "RED", audited_count: 12 },
  cost_24h_usd: 3.14,
  reasoning: "one section degraded",
};
console.log("audit");
const aRows = audit.compareRows({ emission: auditEmission }, { emission: auditEmission });
check("no dead `report` axis", !aRows.some((r) => r.field === "report"));
for (const s of [
  "ingestion",
  "distillation",
  "promotion",
  "enrichment",
  "lifecycle",
  "dashboard",
  "workflow_health",
]) {
  const row = aRows.find((r) => r.field === `${s}.status`);
  check(`${s}.status populates both sides`, row && row.left != null && row.right != null);
}
check("cost_24h_usd populates", aRows.find((r) => r.field === "cost_24h_usd")?.left === 3.14);
check("reasoning populates", !!aRows.find((r) => r.field === "reasoning")?.left);

// ── name-reviewer — left is the persisted record, right is decoder-only ─────
console.log("name-reviewer");
const ledgerRecord = {
  decoder_guess: "Retailers expanding menopause-care aisles.",
  score: 8,
  decode_pass: true,
  alternate: "Menopause Aisle Buildout",
};
const nRows = nameReviewer.compareRows(
  { emission: ledgerRecord },
  { emission: { guess: "Stores selling menopause products." } },
  {},
);
const guessRow = nRows.find((r) => r.field === "decoder_guess");
check("decoder_guess populates both sides", !!guessRow?.left && !!guessRow?.right);
check("score axis reads persisted `score`", nRows.find((r) => r.field.startsWith("score"))?.left === 8);
check("no axis reads `decode_score`", !JSON.stringify(nRows).includes("decode_score"));
check(
  "alternate axis reads singular `alternate`",
  nRows.find((r) => r.field.startsWith("alternate"))?.left === "Menopause Aisle Buildout",
);
check("no axis reads plural `alternates`", !nRows.some((r) => r.field === "alternates offered"));

// ── enrichment — the legacy per-audience axes are gone ──────────────────────
console.log("enrichment");
const enrEmission = {
  trend_name: "Menopause Aisle Buildout",
  summary_short: "s",
  summary_long: "l",
  category: "beauty",
  subcategory: "menopause_care",
  specificity_score: 0.8,
  descriptor: { statement: "st", query: "q" },
  social_narrative: [1, 2],
  cultural_drivers: [1],
  evidence: [1, 2, 3],
};
const eRows = enrichment.compareRows({ emission: enrEmission }, { emission: enrEmission });
check("no trend_name_b2c axis", !eRows.some((r) => r.field === "trend_name_b2c"));
check("no trend_name_b2b axis", !eRows.some((r) => r.field === "trend_name_b2b"));
check("trend_name still compared", !!eRows.find((r) => r.field === "trend_name")?.left);
check("descriptor.statement still compared", eRows.find((r) => r.field === "descriptor.statement")?.left === "st");
check("specificity_score still compared", eRows.find((r) => r.field === "specificity_score")?.left === 0.8);

// ── the guard itself ────────────────────────────────────────────────────────
console.log("dead-axis guard");
check(
  "flags the audit `report` slip",
  deadAfter([{ field: "report", left: undefined, right: undefined }]).includes("report"),
);
check(
  "flags the name-reviewer `alternates` slip",
  deadAfter([{ field: "alternates offered", left: undefined, right: "—" }]).includes("alternates offered"),
);
check("does not flag an axis live on both sides", deadAfter([{ field: "overall_status", left: "GREEN", right: "YELLOW" }]).length === 0);
check(
  "does not flag an axis live in only one case",
  deadAfter(
    [{ field: "alternate", left: null, right: "—" }],
    [{ field: "alternate", left: "Menopause Aisle Buildout", right: "—" }],
    [{ field: "alternate", left: null, right: "—" }],
  ).length === 0,
);
check(
  "does not flag a legitimately incumbent-only axis",
  deadAfter([{ field: "decode_pass", left: true, right: "— (verifier not replayed)" }]).length === 0,
);
check("treats 0 as a value, not a blank", deadAfter([{ field: "alert count", left: 0, right: 0 }]).length === 0);
check("treats an empty string as blank", deadAfter([{ field: "intro", left: "", right: "" }]).includes("intro"));

// ── the audit section list is derived from the DEPLOYED schema, not listed ──
// This is the half that stops CRMA-760 from recurring: CRMA-722 adds
// data_hygiene and CRMA-469 adds governance to this same schema, and a derived
// list compares them the day they land.
console.log("audit sections derive from the deployed schema");
const { TOOL_SCHEMAS } = await loadStep(
  join(REPO_ROOT, "audit-agent-p_xMC9nm3", "run_audit_agent", "entry.js"),
  ["TOOL_SCHEMAS"],
);
const derived = sectionKeysFrom(TOOL_SCHEMAS);
const declared = Object.keys(TOOL_SCHEMAS?.propose_audit_report?.input_schema?.properties ?? {});
check("derivation found sections", derived.length > 0, JSON.stringify(derived));
check(
  "every derived section is declared in propose_audit_report",
  derived.every((k) => declared.includes(k)),
  JSON.stringify(derived.filter((k) => !declared.includes(k))),
);
check(
  "no scalar verdict field is mistaken for a section",
  !derived.some((k) => ["overall_status", "cost_24h_usd", "reasoning", "slack_summary_md", "alerts"].includes(k)),
  JSON.stringify(derived),
);
console.log(`       sections now declared: ${derived.join(", ")}`);

// Prove the derivation picks a new section up rather than needing an edit here.
const withIncoming = sectionKeysFrom({
  propose_audit_report: {
    input_schema: {
      properties: {
        ...TOOL_SCHEMAS.propose_audit_report.input_schema.properties,
        data_hygiene: { type: "object", description: "{ status, active_orphan_trends }" },
        governance: { type: "object", description: "{ status, prompt_drift_count }" },
      },
    },
  },
});
check("picks up data_hygiene (CRMA-722, PR #100) with no edit here", withIncoming.includes("data_hygiene"));
check("picks up governance (CRMA-469, PR #99) with no edit here", withIncoming.includes("governance"));

console.log(failures === 0 ? "\nall axis checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
