// prompt_loader.mjs — canonical reference for the registry-driven prompt
// loading + rendering helpers used by every LLM-touching workflow.
//
// =====================================================================
// IMPORTANT: This file is the SOURCE OF TRUTH. The actual deployed copies
// live INLINED at the top of each workflow's LLM step entry.js — Pipedream
// GitHub-synced workflows do not bundle cross-file imports (lib/*.mjs,
// sibling .js, etc.). When you change something here, search the codebase
// for the function names and update each inlined copy.
//
// Inlined sites (as of Slice 2):
//   - llm-enrichment-p_YyC86Zo/enrich_llm_gemini/entry.js
//   - llm-enrichment-p_YyC86Zo/enrich_llm_grok/entry.js
//   - llm-enrichment-p_YyC86Zo/enrich_llm_claude/entry.js
// =====================================================================

/**
 * Convert the raw rows returned by query_prompts into a keyed lookup.
 * Snowflake returns column names UPPERCASED; we normalize here.
 *
 * @param {Array<Object>} rows  Output of `SELECT PROMPT_KEY, VERSION, MODEL,
 *                              TEMPLATE, MODEL_PARAMS FROM DIM_LLM_PROMPT
 *                              WHERE IS_ACTIVE = TRUE AND PROMPT_KEY IN (...)`
 * @returns {Object<string, {template: string, model: string, params: object,
 *                           version: number}>}
 */
export function loadPrompts(rows) {
  const out = {};
  for (const r of (rows || [])) {
    const key = r.PROMPT_KEY;
    if (!key) continue;
    let params = r.MODEL_PARAMS;
    if (typeof params === "string") {
      try { params = JSON.parse(params); } catch { params = {}; }
    }
    if (!params || typeof params !== "object") params = {};
    out[key] = {
      template: r.TEMPLATE || "",
      model: r.MODEL || "",
      params,
      version: r.VERSION,
    };
  }
  return out;
}

/**
 * Mustache-style {{var}} substitution. Objects/arrays are JSON.stringify'd.
 * Missing vars render as empty string (loud failure modes — you'll see the
 * gap in the LLM output, faster to debug than a misleading default).
 *
 * Intentionally simple: no conditionals, no loops. Complex formatting
 * (per-source evidence lines, conditional fragments) lives in the calling
 * step which precomputes flat strings before render().
 *
 * @param {string} template       Prompt body with {{var}} placeholders.
 * @param {Object} vars           Flat dict of substitution values.
 * @returns {string}              Rendered prompt body.
 */
export function render(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars?.[key];
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v, null, 2);
  });
}

/**
 * Lookup helper that throws if the key isn't loaded — surfaces missing
 * registry rows immediately instead of silently sending an empty prompt.
 *
 * @param {Object} loaded         Output of loadPrompts(rows).
 * @param {string} key            Prompt key to retrieve.
 * @returns {{template, model, params, version}}
 */
export function mustGet(loaded, key) {
  const p = loaded?.[key];
  if (!p || !p.template) {
    throw new Error(
      `Prompt '${key}' not loaded. Confirm DIM_LLM_PROMPT has IS_ACTIVE=TRUE for this key and the query_prompts step's IN clause includes it.`,
    );
  }
  return p;
}
