// Structural guard for the ADR-0004 candidate QUERY (CRMA-1335).
//
// The propose_trend_candidate schema and the STG_TREND_CANDIDATES insert are
// inlined in each Pipedream step, so a copy can silently lose the query field.
// Both happened in production: the shared cluster-agent schema had no `query`,
// and the revisit insert had no QUERY column. This test scans every deployed
// workflow step so a new copy cannot drift the same way.
// Run: node --test agents/lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SKIP_DIRS = new Set([".git", ".claude", "node_modules", "docs", "sql", "test", "scripts", "services"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/^entry\.m?js$|^workflow\.yaml$/.test(name) || /^tool_catalog\.mjs$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = walk(REPO_ROOT).map((p) => ({ path: relative(REPO_ROOT, p), text: readFileSync(p, "utf8") }));

// The propose_trend_candidate schema block, up to the next sibling schema key
// or the end of the enclosing object.
function proposeSchemaBlocks(text) {
  const blocks = [];
  const re = /propose_trend_candidate:\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index + m[0].length);
    const end = rest.search(/\n {0,2}[a-z_]+:\s*\{|\n\};/);
    blocks.push(end === -1 ? rest : rest.slice(0, end));
  }
  return blocks;
}

function insertColumnLists(text) {
  const lists = [];
  const re = /INSERT INTO MCC_RAW\.MARKETING_DEV\.STG_TREND_CANDIDATES\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text))) lists.push(m[1]);
  return lists;
}

const schemaFiles = FILES.filter((f) => proposeSchemaBlocks(f.text).length > 0);
const insertFiles = FILES.filter((f) => insertColumnLists(f.text).length > 0);

test("the scan finds the cluster-agent and the revisit candidate producers", () => {
  const schemaPaths = schemaFiles.map((f) => f.path);
  const insertPaths = insertFiles.map((f) => f.path);
  assert.ok(schemaPaths.includes("distillation-cluster-agent-p_YyC89Ke/run_lead_agent/entry.js"), schemaPaths.join(", "));
  assert.ok(insertPaths.includes("distillation-p_mkCBBqb/workflow.yaml"), insertPaths.join(", "));
  assert.ok(insertPaths.includes("distillation-revisit-p_o7CWWZl/commit_batch_result/entry.mjs"), insertPaths.join(", "));
});

for (const f of schemaFiles) {
  test(`${f.path}: propose_trend_candidate defines and requires query`, () => {
    for (const block of proposeSchemaBlocks(f.text)) {
      assert.match(block, /\bquery:\s*\{/, "schema has no `query` property");
      const required = [...block.matchAll(/required:\s*\[([^\]]*)\]/g)].pop();
      assert.ok(required, "schema has no required list");
      assert.match(required[1], /"query"/, `query is not required: [${required[1]}]`);
    }
  });
}

for (const f of insertFiles) {
  test(`${f.path}: every STG_TREND_CANDIDATES insert writes QUERY`, () => {
    for (const cols of insertColumnLists(f.text)) {
      assert.match(cols, /\bQUERY\b/, `insert columns omit QUERY: ${cols.replace(/\s+/g, " ")}`);
    }
    assert.match(f.text, /cand\.j:query::STRING/, "insert never selects cand.j:query");
  });
}
