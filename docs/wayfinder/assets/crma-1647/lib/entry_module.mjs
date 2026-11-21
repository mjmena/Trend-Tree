// Load the DEPLOYED step code as a module.
//
// Why this exists: every workflow step is a Pipedream component whose file
// ends in `export default defineComponent({ ... })`, and everything above
// that — tool schemas, dispatchers, helpers, the model const — is plain
// top-level JavaScript. agents/lib/*.mjs is only a REFERENCE copy of those
// helpers and is known to drift, so a harness that imported the library
// would replay something other than what runs in production.
//
// This module reads the real step file, cuts the defineComponent tail, and
// re-exports the top-level bindings the caller asks for. The replay then
// drives the same schemas and the same dispatch code the workflow deploys.
//
// The cut is safe because `export default defineComponent(` is always the
// final statement; anything after it is the component body, which needs a
// Pipedream runtime we do not have.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const CACHE = new Map();

/**
 * Accept a step entry named either `entry.js` or `entry.mjs`.
 *
 * Steps are being renamed to `.mjs` one at a time — CRMA-775 did it to
 * run_audit_agent on 2026-08-21 — while every lane hardcodes `entry.js`. A
 * rename would otherwise break the lane pointing at it with ENOENT, so resolve
 * the sibling extension instead of making each lane track the churn.
 */
function resolveEntry(entryPath) {
  if (existsSync(entryPath)) return entryPath;
  const swapped = entryPath.endsWith(".mjs")
    ? entryPath.replace(/\.mjs$/, ".js")
    : entryPath.replace(/\.js$/, ".mjs");
  if (swapped !== entryPath && existsSync(swapped)) return swapped;
  return entryPath; // let readFileSync raise the real ENOENT
}

/**
 * @param {string} entryPath  Absolute path to a step's entry.js / entry.mjs.
 * @param {string[]} names    Top-level binding names to re-export.
 * @returns {Promise<Object>} The requested bindings.
 */
export async function loadStep(entryPath, names) {
  entryPath = resolveEntry(entryPath);
  const cacheKey = `${entryPath}::${names.join(",")}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const src = readFileSync(entryPath, "utf8");
  if (!src.includes("export default")) {
    throw new Error(`${entryPath} has no 'export default' — not a Pipedream step file.`);
  }

  // Keep the WHOLE file. Several steps define helpers BELOW the
  // defineComponent call (distillation-cluster-agent's hostnameOf sits at
  // line 823, well after it) and rely on hoisting. Cutting at
  // `export default` silently dropped those and produced a
  // "does not define" error for a function that plainly exists.
  //
  // Instead the default export is demoted to a plain const and
  // defineComponent is shimmed to the identity function. The component body
  // is never invoked — it is just an object literal with an async `run`
  // method — so evaluating the module has no side effects.
  const body = src.replace(/export\s+default\s+/, "const __component = ");

  const missing = names.filter(
    (n) => !new RegExp(`(?:^|\\n)\\s*(?:const|let|var|function|async function|class)\\s+${n}\\b`).test(body),
  );
  if (missing.length) {
    throw new Error(
      `${basename(dirname(entryPath))}/${basename(entryPath)} does not define: ${missing.join(", ")}.\n` +
        `The step was probably refactored — update the lane adapter rather than copying a schema.`,
    );
  }

  const shim =
    "const defineComponent = (c) => c;\n" +
    "const $ = undefined, steps = undefined;\n";
  const shimmed = `${shim}${body}\nexport { ${names.join(", ")} };\n`;
  const dir = mkdtempSync(join(tmpdir(), "replay-step-"));
  const file = join(dir, "step.mjs");
  writeFileSync(file, shimmed, "utf8");
  try {
    const mod = await import(pathToFileURL(file).href);
    const out = Object.fromEntries(names.map((n) => [n, mod[n]]));
    CACHE.set(cacheKey, out);
    return out;
  } catch (e) {
    throw new Error(
      `Could not load ${entryPath} as a module: ${e.message}\n` +
        `If the step now imports something at the top level, the harness cannot ` +
        `evaluate it outside Pipedream — give the lane an explicit schema instead.`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the pinned model id and rate table straight from the deployed step. */
export function readPin(entryPath) {
  const src = readFileSync(resolveEntry(entryPath), "utf8");
  const model = src.match(/const\s+(?:MODEL|GEMINI_MODEL|DEFAULT_MODEL)\s*=\s*["']([^"']+)["']/);
  const rates = src.match(/const\s+RATES_PER_M\s*=\s*\{\s*input:\s*([\d.]+)\s*,\s*output:\s*([\d.]+)/);
  const scalarIn = src.match(/const\s+INPUT_PER_M\s*=\s*([\d.]+)/);
  const scalarOut = src.match(/const\s+OUTPUT_PER_M\s*=\s*([\d.]+)/);
  return {
    model: model?.[1] ?? null,
    rates: rates
      ? { input: Number(rates[1]), output: Number(rates[2]) }
      : scalarIn && scalarOut
        ? { input: Number(scalarIn[1]), output: Number(scalarOut[1]) }
        : null,
  };
}
