// Structural guard for the ADR-0004 candidate QUERY (CRMA-1335).
//
// The propose_trend_candidate schema and the STG_TREND_CANDIDATES insert are
// inlined in each Pipedream step, so a copy can silently lose the query field.
// Both happened in production: the shared cluster-agent schema had no `query`,
// and the revisit insert had no QUERY column. This test scans every deployed
// workflow step so a new copy cannot drift the same way.
// Run: bash scripts/test_agents_lib.sh
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
    else if (/^entry\.m?js$|^workflow\.yaml$|^tool_catalog\.mjs$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = walk(REPO_ROOT).map((p) => ({ path: relative(REPO_ROOT, p), text: readFileSync(p, "utf8") }));

// The text between `open` (an index just past an opening bracket) and its
// matching close bracket.
function balanced(text, open, [l, r]) {
  let depth = 1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === l) depth++;
    else if (text[i] === r && --depth === 0) return text.slice(open, i);
  }
  return text.slice(open);
}

// Split on commas that are not inside parentheses.
function topLevelSplit(s) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

function proposeSchemaBlocks(text) {
  return [...text.matchAll(/propose_trend_candidate:\s*\{/g)]
    .map((m) => balanced(text, m.index + m[0].length, "{}"));
}

// Each insert as { columns, selectList }. The select list is the outer
// SELECT's expressions, which Snowflake binds to the columns by position.
function candidateInserts(text) {
  const re = /INSERT INTO (?:MCC_RAW\.MARKETING_DEV\.)?STG_TREND_CANDIDATES\s*\(/g;
  const starts = [...text.matchAll(re)];
  return starts.map((m, k) => {
    const open = m.index + m[0].length;
    const columns = topLevelSplit(balanced(text, open, "()"));
    const stmtEnd = k + 1 < starts.length ? starts[k + 1].index : text.length;
    const stmt = text.slice(open, stmtEnd);
    // The outer FROM is the only `FROM cand` not followed by a comma (the CTEs
    // cross-join `FROM cand, LATERAL FLATTEN(...)`).
    const end = stmt.search(/\n\s*FROM cand\b(?!,)/);
    if (end === -1) return { columns, selectList: [] };
    const sel = [...stmt.slice(0, end).matchAll(/\n\s*SELECT\s*\n/g)].pop();
    return { columns, selectList: sel ? topLevelSplit(stmt.slice(sel.index + sel[0].length, end)) : [] };
  });
}

const schemaFiles = FILES.filter((f) => proposeSchemaBlocks(f.text).length > 0);
const insertFiles = FILES.filter((f) => candidateInserts(f.text).length > 0);

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
  test(`${f.path}: every STG_TREND_CANDIDATES insert writes cand.j:query into QUERY`, () => {
    for (const { columns, selectList } of candidateInserts(f.text)) {
      const i = columns.indexOf("QUERY");
      assert.ok(i >= 0, `insert columns omit QUERY: ${columns.join(", ")}`);
      assert.equal(selectList.length, columns.length, `select list has ${selectList.length} expressions for ${columns.length} columns`);
      assert.match(selectList[i], /cand\.j:query::STRING/, `QUERY is bound to: ${selectList[i]}`);
    }
  });
}
