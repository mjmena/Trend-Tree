// CRMA-1450: runtime text must reach Snowflake as a bind param (`:1` +
// `sql.params`), never pasted into a $$...$$ literal — a value containing
// "$$" ends the literal early and the statement fails.
// Run: node scripts/test_no_dollar_quoted_templates.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const files = readdirSync(root, { recursive: true })
  .filter((f) => f.endsWith("workflow.yaml") && !f.includes("node_modules"));
assert.ok(files.length > 10, "found no workflow.yaml files");

for (const f of files) {
  readFileSync(new URL(f, root), "utf8").split("\n").forEach((line, i) => {
    assert.doesNotMatch(line, /\$\$\s*\{\{/, `${f}:${i + 1} wraps a {{…}} template in $$…$$`);
  });
}
console.log(`ok ${files.length} workflow.yaml files`);
