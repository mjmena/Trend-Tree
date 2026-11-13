// Prompt registry access for the replay harness.
//
// THE TRAP THIS FILE EXISTS FOR (CRMA-728):
// sql/update_enrichment_system_v7_descriptor.sql applies the descriptor
// instruction by a surgical REPLACE() against v6, so NO repo file holds the
// active v7 enrichment template. A harness that read prompts from the repo
// would replay a prompt that never ran. Every prompt here comes from
// DIM_LLM_PROMPT, the same place the deployed steps read it from.

import { query, sqlStr } from "./snowflake.mjs";

const REGISTRY = "MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT";

/**
 * Load active prompts by key. Mirrors loadPrompts() in
 * agents/lib/prompt_loader.mjs, including the UPPERCASE column normalisation.
 *
 * @param {string[]} keys
 * @returns {Object<string, {template, model, params, version}>}
 */
export function loadPrompts(keys) {
  if (!keys?.length) return {};
  const list = keys.map(sqlStr).join(", ");
  const rows = query(
    `SELECT PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS
       FROM ${REGISTRY}
      WHERE IS_ACTIVE = TRUE AND PROMPT_KEY IN (${list})`,
  );
  const out = {};
  for (const r of rows) {
    if (!r.PROMPT_KEY) continue;
    let params = r.MODEL_PARAMS;
    if (typeof params === "string") {
      try {
        params = JSON.parse(params);
      } catch {
        params = {};
      }
    }
    out[r.PROMPT_KEY] = {
      template: r.TEMPLATE || "",
      model: r.MODEL || "",
      params: params && typeof params === "object" ? params : {},
      version: r.VERSION,
    };
  }
  const missing = keys.filter((k) => !out[k]?.template);
  if (missing.length) {
    throw new Error(
      `Prompt(s) not active in ${REGISTRY}: ${missing.join(", ")}. ` +
        `The harness will not substitute a repo copy — that is the CRMA-728 trap.`,
    );
  }
  return out;
}

/** Mustache-style {{var}} substitution. Same semantics as prompt_loader.render. */
export function render(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars?.[key];
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v, null, 2);
  });
}

/** Record which prompt versions a replay ran against, for the run artifact. */
export function provenance(loaded) {
  return Object.fromEntries(
    Object.entries(loaded).map(([k, v]) => [k, { version: v.version, registry_model: v.model, chars: v.template.length }]),
  );
}
