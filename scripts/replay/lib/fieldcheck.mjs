// Schema-coverage measurement — CRMA-727 hazard H8.
//
// The question: does a model silently drop declared schema fields, and do
// undeclared fields survive? No official source answers it for EITHER
// gemini-3.1-pro-preview or gemini-3.7-flash, so the only way to know is to
// measure. CRMA-722 is the precedent and its method is used here: judge the
// EMITTED PAYLOAD field by field, not the prose of the response.
//
// One correction to how the ticket framed this. The survey of all 18 call
// sites found that NO lane declares a `responseSchema` — the only structured
// output in the repo is daily-digest's responseMimeType. Every deep schema
// is a `functionDeclarations` parameter schema for a terminal emit tool
// (propose_enrichment, propose_decision, propose_lifecycle_decision,
// commit_attributions, propose_audit_report). So field-dropping is measured
// against TOOL-CALL ARGUMENTS, which is where the deep typing actually lives.

/**
 * Flatten a JSON Schema into leaf paths.
 * Arrays are represented once as `path[]`, and object-typed array items are
 * descended so a deeply-typed row shape is still measured.
 *
 * @returns {Array<{path: string, type: string, required: boolean}>}
 */
export function schemaPaths(schema, prefix = "", requiredParent = true) {
  const out = [];
  if (!schema || typeof schema !== "object") return out;

  if (schema.type === "object" || schema.properties) {
    const req = new Set(schema.required || []);
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      const isReq = requiredParent && req.has(key);
      if (sub?.type === "object" || sub?.properties) {
        out.push({ path, type: "object", required: isReq });
        out.push(...schemaPaths(sub, path, isReq));
      } else if (sub?.type === "array") {
        out.push({ path: `${path}[]`, type: `array<${sub.items?.type || "any"}>`, required: isReq });
        if (sub.items?.type === "object" || sub.items?.properties) {
          out.push(...schemaPaths(sub.items, `${path}[]`, false));
        }
      } else {
        out.push({ path, type: sub?.type || "any", required: isReq });
      }
    }
  }
  return out;
}

/** Read a value at a flattened path, descending through `[]` array hops. */
function readPath(obj, path) {
  const segments = path.split(".");
  let cursors = [obj];
  for (const raw of segments) {
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    const next = [];
    for (const c of cursors) {
      if (c == null || typeof c !== "object") continue;
      const v = c[key];
      if (v === undefined) continue;
      if (isArray) {
        if (Array.isArray(v)) next.push(...v);
        else next.push(v);
      } else {
        next.push(v);
      }
    }
    cursors = next;
    if (!cursors.length) return { found: false, values: [] };
  }
  return { found: true, values: cursors };
}

/** Collect every leaf path actually present in an emitted payload. */
function payloadPaths(obj, prefix = "", acc = new Set()) {
  if (obj == null || typeof obj !== "object") return acc;
  // The caller already appended `[]` when it descended into this array, so
  // items keep the parent's prefix. Appending again produced `path[][]` and
  // made every declared array field look undeclared.
  if (Array.isArray(obj)) {
    for (const item of obj) payloadPaths(item, prefix, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      acc.add(Array.isArray(v) ? `${path}[]` : path);
      payloadPaths(v, Array.isArray(v) ? `${path}[]` : path, acc);
    } else {
      acc.add(path);
    }
  }
  return acc;
}

/**
 * Measure one emission against its declared schema.
 *
 * @param {object} schema   JSON Schema of the terminal tool's parameters.
 * @param {object} emitted  The tool-call arguments the model produced.
 */
export function coverage(schema, emitted) {
  const declared = schemaPaths(schema);
  const rows = declared.map(({ path, type, required }) => {
    const { found, values } = readPath(emitted, path);
    const nonNull = values.filter((v) => v !== null && v !== undefined);
    const empty = nonNull.filter(
      (v) => v === "" || (Array.isArray(v) && v.length === 0),
    ).length;
    return {
      path,
      type,
      required,
      present: found && values.length > 0,
      null_count: values.length - nonNull.length,
      empty_count: empty,
      sample_count: values.length,
    };
  });

  const present = rows.filter((r) => r.present && r.null_count === 0);
  const missingRequired = rows.filter((r) => r.required && !r.present);
  const nulled = rows.filter((r) => r.present && r.null_count > 0);

  // Fields the model invented that the schema never declared. If these
  // survive, undeclared fields are NOT dropped — the H8 question.
  const declaredSet = new Set(declared.map((d) => d.path));
  const undeclared = [...payloadPaths(emitted || {})].filter((p) => !declaredSet.has(p));

  return {
    declared_count: declared.length,
    present_count: present.length,
    coverage_pct: declared.length ? Math.round((present.length / declared.length) * 1000) / 10 : 0,
    missing_required: missingRequired.map((r) => r.path),
    nulled: nulled.map((r) => ({ path: r.path, nulls: r.null_count })),
    undeclared_survived: undeclared,
    rows,
  };
}

/** Compare incumbent vs candidate coverage — the per-lane H8 verdict. */
export function compareCoverage(schema, incumbent, candidate) {
  const a = coverage(schema, incumbent);
  const b = coverage(schema, candidate);
  const lost = a.rows
    .filter((r) => r.present)
    .map((r) => r.path)
    .filter((p) => !b.rows.find((r) => r.path === p && r.present));
  const gained = b.rows
    .filter((r) => r.present)
    .map((r) => r.path)
    .filter((p) => !a.rows.find((r) => r.path === p && r.present));
  return {
    incumbent: a,
    candidate: b,
    fields_lost: lost,
    fields_gained: gained,
    coverage_delta_pct: Math.round((b.coverage_pct - a.coverage_pct) * 10) / 10,
  };
}
