// Unit tests for the schema-coverage measurement.
//
// These guard the path logic specifically. A path-shape bug here does not
// crash — it silently reports declared fields as "undeclared survived",
// which would have been read as evidence about hazard H8. That is exactly
// the kind of quiet wrongness a lane decision must not rest on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { schemaPaths, coverage, compareCoverage } from "./fieldcheck.mjs";

const SCHEMA = {
  type: "object",
  required: ["name", "items"],
  properties: {
    name: { type: "string" },
    score: { type: "number" },
    nested: {
      type: "object",
      required: ["inner"],
      properties: { inner: { type: "string" }, other: { type: "string" } },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, weight: { type: "number" } },
      },
    },
    tags: { type: "array", items: { type: "string" } },
  },
};

test("schemaPaths flattens objects, arrays, and array-of-object items", () => {
  const paths = schemaPaths(SCHEMA).map((p) => p.path);
  assert.ok(paths.includes("name"));
  assert.ok(paths.includes("nested.inner"));
  assert.ok(paths.includes("items[]"));
  assert.ok(paths.includes("items[].label"));
  assert.ok(paths.includes("tags[]"));
  // An array of scalars must not sprout child paths.
  assert.ok(!paths.some((p) => p.startsWith("tags[].")));
});

test("required is only inherited through required parents", () => {
  const byPath = Object.fromEntries(schemaPaths(SCHEMA).map((p) => [p.path, p]));
  assert.equal(byPath["name"].required, true);
  assert.equal(byPath["score"].required, false);
  // nested itself is not required, so its required child is not either.
  assert.equal(byPath["nested.inner"].required, false);
});

test("coverage counts populated leaves and flags missing required ones", () => {
  const cov = coverage(SCHEMA, {
    name: "a",
    nested: { inner: "x" },
    items: [{ label: "l1" }, { label: "l2" }],
  });
  assert.equal(cov.missing_required.includes("name"), false);
  assert.ok(cov.present_count > 0);
  const weight = cov.rows.find((r) => r.path === "items[].weight");
  assert.equal(weight.present, false, "absent array-item field must not read as present");
});

test("a declared array field is never reported as undeclared", () => {
  // Regression: payloadPaths used to emit items[][] against a declared
  // items[] and reported every array field as an undeclared survivor.
  const cov = coverage(SCHEMA, {
    name: "a",
    items: [{ label: "l", weight: 2 }],
    tags: ["t"],
  });
  assert.deepEqual(cov.undeclared_survived, []);
});

test("undeclared fields the model invented ARE reported", () => {
  const cov = coverage(SCHEMA, { name: "a", items: [{ label: "l", surprise: 1 }], extra: true });
  assert.ok(cov.undeclared_survived.includes("extra"));
  assert.ok(cov.undeclared_survived.includes("items[].surprise"));
});

test("nulls are counted separately from absence", () => {
  const cov = coverage(SCHEMA, { name: null, score: 1 });
  const name = cov.rows.find((r) => r.path === "name");
  assert.equal(name.present, true, "a null-valued key is present but null");
  assert.equal(name.null_count, 1);
});

test("compareCoverage reports fields lost and gained", () => {
  const incumbent = { name: "a", score: 1, items: [{ label: "x" }] };
  const candidate = { name: "a", items: [{ label: "x", weight: 3 }] };
  const cmp = compareCoverage(SCHEMA, incumbent, candidate);
  assert.ok(cmp.fields_lost.includes("score"), "score was populated before and is not now");
  assert.ok(cmp.fields_gained.includes("items[].weight"));
});
