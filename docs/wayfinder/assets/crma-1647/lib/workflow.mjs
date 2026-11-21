// Read a workflow's own prefetch SQL and re-run it for a historical case.
//
// This is the heart of the harness's fidelity claim. Every lane's model input
// is assembled from Snowflake rows fetched by `snowflake-execute-sql-query`
// steps declared in its workflow.yaml, with `{{steps.*}}` interpolation. If
// the harness hand-wrote its own queries they would drift from production the
// first time someone edited a step, and a lane decision would then rest on
// inputs the pipeline never actually sees.
//
// So the harness reads the deployed SQL and substitutes the same bindings.
// When a step is edited, the replay follows automatically.
//
// YAML is parsed by python3 + PyYAML because this repo has no package.json
// and the harness must run on a bare `node` with no installs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { query } from "./snowflake.mjs";

/** Parse a workflow.yaml into a plain object. */
export function readWorkflow(path) {
  const out = execFileSync(
    "python3",
    ["-c", "import sys,yaml,json; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)", path],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

/** Every Snowflake step, in declaration order. */
export function sqlSteps(workflow) {
  return (workflow.steps || [])
    .filter((s) => typeof s.uses === "string" && s.uses.startsWith("snowflake-execute-sql-query"))
    .map((s) => ({
      namespace: s.namespace,
      sql: s.props?.sql?.value ?? "",
      // Positional binds. The step passes these as `:1`, `:2`, … and their
      // values are themselves `{{steps.*}}` templates.
      params: s.props?.sql?.params ?? [],
    }))
    .filter((s) => s.sql);
}

function step(workflow, namespace) {
  const hit = sqlSteps(workflow).find((s) => s.namespace === namespace);
  if (!hit) {
    const available = sqlSteps(workflow).map((s) => s.namespace).join(", ");
    throw new Error(`No SQL step '${namespace}' in this workflow. Available: ${available}`);
  }
  return hit;
}

/** One named step's SQL. */
export function stepSql(workflow, namespace) {
  return step(workflow, namespace).sql;
}

/**
 * Substitute `{{ ... }}` bindings.
 *
 * Production interpolates Pipedream step outputs. The harness supplies the
 * same values from the historical record. Any placeholder left unbound is a
 * hard error: a silently-empty binding produces a WHERE clause that matches
 * nothing, and an empty result set reads exactly like "this trend had no
 * signals" — a wrong replay that looks like a real finding.
 */
export function bind(sql, bindings) {
  const unresolved = [];
  const rendered = sql.replace(/\{\{([^}]+)\}\}/g, (_, raw) => {
    const key = raw.trim();
    if (Object.prototype.hasOwnProperty.call(bindings, key)) return String(bindings[key]);
    const short = key.replace(/^steps\./, "").replace(/\.\$return_value\./, ".");
    if (Object.prototype.hasOwnProperty.call(bindings, short)) return String(bindings[short]);
    const leaf = key.split(".").pop();
    if (Object.prototype.hasOwnProperty.call(bindings, leaf)) return String(bindings[leaf]);
    unresolved.push(key);
    return "";
  });
  if (unresolved.length) {
    throw new Error(
      `Unbound placeholders in workflow SQL: ${[...new Set(unresolved)].join(", ")}.\n` +
        `Bind them in the lane adapter — an empty substitution silently returns no rows.`,
    );
  }
  return rendered;
}

/**
 * Substitute `:1`, `:2`, … positional binds with SQL literals.
 *
 * The `snowflake-execute-sql-query` component sends these as real bind
 * variables. The harness runs SQL through the `snow` CLI, which has no way
 * to pass them, so they are inlined as quoted literals instead. Every value
 * originates from an id the harness just read out of a ledger.
 */
export function bindPositional(sql, values) {
  return sql.replace(/:(\d+)\b/g, (whole, n) => {
    const v = values[Number(n) - 1];
    if (v === undefined) {
      throw new Error(`SQL references bind :${n} but only ${values.length} param(s) were supplied.`);
    }
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

/**
 * Pull the SQL out of a CUSTOM-CODE step.
 *
 * Not every prefetch is a `snowflake-execute-sql-query` component. The
 * distillation cluster agent runs its queries from hand-written JS steps
 * (q_fetch_signals, q_fetch_neighbors) that embed SQL in a template literal
 * and bind with `?`. Reading the literal out of the source keeps those lanes
 * on production's query instead of a copy in this repo that would rot.
 *
 * @param {string} entryPath  Path to the step's entry.js.
 * @param {number} [index]    Which embedded SELECT to take, when a step has more than one.
 */
export function embeddedSql(entryPath, index = 0) {
  const src = readFileSync(entryPath, "utf8");
  const matches = [...src.matchAll(/`(\s*SELECT[\s\S]*?)`/g)].map((m) => m[1].trim());
  if (!matches.length) {
    throw new Error(`No embedded SELECT found in ${entryPath}; the step was probably refactored.`);
  }
  if (!matches[index]) {
    throw new Error(`${entryPath} has ${matches.length} embedded SELECT(s); index ${index} requested.`);
  }
  return matches[index];
}

/** Replace `?` placeholders with SQL literals, left to right. */
export function bindQuestionMarks(sql, values) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = values[i++];
    if (v === undefined) throw new Error(`SQL has more '?' placeholders than the ${values.length} value(s) supplied.`);
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

/** Bind and run one step's SQL, including its positional params. */
export function runStep(workflow, namespace, bindings = {}) {
  const s = step(workflow, namespace);
  const values = s.params.map((p) =>
    typeof p === "string" && p.includes("{{") ? bind(p, bindings) : p,
  );
  return query(bindPositional(bind(s.sql, bindings), values));
}

/**
 * Run several steps, returning `{ namespace: rows }`.
 * Skips steps whose SQL needs a binding this replay cannot supply, recording
 * why — some steps only matter to the live pipeline (cursor updates, claims)
 * and are not part of the model's input.
 */
export function runSteps(workflow, namespaces, bindings = {}) {
  const out = {};
  const skipped = {};
  for (const ns of namespaces) {
    try {
      out[ns] = runStep(workflow, ns, bindings);
    } catch (e) {
      skipped[ns] = e.message.split("\n")[0];
      out[ns] = [];
    }
  }
  return { rows: out, skipped };
}
