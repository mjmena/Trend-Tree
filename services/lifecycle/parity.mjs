// Renders each due trend's system prompt from the per-trend workflow.yaml queries
// and from SET_QUERIES at one instant; exits 1 on any char difference. Read-only.
//   cd services/lifecycle && npm ci && node parity.mjs [N=20]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect, execute, destroy } from "./snowflake.mjs";
import {
  SET_QUERIES, PROMPTS_SQL, groupByTrend, buildTrendContext, renderSystemPrompt,
} from "../lib/lifecycle_context.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const N = Number(process.argv[2] || 20);
const env = process.env;

// The `query: |-` block of one step in a Pipedream workflow.yaml.
function stepQuery(workflowDir, namespace) {
  const lines = readFileSync(join(ROOT, workflowDir, "workflow.yaml"), "utf8").split("\n");
  let i = lines.indexOf(`- namespace: ${namespace}`);
  if (i < 0) throw new Error(`${workflowDir}: no step ${namespace}`);
  while (lines[i] !== "      query: |-") i++;
  const out = [];
  for (i++; i < lines.length && (lines[i] === "" || lines[i].startsWith("        ")); i++) out.push(lines[i].slice(8));
  return out.join("\n").trim();
}

const TREND_VAR = "{{steps.handle_request.$return_value.trend_id}}";
const PER_TREND = {
  metrics: stepQuery("lifecycle-subagent-p_gYC562o", "q_metrics"),
  signal_domains: stepQuery("lifecycle-subagent-p_gYC562o", "q_signal_domains"),
  lifecycle_history: stepQuery("lifecycle-subagent-p_gYC562o", "q_lifecycle_history"),
  recent_signals: stepQuery("lifecycle-subagent-p_gYC562o", "q_recent_signals"),
  candidate_signals: stepQuery("lifecycle-subagent-p_gYC562o", "q_candidate_signals"),
  neighbors: stepQuery("lifecycle-subagent-p_gYC562o", "q_neighbors"),
};
const DUE_SQL = stepQuery("lifecycle-agent-p_JZCz73w", "q_select_due_trends")
  .replace("{{steps.normalize_event.$return_value.sweep_cap}}", String(N));

// Query name -> buildTrendContext input field, and the grouping key.
const FIELDS = {
  metrics: { field: "metrics_rows", key: "TREND_ID" },
  signal_domains: { field: "signal_domain_rows", key: "TREND_ID" },
  lifecycle_history: { field: "lifecycle_history_rows", key: "TREND_ID" },
  recent_signals: { field: "recent_signal_rows", key: "TREND_ID" },
  candidate_signals: { field: "candidate_signal_rows", key: "TREND_ID" },
  neighbors: { field: "neighbor_rows", key: "DUE_TREND_ID" },
};

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

const missing = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`parity: missing required env ${missing.join(", ")}`);
  process.exit(1);
}
// SNOWFLAKE_PRIVATE_KEY_PATH set -> key-pair; unset -> cached externalbrowser SSO.
const opts = {
  account: env.SNOWFLAKE_ACCOUNT,
  username: env.SNOWFLAKE_USER,
  role: env.SNOWFLAKE_ROLE || "MARKETING_ENGINEER",
};
if (env.SNOWFLAKE_WAREHOUSE) opts.warehouse = env.SNOWFLAKE_WAREHOUSE;
if (env.SNOWFLAKE_PRIVATE_KEY_PATH) {
  Object.assign(opts, { authenticator: "SNOWFLAKE_JWT", privateKeyPath: env.SNOWFLAKE_PRIVATE_KEY_PATH });
} else {
  Object.assign(opts, { authenticator: "EXTERNALBROWSER", clientStoreTemporaryCredential: true });
}

const conn = await connect(opts);
try {
  const ids = (await execute(conn, DUE_SQL)).map((r) => r.TREND_ID);
  console.log(`due trends: ${ids.length} (asked for ${N})`);
  const prompts = await execute(conn, PROMPTS_SQL);
  const now = Date.now();
  const t0 = Date.now();

  // Every query, both sides, fired together so they read the same minute.
  const names = Object.keys(SET_QUERIES);
  const setP = Promise.all(names.map((q) => execute(conn, SET_QUERIES[q], [JSON.stringify(ids)])));
  const perP = Promise.all(ids.map((id) =>
    Promise.all(names.map((q) => execute(conn, PER_TREND[q].replaceAll(TREND_VAR, id))))));
  const [setRows, perRows] = await Promise.all([setP, perP]);
  console.log(`queries: ${names.length} set-based + ${ids.length * names.length} per-trend in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const grouped = names.map((q, k) => groupByTrend(setRows[k], FIELDS[q].key));
  let failed = 0;
  ids.forEach((id, j) => {
    const perInput = { trend_id: id };
    const setInput = { trend_id: id };
    names.forEach((q, k) => {
      perInput[FIELDS[q].field] = perRows[j][k];
      setInput[FIELDS[q].field] = grouped[k].get(id) || [];
    });
    const a = renderSystemPrompt(prompts, buildTrendContext(perInput, now).blocks);
    const b = renderSystemPrompt(prompts, buildTrendContext(setInput, now).blocks);
    if (a === b) {
      console.log(`OK    ${id}  ${a.length} chars`);
    } else {
      failed++;
      const i = firstDiff(a, b);
      console.log(`DIFF  ${id}  at char ${i}\n  per-trend: ${JSON.stringify(a.slice(Math.max(0, i - 80), i + 120))}\n  set-based: ${JSON.stringify(b.slice(Math.max(0, i - 80), i + 120))}`);
    }
  });
  console.log(`${ids.length - failed}/${ids.length} prompts identical`);
  process.exitCode = failed || ids.length < N ? 1 : 0;
} finally {
  await destroy(conn);
}
