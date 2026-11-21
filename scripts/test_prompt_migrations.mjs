// Every DIM_LLM_PROMPT deactivation in sql/ must be bounded by VERSION, or
// re-running the migration deactivates the version it just inserted and
// leaves the prompt key with no active row.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const DEACTIVATE = /UPDATE\s+[\w.]*DIM_LLM_PROMPT\s+SET\s+IS_ACTIVE\s*=\s*FALSE[^;]*;/gi;
const unbounded = (sql) => [...sql.matchAll(DEACTIVATE)].map((m) => m[0]).filter((s) => !/\bVERSION\b/i.test(s));

// Self-check: the regex sees the bug it guards against, across line breaks.
assert.equal(unbounded("UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE\nWHERE PROMPT_KEY = 'k' AND IS_ACTIVE = TRUE;").length, 1);
assert.equal(unbounded("UPDATE DIM_LLM_PROMPT SET IS_ACTIVE = FALSE\nWHERE PROMPT_KEY = 'k' AND IS_ACTIVE = TRUE AND VERSION < 4;").length, 0);

const dir = new URL("../sql/", import.meta.url);
const bad = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .flatMap((f) => unbounded(readFileSync(new URL(f, dir), "utf8")).map((s) => `${f}: ${s.replace(/\s+/g, " ")}`));
assert.deepEqual(bad, [], `unbounded DIM_LLM_PROMPT deactivations:\n${bad.join("\n")}`);
console.log("ok: every DIM_LLM_PROMPT deactivation in sql/ is VERSION-bounded");
